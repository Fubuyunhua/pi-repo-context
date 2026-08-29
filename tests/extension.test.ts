import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import repoContextExtension from "../extensions/index.js";
import {
  boundSearchPayload,
  isOutsideRelativePath,
  type RepoMapController,
  registerRepoContext,
} from "../src/extension.js";
import type { RepoMapRuntimeQuery } from "../src/repo-map/runtime.js";
import type { RepoContextConfig } from "../src/state/config.js";
import type { RepoContextProjectState } from "../src/state/project-state.js";

interface CapturedTool {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}
interface CapturedCommand {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function harness() {
  const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, CapturedTool>();
  const commands = new Map<string, CapturedCommand>();
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      const rows = events.get(name) ?? [];
      rows.push(handler);
      events.set(name, rows);
    },
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: CapturedCommand) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  return { pi, events, tools, commands };
}

const projectState: RepoContextProjectState = {
  projectId: "abc",
  projectRoot: "/project",
  stateRoot: "/state/pi-repo-context/projects/abc",
  mapRoot: "/state/pi-repo-context/projects/abc/repo-map",
};
const config: RepoContextConfig = {
  enabled: true,
  searchMaxBytes: 6144,
  debounceMs: 300,
  generationRetention: 3,
  quotaBytes: 128 * 1024 * 1024,
  excludePatterns: [],
};
const queryResult: RepoMapRuntimeQuery = {
  results: [],
  freshness: "fresh",
  generation: 1,
  gitHead: "abc123",
  workspaceRevision: "revision",
  pendingFiles: [],
  fallbackEvidence: [],
};

function fakeController(overrides: Partial<RepoMapController> = {}): RepoMapController {
  return {
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    rebuild: vi.fn(async () => undefined),
    query: vi.fn(async () => queryResult),
    status: vi.fn(() => ({
      freshness: "fresh" as const,
      generation: 1,
      gitHead: "abc123",
      workspaceRevision: "revision",
      pendingFiles: [],
      dirtyFiles: [],
    })),
    ...overrides,
  };
}

const headlessContext = { cwd: "/project", hasUI: false, ui: { setStatus: vi.fn(), notify: vi.fn() } };

it("eagerly registers only the approved tools, command, and lifecycle hooks", () => {
  const target = harness();
  repoContextExtension(target.pi);
  expect([...target.events.keys()]).toEqual(["session_start", "session_shutdown"]);
  expect([...target.tools.keys()].sort()).toEqual([
    "context_vault_repo_map",
    "repo_context_search",
    "repo_context_status",
  ]);
  expect([...target.commands.keys()]).toEqual(["repo-context"]);
});

it("keeps status usable before initialization and when disabled without constructing runtime", async () => {
  const target = harness();
  const factory = vi.fn();
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => ({ ...config, enabled: false }),
    runtimeFactory: factory,
  });
  const statusTool = target.tools.get("repo_context_status");
  const before = (await statusTool?.execute()) as { details: { initialized: boolean; enabled: boolean | null } };
  expect(before.details).toMatchObject({ initialized: false, enabled: null });
  const preInitSearch = (await target.tools.get("repo_context_search")?.execute("id", { query: "x" })) as {
    details: { freshness: string; generation: number };
    isError: boolean;
  };
  expect(preInitSearch).toMatchObject({ isError: true, details: { freshness: "unsupported", generation: 0 } });
  await target.events.get("session_start")?.[0]({}, headlessContext);
  const after = (await statusTool?.execute()) as {
    details: { initialized: boolean; enabled: boolean; degraded: boolean };
  };
  expect(after.details).toMatchObject({ initialized: true, enabled: false, degraded: false });
  expect(factory).not.toHaveBeenCalled();
  const search = (await target.tools.get("repo_context_search")?.execute("id", { query: "x" })) as {
    details: { freshness: string; generation: number };
    isError: boolean;
  };
  expect(search).toMatchObject({ isError: true, details: { freshness: "unsupported", generation: 0 } });
});

it("uses live query for primary and alias with identical content and alias-only details", async () => {
  const target = harness();
  const controller = fakeController();
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: () => controller,
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);
  const primary = (await target.tools.get("repo_context_search")?.execute("id", { query: "needle", limit: 2 })) as {
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
  };
  const alias = (await target.tools.get("context_vault_repo_map")?.execute("id", { query: "needle", limit: 2 })) as {
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
  };
  expect(controller.query).toHaveBeenCalledTimes(2);
  expect(controller.query).toHaveBeenNthCalledWith(1, "needle", { limit: 2 });
  expect(alias.content).toEqual(primary.content);
  expect(primary.details).not.toHaveProperty("deprecated");
  expect(alias.details).toMatchObject({ deprecated: true, replacement: "repo_context_search" });
});

