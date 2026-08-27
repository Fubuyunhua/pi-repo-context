import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pi-repo-context-rpc-"));
const npmCli = process.env.npm_execpath;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 15_000;

function bounded(value, maxBytes = MAX_DIAGNOSTIC_BYTES) {
  const bytes = Buffer.from(String(value), "utf8");
  return bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString("utf8");
}

function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function safePiEnvironment(agentRoot, homeRoot) {
  const allow = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "TEMP", "TMP", "TMPDIR"];
  const env = {};
  for (const key of allow) if (process.env[key] !== undefined) env[key] = process.env[key];
  return {
    ...env,
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    APPDATA: join(homeRoot, "AppData", "Roaming"),
    LOCALAPPDATA: join(homeRoot, "AppData", "Local"),
    PI_CODING_AGENT_DIR: agentRoot,
    PI_OFFLINE: "1",
    NO_COLOR: "1",
  };
}

function treeDigest(rootPath) {
  const digest = createHash("sha256");
  const visit = (path) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const info = lstatSync(child);
      digest.update(`${child.slice(rootPath.length)}\0${info.mode}\0${info.size}\0`);
      if (info.isDirectory()) visit(child);
      else digest.update(readFileSync(child));
    }
  };
  visit(rootPath);
  return digest.digest("hex");
}

function assertDependencyAbsent(tree, forbidden) {
  const visit = (node, ancestry) => {
    if (node?.name === forbidden) throw new Error(`Dependency tree contains ${forbidden} at ${ancestry}`);
    for (const [name, dependency] of Object.entries(node?.dependencies ?? {})) {
      const next = `${ancestry}>${name}`;
      if (name === forbidden) throw new Error(`Dependency tree contains ${forbidden} at ${next}`);
      visit(dependency, next);
    }
  };
  visit(tree, "root");
}

class StrictLfJsonlDecoder {
  constructor(onRecord) {
    this.onRecord = onRecord;
    this.buffer = "";
    this.finished = false;
  }

