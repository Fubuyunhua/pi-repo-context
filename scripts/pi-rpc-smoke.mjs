import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
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

class RpcClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.records = [];
    this.pending = new Map();
    this.failure = undefined;
    this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consume(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr = bounded(this.stderr + chunk);
    });
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      if (this.pending.size > 0) this.fail(new Error(`Pi exited before RPC response (code=${code}, signal=${signal})`));
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    for (;;) {
      const boundary = this.buffer.indexOf("\n");
      if (boundary < 0) break;
      let line = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      try {
        const record = JSON.parse(line);
        this.records.push(record);
        if (record.type === "response" && typeof record.id === "string") {
          const waiter = this.pending.get(record.id);
          if (waiter) {
            this.pending.delete(record.id);
            clearTimeout(waiter.timer);
            waiter.resolve(record);
          }
        }
      } catch (error) {
        this.fail(new Error(`Invalid Pi RPC JSONL record: ${bounded(line, 1024)} (${error})`));
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

  request(type, fields = {}) {
    if (this.failure) return Promise.reject(this.failure);
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
}

function expectSuccess(response, command) {
  if (response.type !== "response" || response.command !== command || response.success !== true) {
    throw new Error(`Unexpected ${command} response: ${bounded(JSON.stringify(response), 2048)}`);
  }
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error("Pi RPC process did not terminate promptly after stdin EOF")),
      EXIT_TIMEOUT_MS,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

function notificationsSince(records, offset) {
  return records.slice(offset).filter((record) => record.type === "extension_ui_request" && record.method === "notify");
}

let child;
try {
  if (!npmCli) throw new Error("Pi RPC smoke must run through npm");
  const globalModules = run(process.execPath, [npmCli, "root", "--global"]).trim();
  const globalPiRoot = join(globalModules, "@earendil-works", "pi-coding-agent");
  const globalPiManifest = JSON.parse(readFileSync(join(globalPiRoot, "package.json"), "utf8"));
  const globalPiCli = join(globalPiRoot, globalPiManifest.bin?.pi ?? "dist/cli.js");
  if (globalPiManifest.version !== "0.84.1" || !existsSync(globalPiCli)) {
    throw new Error(`Expected installed global Pi 0.84.1, received ${bounded(globalPiManifest.version, 128)}`);
  }
  const version = run(process.execPath, [globalPiCli, "--version"]).trim();
  if (version !== "0.84.1") throw new Error(`Expected global Pi CLI 0.84.1, received ${bounded(version, 128)}`);

  const packageScratch = join(scratch, "package");
  const install = join(scratch, "install");
  const fixture = join(scratch, "fixture");
  const agentRoot = join(scratch, "agent");
  const homeRoot = join(scratch, "home");
  for (const path of [packageScratch, install, fixture, agentRoot, homeRoot]) mkdirSync(path, { recursive: true });
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
  if (existsSync(join(install, "node_modules", "pi-context-vault"))) {
    throw new Error("Pi RPC smoke unexpectedly installed pi-context-vault");
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

  const extensionPath = join(install, "node_modules", "pi-repo-context", "extensions", "index.ts");
  const childEnv = safePiEnvironment(agentRoot, homeRoot);
  child = spawn(
    process.execPath,
    [
      globalPiCli,
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
    { cwd: fixture, env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
  );
  const rpc = new RpcClient(child);

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

  for (const subcommand of ["status", "rebuild", "doctor"]) {
    const offset = rpc.records.length;
    const response = await rpc.request("prompt", { message: `/repo-context ${subcommand}` });
    expectSuccess(response, "prompt");
    const notifications = notificationsSince(rpc.records, offset);
    if (notifications.length === 0) throw new Error(`/repo-context ${subcommand} emitted no Pi notification`);
    const serialized = JSON.stringify(notifications);
    if (subcommand !== "rebuild" && !serialized.includes("repo-context")) {
      throw new Error(`/repo-context ${subcommand} notification lacks Repo Context identity`);
    }
  }
  if (rpc.records.some((record) => record.type === "extension_error"))
    throw new Error("Pi emitted extension_error during commands");

  const projectRoot = realpathSync(fixture);
  const projectId = createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);
  const mapRoot = join(agentRoot, "pi-repo-context", "projects", projectId, "repo-map");
  const activePath = join(mapRoot, "active.json");
  if (!existsSync(activePath)) throw new Error("Pi Repo Context did not create its new-root active generation");
  const active = JSON.parse(readFileSync(activePath, "utf8"));
  const generations = readdirSync(join(mapRoot, "generations")).filter((name) => name.endsWith(".json"));
  if (!Number.isSafeInteger(active.generation) || generations.length === 0) {
    throw new Error("Pi Repo Context new-root generation is incomplete");
  }
  if (existsSync(join(agentRoot, "context-vault")))
    throw new Error("Pi Repo Context accessed the legacy Context Vault root");

  child.stdin.end();
  const exit = await waitForExit(child);
  if (exit.code !== 0 || exit.signal !== null) {
    throw new Error(`Pi RPC process exited unexpectedly (code=${exit.code}, signal=${exit.signal})`);
  }
  child = undefined;

  // RPC v0.84.1 exposes slash commands but not registered Tool definitions. Exact Tool registration is
  // independently checked by scripts/package-smoke.mjs against the same packed extension entrypoint.
  console.log("pi-rpc-startup-commands-state-shutdown-ok");
  console.log("rpc-tool-list-not-exposed-package-smoke-covers-tools");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
}