it("closes partial starts and keeps bounded degraded status available", async () => {
  const target = harness();
  const close = vi.fn(async () => undefined);
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: () => fakeController({ start: vi.fn(async () => Promise.reject(new Error("boom"))), close }),
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);
  expect(close).toHaveBeenCalledOnce();
  const status = (await target.tools.get("repo_context_status")?.execute()) as {
    details: { initialized: boolean; available: boolean; degraded: boolean; failures: Array<{ error: string }> };
  };
  expect(status.details).toMatchObject({ initialized: true, available: false, degraded: true });
  expect(status.details.failures[0].error).toBe("Repository map runtime failed.");
  const unavailable = (await target.tools.get("repo_context_search")?.execute("id", { query: "x" })) as {
    details: { freshness: string; generation: number };
    isError: boolean;
  };
  expect(unavailable).toMatchObject({ isError: true, details: { freshness: "unsupported", generation: 0 } });
});

it("bounds status arrays and supports headless status, rebuild, doctor, and usage", async () => {
  const target = harness();
  const output: string[] = [];
  const paths = Array.from({ length: 70 }, (_, index) => `src/${index.toString().padStart(2, "0")}.ts`);
  const controller = fakeController({
    status: vi.fn(() => ({
      freshness: "fresh" as const,
      generation: 1,
      gitHead: "abc",
      workspaceRevision: "revision",
      pendingFiles: paths,
      dirtyFiles: paths,
    })),
  });
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: () => controller,
    stdout: (text) => output.push(text),
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);
  const status = (await target.tools.get("repo_context_status")?.execute()) as {
    details: { components: { repoMap: { pendingFiles: string[]; omittedPendingFiles: number } } };
  };
  expect(status.details.components.repoMap.pendingFiles).toHaveLength(64);
  expect(status.details.components.repoMap.omittedPendingFiles).toBe(6);

  const command = target.commands.get("repo-context");
  await command?.handler("status", headlessContext);
  await command?.handler("rebuild", headlessContext);
  await command?.handler("doctor", headlessContext);
  await command?.handler("unknown", headlessContext);
  expect(controller.rebuild).toHaveBeenCalledOnce();
  expect(output.some((text) => text.includes('"automaticInjection": false'))).toBe(true);
  expect(output.at(-1)).toBe("Usage: /repo-context status|rebuild|doctor");
});

it("omits private paths from model-visible status and retains them in explicit local diagnostics", async () => {
  const target = harness();
  const output: string[] = [];
  const privateMarker = "private-home-marker";
  const privateState: RepoContextProjectState = {
    projectId: "private-project-id",
    projectRoot: `/home/${privateMarker}/project`,
    stateRoot: `/home/${privateMarker}/.pi/agent/pi-repo-context/projects/private-project-id`,
    mapRoot: `/home/${privateMarker}/.pi/agent/pi-repo-context/projects/private-project-id/repo-map`,
  };
  registerRepoContext(target.pi, {
    resolveProjectState: async () => privateState,
    loadConfig: async () => config,
    runtimeFactory: () => fakeController(),
    stdout: (text) => output.push(text),
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);

  const result = (await target.tools.get("repo_context_status")?.execute()) as {
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
  };
  expect(result.details).toMatchObject({
    initialized: true,
    available: true,
    degraded: false,
    components: { repoMap: { freshness: "fresh", generation: 1 } },
  });
  expect(result.details).not.toHaveProperty("project");
  expect(result.content[0]?.text).not.toContain(privateMarker);
  expect(JSON.stringify(result.details)).not.toContain(privateMarker);

  const command = target.commands.get("repo-context");
  await command?.handler("status", headlessContext);
  await command?.handler("doctor", headlessContext);
  const localStatus = JSON.parse(output[0] ?? "{}") as { project?: RepoContextProjectState };
  const doctor = JSON.parse(output[1] ?? "{}") as { repoContext?: { project?: RepoContextProjectState } };
  expect(localStatus.project).toEqual({
    id: privateState.projectId,
    root: privateState.projectRoot,
    stateRoot: privateState.stateRoot,
    mapRoot: privateState.mapRoot,
  });
  expect(doctor.repoContext?.project).toEqual(localStatus.project);
});

it("treats fresh rebuild maintenance errors as failures and retains prior rebuild failure", async () => {
  const target = harness();
  let maintenanceError = false;
  const rebuild = vi
    .fn<RepoMapController["rebuild"]>()
    .mockRejectedValueOnce(new Error("first rebuild failed"))
    .mockResolvedValue(undefined);
  const controller = fakeController({
    rebuild,
    status: vi.fn(() => ({
      freshness: "fresh" as const,
      generation: 2,
      gitHead: "abc",
      workspaceRevision: "revision",
      pendingFiles: [],
      dirtyFiles: [],
      ...(maintenanceError ? { maintenance: { error: "private maintenance path" } } : {}),
    })),
  });
  const ui = { setStatus: vi.fn(), notify: vi.fn() };
  const context = { cwd: "/project", hasUI: true, ui };
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: () => controller,
  });
  await target.events.get("session_start")?.[0]({}, context);
  const command = target.commands.get("repo-context");

  await command?.handler("rebuild", context);
  const firstStatus = JSON.parse(ui.notify.mock.calls.at(-1)?.[0] as string) as {
    degraded: boolean;
    failures: Array<{ component: string }>;
  };
  expect(ui.notify).toHaveBeenLastCalledWith(expect.any(String), "error");
  expect(firstStatus.degraded).toBe(true);
  expect(firstStatus.failures.filter((failure) => failure.component === "rebuild")).toHaveLength(1);

  maintenanceError = true;
  await command?.handler("rebuild", context);
  const secondStatus = JSON.parse(ui.notify.mock.calls.at(-1)?.[0] as string) as {
    degraded: boolean;
    failures: Array<{ component: string; error: string }>;
    components: { repoMap: { maintenance: { error: string } } };
  };
  expect(ui.notify).toHaveBeenLastCalledWith(expect.any(String), "error");
  expect(secondStatus.degraded).toBe(true);
  expect(secondStatus.failures.filter((failure) => failure.component === "rebuild")).toHaveLength(2);
  expect(secondStatus.failures.at(-1)?.error).toBe("Repository rebuild failed.");
  expect(secondStatus.components.repoMap.maintenance.error).toBe("Repository maintenance failed.");
});