  consume(chunk) {
    if (this.finished) throw new Error("RPC decoder received data after stdout end");
    this.buffer += chunk;
    for (;;) {
      const boundary = this.buffer.indexOf("\n");
      if (boundary < 0) break;
      let line = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) throw new Error("Pi RPC emitted an empty JSONL record");
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid Pi RPC JSONL record: ${bounded(line, 1024)} (${error})`);
      }
      this.onRecord(record);
    }
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.buffer.length !== 0) {
      throw new Error(`Pi RPC stdout ended with an unterminated record: ${bounded(this.buffer, 1024)}`);
    }
  }
}

function assertThrows(action, expected) {
  try {
    action();
  } catch (error) {
    if (String(error).includes(expected)) return;
    throw new Error(`Expected failure containing ${expected}, received ${error}`);
  }
  throw new Error(`Expected failure containing ${expected}`);
}

function selfTestJsonlDecoder() {
  const records = [];
  const valid = new StrictLfJsonlDecoder((record) => records.push(record));
  valid.consume('{"ok":true}\r\n');
  valid.finish();
  if (records.length !== 1 || records[0]?.ok !== true) throw new Error("strict JSONL valid-record self-test failed");

  assertThrows(() => new StrictLfJsonlDecoder(() => undefined).consume("\n"), "empty JSONL record");
  assertThrows(() => new StrictLfJsonlDecoder(() => undefined).consume("{]\n"), "Invalid Pi RPC JSONL record");
  const truncated = new StrictLfJsonlDecoder(() => undefined);
  truncated.consume('{"incomplete":true}');
  assertThrows(() => truncated.finish(), "unterminated record");
}

class RpcClient {
  constructor(child) {
    this.child = child;
    this.records = [];
    this.pending = new Map();
    this.failure = undefined;
    this.stderr = "";
    this.stdoutEnded = false;
    this.decoder = new StrictLfJsonlDecoder((record) => this.accept(record));
    this.closePromise = new Promise((resolvePromise) => {
      child.once("close", (code, signal) => {
        if (!this.stdoutEnded) this.fail(new Error("Pi RPC process closed before stdout ended"));
        if (this.pending.size > 0)
          this.fail(new Error(`Pi closed before RPC response (code=${code}, signal=${signal})`));
        resolvePromise({ code, signal });
      });
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      try {
        this.decoder.consume(chunk);
      } catch (error) {
        this.fail(error);
      }
    });
    child.stdout.on("end", () => {
      this.stdoutEnded = true;
      try {
        this.decoder.finish();
      } catch (error) {
        this.fail(error);
      }
    });
    child.stdout.on("error", (error) => this.fail(new Error(`Pi RPC stdout failed: ${error}`)));
    child.stderr.on("data", (chunk) => {
      this.stderr = bounded(this.stderr + chunk);
    });
    child.stderr.on("error", (error) => this.fail(new Error(`Pi RPC stderr failed: ${error}`)));
    child.on("error", (error) => this.fail(error));
  }

  accept(record) {
    this.records.push(record);
    if (record.type === "response" && typeof record.id === "string") {
      const waiter = this.pending.get(record.id);
      if (waiter) {
        this.pending.delete(record.id);
        clearTimeout(waiter.timer);
        waiter.resolve(record);
      }
    }
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
    this.pending.clear();
  }

  assertHealthy() {
    if (this.failure) throw this.failure;
  }

  request(type, fields = {}) {
    this.assertHealthy();
    const id = `rpc-${this.records.length}-${this.pending.size}`;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Timed out waiting for Pi RPC ${type}; stderr=${bounded(this.stderr, 2048)}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, "utf8", (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          rejectPromise(error);
        }
      });
    });
  }

  async waitForClose() {
    return await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error("Pi RPC process did not terminate promptly")),
        EXIT_TIMEOUT_MS,
      );
      this.closePromise.then(
        (result) => {
          clearTimeout(timer);
          resolvePromise(result);
        },
        (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      );
    });
  }
}

function expectSuccess(response, command) {
  if (response.type !== "response" || response.command !== command || response.success !== true) {
    throw new Error(`Unexpected ${command} response: ${bounded(JSON.stringify(response), 2048)}`);
  }
}

function notificationsSince(records, offset) {
  return records.slice(offset).filter((record) => record.type === "extension_ui_request" && record.method === "notify");
}

function parseSingleSuccessfulNotification(records, offset, label) {
  const notifications = notificationsSince(records, offset);
  if (notifications.length !== 1)
    throw new Error(`${label} emitted ${notifications.length} notifications instead of exactly one`);
  const notification = notifications[0];
  if (notification.notifyType === "error") throw new Error(`${label} emitted an error notification`);
  if (notification.notifyType !== "info")
    throw new Error(`${label} did not emit the exact informational success notification`);
  try {
    return JSON.parse(notification.message);
  } catch (error) {
    throw new Error(`${label} notification is not JSON: ${error}`);
  }
}

function assertHealthyStatus(status, label) {
  if (
    status?.extension?.id !== "repo-context" ||
    status.initialized !== true ||
    status.enabled !== true ||
    status.available !== true ||
    status.degraded !== false
  ) {
    throw new Error(`${label} is not initialized, enabled, available, and healthy`);
  }
  const repoMap = status.components?.repoMap;
  if (
    repoMap?.available !== true ||
    !["fresh", "dirty"].includes(repoMap.freshness) ||
    !Number.isSafeInteger(repoMap.generation) ||
    repoMap.generation < 1 ||
    typeof repoMap.workspaceRevision !== "string" ||
    repoMap.workspaceRevision.length === 0 ||
    repoMap.error !== undefined ||
    repoMap.maintenance?.error !== undefined ||
    !Array.isArray(status.failures) ||
    status.failures.length !== 0
  ) {
    throw new Error(`${label} contains unavailable, incoherent, or error Repo Map status`);
  }
  return status;
}

async function runCommand(rpc, subcommand) {
  const offset = rpc.records.length;
  const response = await rpc.request("prompt", { message: `/repo-context ${subcommand}` });
  expectSuccess(response, "prompt");
  rpc.assertHealthy();
  return parseSingleSuccessfulNotification(rpc.records, offset, `/repo-context ${subcommand}`);
}

let child;
let rpc;
try {
  selfTestJsonlDecoder();
  if (!npmCli) throw new Error("Pi RPC smoke must run through npm");

  const packageScratch = join(scratch, "package");
  const install = join(scratch, "install");
  const fixture = join(scratch, "fixture");
  const physicalAgentRoot = join(scratch, "physical-agent");
  const agentRoot = join(scratch, "agent-link");
  const homeRoot = join(scratch, "home");
  for (const path of [packageScratch, install, fixture, physicalAgentRoot, homeRoot]) {
    mkdirSync(path, { recursive: true });
  }
  symlinkSync(physicalAgentRoot, agentRoot, process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(install, "package.json"), '{"name":"repo-context-rpc-smoke","private":true}\n');

  const packed = JSON.parse(run(process.execPath, [npmCli, "pack", "--json", "--pack-destination", packageScratch]))[0];
  run(
    process.execPath,
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      join(packageScratch, packed.filename),
      "@earendil-works/pi-coding-agent@0.84.1",
      "typebox@1.3.7",
    ],
    install,
  );
  const dependencyTree = JSON.parse(run(process.execPath, [npmCli, "ls", "--all", "--json"], install));
  assertDependencyAbsent(dependencyTree, "pi-context-vault");
  if (existsSync(join(install, "node_modules", "pi-context-vault"))) {
    throw new Error("Pi RPC smoke unexpectedly installed pi-context-vault");
  }
  const installedPiRoot = join(install, "node_modules", "@earendil-works", "pi-coding-agent");
  const installedPiManifest = JSON.parse(readFileSync(join(installedPiRoot, "package.json"), "utf8"));
  const installedPiCli = join(installedPiRoot, installedPiManifest.bin?.pi ?? "dist/cli.js");
  if (installedPiManifest.version !== "0.84.1" || !existsSync(installedPiCli)) {
    throw new Error(`Expected smoke-installed Pi 0.84.1, received ${bounded(installedPiManifest.version, 128)}`);
  }
  const installedPiVersion = run(process.execPath, [installedPiCli, "--version"], install).trim();
  if (installedPiVersion !== "0.84.1") {
    throw new Error(`Expected smoke-installed Pi CLI 0.84.1, received ${bounded(installedPiVersion, 128)}`);
  }

  mkdirSync(join(fixture, "src"), { recursive: true });
  writeFileSync(join(fixture, "src", "dep.ts"), "export const answer = 42;\n");
  writeFileSync(
    join(fixture, "src", "main.ts"),
    'import { answer } from "./dep.js";\nexport const result = answer + 1;\n',
  );
  mkdirSync(join(fixture, ".pi"), { recursive: true });
  writeFileSync(
    join(fixture, ".pi", "repo-context.json"),
    `${JSON.stringify({ enabled: true, debounceMs: 20, generationRetention: 2, quotaBytes: 8 * 1024 * 1024 }, null, 2)}\n`,
  );

  const projectRoot = realpathSync(fixture);
  const projectId = createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);
  const vaultRoot = join(physicalAgentRoot, "context-vault");
  const vaultArtifacts = join(vaultRoot, "artifacts");
  const vaultMetadata = join(vaultRoot, "metadata");
  const legacyMap = join(vaultRoot, "projects", projectId, "repo-map");
  for (const target of [vaultArtifacts, vaultMetadata, legacyMap]) {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "byte-seeded-vault-sentinel.bin"), Buffer.from([0, 255, 86, 65, 85, 76, 84, 10]));
  }
  const vaultBefore = treeDigest(vaultRoot);

  const extensionPath = join(install, "node_modules", "pi-repo-context", "extensions", "index.ts");
  child = spawn(
    process.execPath,
    [
      installedPiCli,
      "--mode",
      "rpc",
      "--offline",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-builtin-tools",
      "--approve",
      "--extension",
      extensionPath,
    ],
    { cwd: fixture, env: safePiEnvironment(agentRoot, homeRoot), stdio: ["pipe", "pipe", "pipe"] },
  );
  rpc = new RpcClient(child);

  const commandsResponse = await rpc.request("get_commands");
  expectSuccess(commandsResponse, "get_commands");
  const extensionCommands = (commandsResponse.data?.commands ?? []).filter((command) => command.source === "extension");
  const pluginCommands = extensionCommands.filter((command) => {
    const sourcePath = command.path ?? command.sourceInfo?.path;
    return command.name === "repo-context" || (typeof sourcePath === "string" && sourcePath === extensionPath);
  });
  if (pluginCommands.length !== 1 || pluginCommands[0]?.name !== "repo-context") {
    throw new Error(`Unexpected Repo Context commands: ${bounded(JSON.stringify(pluginCommands), 2048)}`);
  }
  if (rpc.records.some((record) => record.type === "extension_error"))
    throw new Error("Pi emitted extension_error during startup");
  if (
    !rpc.records.some(
      (record) =>
        record.type === "extension_ui_request" &&
        record.method === "setStatus" &&
        record.statusKey === "repo-context" &&
        typeof record.statusText === "string",
    )
  ) {
    throw new Error("Repo Context did not publish its Pi status during startup");
  }

  const initialStatus = assertHealthyStatus(await runCommand(rpc, "status"), "initial status");
  const rebuildStatus = assertHealthyStatus(await runCommand(rpc, "rebuild"), "rebuild success");
  const coherentStatus = assertHealthyStatus(await runCommand(rpc, "status"), "post-rebuild status");
  for (const field of ["generation", "workspaceRevision", "gitHead", "freshness"]) {
    if (coherentStatus.components.repoMap[field] !== rebuildStatus.components.repoMap[field]) {
      throw new Error(`Post-rebuild status changed coherent field ${field}`);
    }
  }
  if (rebuildStatus.components.repoMap.generation < initialStatus.components.repoMap.generation) {
    throw new Error("Rebuild generation regressed");
  }
  const doctor = await runCommand(rpc, "doctor");
  if (
    doctor?.status !== "healthy" ||
    doctor.automaticInjection !== false ||
    doctor.legacyStateAccess !== false ||
    JSON.stringify(doctor).includes('"error"')
  ) {
    throw new Error("Doctor did not report exact healthy no-error state");
  }
  assertHealthyStatus(doctor.repoContext, "doctor Repo Context status");

  const mapRoot = join(agentRoot, "pi-repo-context", "projects", projectId, "repo-map");
  const activePath = join(mapRoot, "active.json");
  if (!existsSync(activePath)) throw new Error("Pi Repo Context did not create its new-root active generation");
  const active = JSON.parse(readFileSync(activePath, "utf8"));
  const generations = readdirSync(join(mapRoot, "generations")).filter((name) => name.endsWith(".json"));
  if (!Number.isSafeInteger(active.generation) || generations.length === 0) {
    throw new Error("Pi Repo Context new-root generation is incomplete");
  }
  if (treeDigest(vaultRoot) !== vaultBefore) {
    throw new Error("Pi Repo Context mutated byte-seeded Context Vault artifacts, metadata, or legacy Repo Map state");
  }

  child.stdin.end();
  const exit = await rpc.waitForClose();
  rpc.assertHealthy();
  if (exit.code !== 0 || exit.signal !== null) {
    throw new Error(`Pi RPC process exited unexpectedly (code=${exit.code}, signal=${exit.signal})`);
  }
  if (rpc.records.some((record) => record.type === "extension_error")) {
    throw new Error("Pi emitted extension_error during startup, commands, or session shutdown");
  }
  child = undefined;
  rpc = undefined;

  // RPC v0.84.1 exposes slash commands but not registered Tool definitions. Exact Tool registration is
  // independently checked by scripts/package-smoke.mjs against the same packed extension entrypoint.
  console.log("pi-rpc-healthy-commands-state-framing-shutdown-ok");
  console.log("rpc-tool-list-not-exposed-package-smoke-covers-tools");
} finally {
  if (child) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (rpc) await rpc.waitForClose();
  }
  rmSync(scratch, { recursive: true, force: true });
}