it("adds alias migration details on unavailable errors and closes only its runtime/UI key", async () => {
  const target = harness();
  const close = vi.fn(async () => undefined);
  const ui = { setStatus: vi.fn(), notify: vi.fn() };
  const context = { cwd: "/project", hasUI: true, ui };
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: () => fakeController({ close }),
  });
  const unavailable = (await target.tools.get("context_vault_repo_map")?.execute("id", { query: "x" })) as {
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
    isError: boolean;
  };
  expect(unavailable.isError).toBe(true);
  expect(unavailable.details).toMatchObject({ deprecated: true, replacement: "repo_context_search" });

  await target.events.get("session_start")?.[0]({}, context);
  await target.events.get("session_shutdown")?.[0]({}, context);
  expect(close).toHaveBeenCalledOnce();
  expect(ui.setStatus).toHaveBeenLastCalledWith("repo-context", undefined);
  expect(ui.setStatus.mock.calls.some(([key]) => key !== "repo-context")).toBe(false);
});

it("keeps status generic and bounded after a malicious configuration failure", async () => {
  const target = harness();
  const malicious = `C:\\Users\\secret\\repo\\config.json\u0000${"x".repeat(1024 * 1024)}`;
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => Promise.reject(new Error(malicious)),
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);
  const status = (await target.tools.get("repo_context_status")?.execute()) as {
    content: Array<{ text: string }>;
    details: {
      initialized: boolean;
      available: boolean;
      degraded: boolean;
      failures: Array<{ component: string; error: string }>;
    };
  };
  expect(status.details).toMatchObject({ initialized: true, available: false, degraded: true });
  expect(status.details.failures[0]).toEqual({
    component: "initialization",
    error: "Repository context initialization failed.",
  });
  expect(status.content[0]?.text).not.toContain("Users");
  expect(status.content[0]?.text).not.toContain("secret");
  expect(Buffer.byteLength(status.content[0]?.text ?? "", "utf8")).toBeLessThan(4096);
});

it("publishes only fixed bounded errors and marks fresh runtime errors degraded", async () => {
  const target = harness();
  const malicious = `/home/private/repository/state.json\u0000${"z".repeat(1024 * 1024)}`;
  const query = vi.fn(async () => ({ ...queryResult, error: malicious }));
  const controller = fakeController({
    query,
    status: vi.fn(() => ({
      freshness: "fresh" as const,
      generation: 1,
      gitHead: "abc",
      workspaceRevision: "revision",
      pendingFiles: Array.from({ length: 100 }, (_, index) => `src/${index}.ts`),
      dirtyFiles: Array.from({ length: 100 }, (_, index) => `src/${index}.ts`),
      error: malicious,
      maintenance: { error: malicious },
    })),
  });
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: () => controller,
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);

  const search = (await target.tools.get("repo_context_search")?.execute("id", { query: "needle" })) as {
    content: Array<{ text: string }>;
    details: { error: string };
    isError: boolean;
  };
  expect(search.isError).toBe(true);
  expect(search.details.error).toBe("Repository search returned degraded results.");
  expect(search.content[0]?.text).not.toContain("private");
  expect(search.content[0]?.text).not.toContain("state.json");
  expect(Buffer.byteLength(search.content[0]?.text ?? "", "utf8")).toBeLessThanOrEqual(config.searchMaxBytes);

  const status = (await target.tools.get("repo_context_status")?.execute()) as {
    content: Array<{ text: string }>;
    details: {
      degraded: boolean;
      components: {
        repoMap: {
          error: string;
          maintenance: { error: string };
          pendingFiles: string[];
          dirtyFiles: string[];
          omittedPendingFiles: number;
          omittedDirtyFiles: number;
        };
      };
    };
  };
  expect(status.details.degraded).toBe(true);
  expect(status.details.components.repoMap).toMatchObject({
    error: "Repository map reported an error.",
    maintenance: { error: "Repository maintenance failed." },
    omittedPendingFiles: 36,
    omittedDirtyFiles: 36,
  });
  expect(status.details.components.repoMap.pendingFiles).toHaveLength(64);
  expect(status.details.components.repoMap.dirtyFiles).toHaveLength(64);
  expect(status.content[0]?.text).not.toContain("private");
  expect(status.content[0]?.text).not.toContain("state.json");
  expect(Buffer.byteLength(status.content[0]?.text ?? "", "utf8")).toBeLessThan(16 * 1024);

  query.mockRejectedValueOnce(new Error(malicious));
  const thrown = (await target.tools.get("repo_context_search")?.execute("id", { query: "needle" })) as {
    content: Array<{ text: string }>;
    details: { error: string };
  };
  expect(thrown.details.error).toBe("Repository search failed.");
  expect(thrown.content[0]?.text).not.toContain("private");

  query.mockRejectedValue(new Error(malicious));
  for (let index = 0; index < 25; index += 1) {
    await target.tools.get("repo_context_search")?.execute("id", { query: "needle" });
  }
  const boundedFailures = (await target.tools.get("repo_context_status")?.execute()) as {
    content: Array<{ text: string }>;
    details: { failures: Array<{ error: string }> };
  };
  expect(boundedFailures.details.failures).toHaveLength(20);
  expect(new Set(boundedFailures.details.failures.map((failure) => failure.error))).toEqual(
    new Set(["Repository search failed."]),
  );
  expect(boundedFailures.content[0]?.text).not.toContain("private");
  expect(Buffer.byteLength(boundedFailures.content[0]?.text ?? "", "utf8")).toBeLessThan(20 * 1024);
});

it("treats native absolute relative-path results as outside for Windows cross-drive safety", () => {
  expect(isOutsideRelativePath(resolve("/outside-state"))).toBe(true);
  expect(isOutsideRelativePath("..")).toBe(true);
  expect(isOutsideRelativePath(`..${process.platform === "win32" ? "\\\\" : "/"}state`)).toBe(true);
  expect(isOutsideRelativePath("state/repo-map")).toBe(false);
});

it("renders deterministic complete-row truncation within the 512-byte minimum", () => {
  const large: RepoMapRuntimeQuery = {
    ...queryResult,
    gitHead: "a".repeat(64),
    workspaceRevision: "b".repeat(64),
    pendingFiles: Array.from({ length: 10 }, (_, index) => `src/${index}.ts`),
    results: Array.from({ length: 10 }, (_, index) => ({
      path: `src/${index}.ts`,
      score: 1,
      kind: "semantic" as const,
      matchedSymbols: ["value"],
      symbols: [],
      dependencies: [],
    })),
    fallbackEvidence: [{ kind: "source", path: "src/0.ts", excerpt: "x".repeat(4096) }],
    error: "e".repeat(4096),
  };
  const first = boundSearchPayload("界".repeat(512), large, 512);
  const second = boundSearchPayload("界".repeat(512), large, 512);
  expect(first).toEqual(second);
  expect(Buffer.byteLength(first.text, "utf8")).toBeLessThanOrEqual(512);
  expect(JSON.parse(first.text)).toEqual(first.payload);
  expect(first.payload.truncatedFields).toEqual(
    expect.arrayContaining(["fallbackEvidence", "results", "pendingFiles", "query"]),
  );
});
