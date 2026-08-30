import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import repoContextExtension from "../extensions/index.js";
import {
  boundSearchPayload,
  isOutsideRelativePath,
  type RepoContextInitializationWaiter,
  type RepoMapController,
  registerRepoContext,
} from "../src/extension.js";
import type { LexicalFallbackScanResult } from "../src/repo-map/lexical-fallback.js";
import type { RepoMapRuntimeQuery } from "../src/repo-map/runtime.js";
import type { RepoContextConfig } from "../src/state/config.js";
import type { RepoContextProjectState } from "../src/state/project-state.js";

interface CapturedTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (...args: unknown[]) => Promise<unknown>;
}
interface CapturedCommand {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function harness(initialActiveTools: string[] = []) {
  const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, CapturedTool>();
  const commands = new Map<string, CapturedCommand>();
  let activeTools = [...initialActiveTools];
  const activeToolUpdates: string[][] = [];
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      const rows = events.get(name) ?? [];
      rows.push(handler);
      events.set(name, rows);
    },
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
      activeTools = [...new Set([...activeTools, tool.name])];
    },
    registerCommand(name: string, command: CapturedCommand) {
      commands.set(name, command);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
      activeToolUpdates.push([...names]);
    },
  } as unknown as ExtensionAPI;
  return { pi, events, tools, commands, activeToolUpdates, getActiveTools: () => [...activeTools] };
}

const projectState: RepoContextProjectState = {
  projectId: "abc",
  projectRoot: "/project",
  stateRoot: "/state/pi-repo-context/projects/abc",
  mapRoot: "/state/pi-repo-context/projects/abc/repo-map",
};
const config: RepoContextConfig = {
  enabled: true,
  legacyContextVaultRepoMap: false,
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

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve = () => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

it("registers the deterministic all-tool surface and canonical prompt metadata", () => {
  const target = harness();
  repoContextExtension(target.pi);
  expect([...target.events.keys()]).toEqual(["session_start", "session_shutdown"]);
  expect([...target.tools.keys()].sort()).toEqual([
    "context_vault_repo_map",
    "repo_context_search",
    "repo_context_status",
  ]);
  expect(target.tools.get("repo_context_search")).toMatchObject({
    promptSnippet: "Search the live repository index with explicit freshness evidence",
    promptGuidelines: [
      "Use repo_context_search to find relevant repository files and symbols before broad filesystem searches.",
    ],
  });
  expect(target.tools.get("context_vault_repo_map")).not.toHaveProperty("promptSnippet");
  expect([...target.commands.keys()]).toEqual(["repo-context"]);
});

it("keeps the alias registered but inactive by default without clobbering unrelated active tools", async () => {
  const target = harness(["read", "other_extension_tool"]);
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: () => fakeController(),
  });

  await target.events.get("session_start")?.[0]({}, headlessContext);
  expect([...target.tools.keys()].sort()).toEqual([
    "context_vault_repo_map",
    "repo_context_search",
    "repo_context_status",
  ]);
  expect(target.getActiveTools()).toEqual([
    "read",
    "other_extension_tool",
    "repo_context_search",
    "repo_context_status",
  ]);
  expect(
    target.activeToolUpdates.every((names) => names.includes("read") && names.includes("other_extension_tool")),
  ).toBe(true);
});

it("enables only the compatibility alias when strict legacy configuration opts in", async () => {
  const target = harness(["read", "other_extension_tool"]);
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => ({ ...config, legacyContextVaultRepoMap: true }),
    runtimeFactory: () => fakeController(),
  });

  await target.events.get("session_start")?.[0]({}, headlessContext);
  expect(target.getActiveTools()).toEqual([
    "read",
    "other_extension_tool",
    "repo_context_search",
    "repo_context_status",
    "context_vault_repo_map",
  ]);
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
  await expect(target.tools.get("repo_context_search")?.execute("id", { query: "x" })).rejects.toThrow(
    "Repository context is unavailable.",
  );
  await target.events.get("session_start")?.[0]({}, headlessContext);
  const after = (await statusTool?.execute()) as {
    details: { initialized: boolean; enabled: boolean; degraded: boolean };
  };
  expect(after.details).toMatchObject({ initialized: true, enabled: false, degraded: false });
  expect(factory).not.toHaveBeenCalled();
  await expect(target.tools.get("repo_context_search")?.execute("id", { query: "x" })).rejects.toThrow(
    "Repository context is disabled.",
  );
});

it("keeps enabled sessions dormant until first search", async () => {
  const target = harness();
  const controller = fakeController();
  const factory = vi.fn(() => controller);
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: factory,
  });

  await target.events.get("session_start")?.[0]({}, headlessContext);
  const status = (await target.tools.get("repo_context_status")?.execute()) as {
    details: { lifecycle: string; available: boolean; components: { repoMap: { lifecycle: string } } };
  };
  expect(status.details).toMatchObject({
    lifecycle: "dormant",
    available: false,
    components: { repoMap: { lifecycle: "dormant" } },
  });
  expect(factory).not.toHaveBeenCalled();
  expect(controller.start).not.toHaveBeenCalled();
  expect(controller.status).not.toHaveBeenCalled();
});

it("shares lazy initialization and returns deterministic warming evidence when the budget expires", async () => {
  const target = harness();
  const start = deferred();
  const controller = fakeController({ start: vi.fn(() => start.promise) });
  const factory = vi.fn(() => controller);
  const waiter = vi.fn<RepoContextInitializationWaiter>(async () => "timeout" as const);
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: factory,
    initializationWaiter: waiter,
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);

  const [first, second] = (await Promise.all([
    target.tools.get("repo_context_search")?.execute("one", { query: "one" }),
    target.tools.get("repo_context_search")?.execute("two", { query: "two" }),
  ])) as Array<{ details: Record<string, unknown> }>;
  expect(factory).toHaveBeenCalledOnce();
  expect(controller.start).toHaveBeenCalledOnce();
  expect(waiter).toHaveBeenCalledTimes(2);
  expect(waiter.mock.calls[0]?.[0]).toBe(waiter.mock.calls[1]?.[0]);
  expect(waiter.mock.calls[0]?.[1]).toBe(250);
  expect(first.details).toMatchObject({
    lifecycle: "warming",
    freshness: "stale",
    generation: 0,
    gitHead: "unavailable",
    workspaceRevision: "unavailable",
    fallbackEvidence: [{ kind: "warming" }],
  });
  expect(second.details).toMatchObject({ lifecycle: "warming" });
  expect(first).not.toHaveProperty("isError");
  const warmingStatus = (await target.tools.get("repo_context_status")?.execute()) as {
    details: { lifecycle: string; degraded: boolean; components: { repoMap: { lifecycle: string } } };
  };
  expect(warmingStatus.details).toMatchObject({
    lifecycle: "warming",
    degraded: true,
    components: { repoMap: { lifecycle: "warming" } },
  });
  expect(controller.status).not.toHaveBeenCalled();

  start.resolve();
  await start.promise;
  await Promise.resolve();
  const ready = (await target.tools.get("repo_context_search")?.execute("three", { query: "ready" })) as {
    details: { lifecycle: string };
  };
  expect(ready.details.lifecycle).toBe("ready");
  expect(controller.query).toHaveBeenCalledOnce();
});

it("hard-times out a warming scanner that ignores its signal and never settles", async () => {
  vi.useFakeTimers();
  try {
    const target = harness();
    const start = deferred();
    const controller = fakeController({ start: vi.fn(() => start.promise) });
    const lexicalFallbackScanner = vi.fn(() => new Promise<LexicalFallbackScanResult>(() => {}));
    registerRepoContext(target.pi, {
      resolveProjectState: async () => projectState,
      loadConfig: async () => config,
      runtimeFactory: () => controller,
      initializationWaiter: async () => "timeout",
      lexicalFallbackScanner,
    });
    await target.events.get("session_start")?.[0]({}, headlessContext);
    const search = target.tools.get("repo_context_search")?.execute("id", { query: "deadline" }) as Promise<{
      details: { results: unknown[] };
    }>;
    await Promise.resolve();
    await Promise.resolve();
    expect(lexicalFallbackScanner).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(search).resolves.toMatchObject({ details: { results: [] } });
    const status = (await target.tools.get("repo_context_status")?.execute()) as {
      details: { telemetry: Record<string, number> };
    };
    expect(status.details.telemetry).toMatchObject({
      lexicalFallbackAttemptCount: 1,
      lexicalFallbackTimeoutCount: 1,
      lexicalFallbackCancelledCount: 0,
    });
  } finally {
    vi.useRealTimers();
  }
});

it("promptly retires a never-settling warming scanner on caller cancellation", async () => {
  const target = harness();
  const start = deferred();
  const controller = fakeController({ start: vi.fn(() => start.promise) });
  let scanSignal: AbortSignal | undefined;
  const lexicalFallbackScanner = vi.fn(
    (options: { signal?: AbortSignal }) =>
      new Promise<LexicalFallbackScanResult>(() => {
        scanSignal = options.signal;
      }),
  );
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: () => controller,
    initializationWaiter: async () => "timeout",
    lexicalFallbackScanner,
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);
  const caller = new AbortController();
  const search = target.tools
    .get("repo_context_search")
    ?.execute("id", { query: "cancel" }, caller.signal) as Promise<unknown>;
  await vi.waitFor(() => expect(lexicalFallbackScanner).toHaveBeenCalledOnce());
  caller.abort();
  await expect(search).rejects.toMatchObject({ name: "AbortError" });
  expect(scanSignal?.aborted).toBe(true);
  const status = (await target.tools.get("repo_context_status")?.execute()) as {
    details: { telemetry: Record<string, number> };
  };
  expect(status.details.telemetry).toMatchObject({
    lexicalFallbackAttemptCount: 1,
    lexicalFallbackCancelledCount: 1,
    lexicalFallbackTimeoutCount: 0,
  });
});

it("returns relevant same-call lexical evidence after the existing warming grace", async () => {
  const target = harness();
  const start = deferred();
  const controller = fakeController({ start: vi.fn(() => start.promise) });
  const scan: LexicalFallbackScanResult = {
    results: [
      {
        path: "src/needle.ts",
        score: 260,
        kind: "lexical",
        matchedSymbols: [],
        matchReasons: ["direct lexical fallback: 1 query term"],
        symbols: [],
        dependencies: [],
      },
    ],
    fallbackEvidence: [{ kind: "source", path: "src/needle.ts", excerpt: "export const coldNeedle = true;" }],
    durationMs: 7,
    filesScanned: 2,
    bytesScanned: 128,
    enumeratedPaths: 2,
    enumerationBytes: 30,
    matchesReturned: 1,
    capped: false,
    timedOut: false,
    cancelled: false,
  };
  const lexicalFallbackScanner = vi.fn(async () => scan);
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: () => controller,
    initializationWaiter: async () => "timeout",
    lexicalFallbackScanner,
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);

  const result = (await target.tools.get("repo_context_search")?.execute("id", { query: "coldNeedle" })) as {
    details: Record<string, unknown>;
  };
  expect(result.details).toMatchObject({
    lifecycle: "warming",
    freshness: "stale",
    generation: 0,
    gitHead: "unavailable",
    workspaceRevision: "unavailable",
    results: [{ path: "src/needle.ts" }],
    fallbackEvidence: [{ kind: "source", path: "src/needle.ts", excerpt: expect.stringContaining("coldNeedle") }],
  });
  const status = (await target.tools.get("repo_context_status")?.execute()) as {
    details: { telemetry: Record<string, number> };
  };
  expect(status.details.telemetry).toMatchObject({
    searchAttemptCount: 1,
    lexicalFallbackAttemptCount: 1,
    lexicalFallbackUsedCount: 1,
    warmingEmptyReturnCount: 0,
    lexicalFallbackFilesScanned: 2,
    lexicalFallbackBytesScanned: 128,
    lexicalFallbackMatchesReturned: 1,
  });
  start.resolve();
});

it("discards malicious timed-out and cancelled warming evidence", async () => {
  for (const outcome of ["timedOut", "cancelled"] as const) {
    const target = harness();
    const start = deferred();
    const controller = fakeController({ start: vi.fn(() => start.promise) });
    const malicious: LexicalFallbackScanResult = {
      results: [
        {
          path: "private/late.ts",
          score: 999,
          kind: "lexical",
          matchedSymbols: [],
          matchReasons: ["must not publish"],
          symbols: [],
          dependencies: [],
        },
      ],
      fallbackEvidence: [{ kind: "source", path: "private/late.ts", excerpt: "privateLateWarmingEvidence" }],
      durationMs: 750,
      filesScanned: 1,
      bytesScanned: 64,
      enumeratedPaths: 1,
      enumerationBytes: 16,
      matchesReturned: 1,
      capped: true,
      timedOut: outcome === "timedOut",
      cancelled: outcome === "cancelled",
    };
    registerRepoContext(target.pi, {
      resolveProjectState: async () => projectState,
      loadConfig: async () => config,
      runtimeFactory: () => controller,
      initializationWaiter: async () => "timeout",
      lexicalFallbackScanner: async () => malicious,
    });
    await target.events.get("session_start")?.[0]({}, headlessContext);

    const result = (await target.tools.get("repo_context_search")?.execute("id", { query: outcome })) as {
      content: Array<{ text: string }>;
      details: { results: unknown[]; fallbackEvidence: Array<{ excerpt: string }> };
    };
    expect(result.details.results).toEqual([]);
    expect(result.details.fallbackEvidence).toEqual([
      { kind: "warming", excerpt: "No lexical match found within the bounded warming scan." },
    ]);
    expect(result.content[0]?.text).not.toContain("privateLateWarmingEvidence");
    const status = (await target.tools.get("repo_context_status")?.execute()) as {
      details: { telemetry: Record<string, number> };
    };
    expect(status.details.telemetry).toMatchObject({
      lexicalFallbackUsedCount: 0,
      lexicalFallbackNoMatchCount: 0,
      lexicalFallbackCappedCount: 0,
      lexicalFallbackTimeoutCount: outcome === "timedOut" ? 1 : 0,
      lexicalFallbackCancelledCount: outcome === "cancelled" ? 1 : 0,
      lexicalFallbackMatchesReturned: 0,
      warmingEmptyReturnCount: 1,
    });
    start.resolve();
  }
});

it("sanitizes lexical scanner failures, cleans up, and records one terminal outcome", async () => {
  const target = harness();
  const start = deferred();
  const controller = fakeController({ start: vi.fn(() => start.promise) });
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: () => controller,
    initializationWaiter: async () => "timeout",
    lexicalFallbackScanner: async () => {
      throw new Error("/private/project/.gitignore permission denied");
    },
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);

  const result = (await target.tools.get("repo_context_search")?.execute("id", { query: "needle" })) as {
    content: Array<{ text: string }>;
    details: { results: unknown[]; fallbackEvidence: Array<{ excerpt: string }> };
  };
  expect(result.details.results).toEqual([]);
  expect(result.details.fallbackEvidence[0]?.excerpt).toContain("No lexical match found");
  expect(result.content[0]?.text).not.toContain("/private/project");
  const status = (await target.tools.get("repo_context_status")?.execute()) as {
    details: { telemetry: Record<string, number> };
  };
  expect(status.details.telemetry).toMatchObject({
    lexicalFallbackAttemptCount: 1,
    lexicalFallbackNoMatchCount: 1,
    warmingEmptyReturnCount: 1,
  });
  start.resolve();
});

it("fails closed and records one terminal outcome for oversized successful warming output", async () => {
  const target = harness();
  const start = deferred();
  const controller = fakeController({ start: vi.fn(() => start.promise) });
  const row = {
    path: "src/oversized.ts",
    score: 1,
    kind: "lexical" as const,
    matchedSymbols: [],
    matchReasons: ["direct lexical fallback: 1 query term"],
    symbols: [],
    dependencies: [],
  };
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: () => controller,
    initializationWaiter: async () => "timeout",
    lexicalFallbackScanner: async () => ({
      results: new Array(21).fill(row),
      fallbackEvidence: [{ kind: "source", path: row.path, excerpt: "must-not-return" }],
      durationMs: 1,
      filesScanned: 1,
      bytesScanned: 1,
      enumeratedPaths: 1,
      enumerationBytes: 1,
      matchesReturned: 21,
      capped: false,
      timedOut: false,
      cancelled: false,
    }),
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);
  const result = (await target.tools.get("repo_context_search")?.execute("id", { query: "oversized" })) as {
    content: Array<{ text: string }>;
    details: { results: unknown[] };
  };
  expect(result.details.results).toEqual([]);
  expect(result.content[0]?.text).not.toContain("must-not-return");
  const status = (await target.tools.get("repo_context_status")?.execute()) as {
    details: { telemetry: Record<string, number> };
  };
  expect(status.details.telemetry).toMatchObject({
    lexicalFallbackAttemptCount: 1,
    lexicalFallbackCappedCount: 1,
    lexicalFallbackUsedCount: 0,
    lexicalFallbackNoMatchCount: 0,
  });
  start.resolve();
});

it("discards an aborted fallback when initialization wins and keeps startup failure hard", async () => {
  for (const failure of [false, true]) {
    const target = harness();
    const start = deferred();
    const controller = fakeController({ start: vi.fn(() => start.promise) });
    let scanSignal: AbortSignal | undefined;
    const lexicalFallbackScanner = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<LexicalFallbackScanResult>((resolveScan) => {
          scanSignal = signal;
          signal?.addEventListener("abort", () =>
            resolveScan({
              results: [],
              fallbackEvidence: [],
              durationMs: 1,
              filesScanned: 0,
              bytesScanned: 0,
              enumeratedPaths: 0,
              enumerationBytes: 0,
              matchesReturned: 0,
              capped: false,
              timedOut: false,
              cancelled: true,
            }),
          );
        }),
    );
    registerRepoContext(target.pi, {
      resolveProjectState: async () => projectState,
      loadConfig: async () => config,
      runtimeFactory: () => controller,
      initializationWaiter: async () => "timeout",
      lexicalFallbackScanner,
    });
    await target.events.get("session_start")?.[0]({}, headlessContext);
    const search = target.tools.get("repo_context_search")?.execute("id", { query: "race" }) as Promise<{
      details: { lifecycle: string };
    }>;
    await vi.waitFor(() => expect(lexicalFallbackScanner).toHaveBeenCalledOnce());
    if (failure) start.reject(new Error("private startup path"));
    else start.resolve();
    if (failure) await expect(search).rejects.toThrow("Repository context is unavailable.");
    else {
      await expect(search).resolves.toMatchObject({ details: { lifecycle: "ready" } });
      expect(controller.query).toHaveBeenCalledOnce();
    }
    expect(scanSignal?.aborted).toBe(true);
  }
});

it("aborts a warming scan on replacement and cannot return retired evidence", async () => {
  const target = harness();
  const start = deferred();
  const close = vi.fn(async () => undefined);
  const controller = fakeController({ start: vi.fn(() => start.promise), close });
  let signal: AbortSignal | undefined;
  const releaseScan = deferred();
  const lexicalFallbackScanner = vi.fn(async (options: { signal?: AbortSignal }) => {
    signal = options.signal;
    await releaseScan.promise;
    throw new Error("late ignored scanner rejection");
  });
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: () => controller,
    initializationWaiter: async () => "timeout",
    lexicalFallbackScanner,
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);
  const search = target.tools.get("repo_context_search")?.execute("id", { query: "retired" }) as Promise<unknown>;
  await vi.waitFor(() => expect(lexicalFallbackScanner).toHaveBeenCalledOnce());

  const replacement = target.events.get("session_start")?.[0]({}, headlessContext) as Promise<void>;
  await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  await expect(search).rejects.toThrow("Repository context is unavailable.");
  // The replacement retires promptly even though the injected scanner ignores
  // AbortSignal. Its late rejection remains observed.
  releaseScan.resolve();
  start.resolve();
  await replacement;
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
});

it("serializes shutdown and session replacement behind initialization and closes once", async () => {
  const target = harness();
  const start = deferred();
  const close = vi.fn(async () => undefined);
  const controller = fakeController({ start: vi.fn(() => start.promise), close });
  const factory = vi.fn(() => controller);
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: factory,
    initializationWaiter: async () => "timeout",
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);
  await target.tools.get("repo_context_search")?.execute("id", { query: "warming" });

  const replacement = target.events.get("session_start")?.[0]({}, headlessContext) as Promise<void>;
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
  start.resolve();
  await replacement;
  expect(close).toHaveBeenCalledOnce();
  expect(factory).toHaveBeenCalledOnce();
  const status = (await target.tools.get("repo_context_status")?.execute()) as {
    details: { lifecycle: string; available: boolean };
  };
  expect(status.details).toMatchObject({ lifecycle: "dormant", available: false });

  await target.events.get("session_shutdown")?.[0]({}, headlessContext);
  expect(close).toHaveBeenCalledOnce();
});

it("retires an in-flight ready query before session replacement can return old evidence", async () => {
  const target = harness();
  let resolveQuery: (result: RepoMapRuntimeQuery) => void = () => {};
  const queryPromise = new Promise<RepoMapRuntimeQuery>((resolveResult) => {
    resolveQuery = resolveResult;
  });
  const close = vi.fn(async () => undefined);
  const controller = fakeController({ query: vi.fn(() => queryPromise), close });
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => config,
    runtimeFactory: () => controller,
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);

  const search = target.tools.get("repo_context_search")?.execute("id", { query: "old session" }) as Promise<unknown>;
  await vi.waitFor(() => expect(controller.query).toHaveBeenCalledOnce());
  const replacement = target.events.get("session_start")?.[0]({}, headlessContext) as Promise<void>;
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();

  resolveQuery(queryResult);
  await expect(search).rejects.toThrow("Repository context is unavailable.");
  await replacement;
  expect(close).toHaveBeenCalledOnce();
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

it("keeps fulfilled degraded evidence successful for canonical and enabled alias tools", async () => {
  const target = harness();
  const degraded: RepoMapRuntimeQuery = {
    ...queryResult,
    freshness: "stale",
    fallbackEvidence: [{ kind: "source", path: "src/fallback.ts", excerpt: "export const fallback = true;" }],
    error: "/private/runtime/detail",
  };
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => ({ ...config, legacyContextVaultRepoMap: true }),
    runtimeFactory: () => fakeController({ query: vi.fn(async () => degraded) }),
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);

  const primary = (await target.tools.get("repo_context_search")?.execute("id", { query: "fallback" })) as {
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
  };
  const alias = (await target.tools.get("context_vault_repo_map")?.execute("id", { query: "fallback" })) as {
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
  };
  expect(primary).not.toHaveProperty("isError");
  expect(alias).not.toHaveProperty("isError");
  expect(primary.details).toMatchObject({
    freshness: "stale",
    error: "Repository search returned degraded results.",
    fallbackEvidence: [{ kind: "source", path: "src/fallback.ts" }],
  });
  expect(alias.content).toEqual(primary.content);
  expect(alias.details).toMatchObject({
    ...primary.details,
    deprecated: true,
    replacement: "repo_context_search",
  });
  expect(JSON.stringify(alias)).not.toContain("private");
});

it("throws the same fixed error for canonical and enabled alias query rejection", async () => {
  const target = harness();
  const privateError = new Error("/home/private/repo-index.json");
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => ({ ...config, legacyContextVaultRepoMap: true }),
    runtimeFactory: () => fakeController({ query: vi.fn(async () => Promise.reject(privateError)) }),
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);

  for (const name of ["repo_context_search", "context_vault_repo_map"]) {
    await expect(target.tools.get(name)?.execute("id", { query: "needle" })).rejects.toEqual(
      new Error("Repository search failed."),
    );
  }
  const status = (await target.tools.get("repo_context_status")?.execute()) as {
    details: { failures: Array<{ component: string; error: string }> };
  };
  expect(status.details.failures).toEqual([
    { component: "query", error: "Repository search failed." },
    { component: "query", error: "Repository search failed." },
  ]);
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
  await expect(target.tools.get("repo_context_search")?.execute("id", { query: "x" })).rejects.toThrow(
    "Repository context is unavailable.",
  );
  expect(close).toHaveBeenCalledOnce();
  const status = (await target.tools.get("repo_context_status")?.execute()) as {
    details: { initialized: boolean; available: boolean; degraded: boolean; failures: Array<{ error: string }> };
  };
  expect(status.details).toMatchObject({ initialized: true, available: false, degraded: true });
  expect(status.details.failures[0].error).toBe("Repository map runtime failed.");
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
  await target.tools.get("repo_context_search")?.execute("id", { query: "initialize" });
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
  await target.tools.get("repo_context_search")?.execute("id", { query: "initialize" });

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
  type DiagnosticProject = { id: string; root: string; stateRoot: string; mapRoot: string };
  const localStatus = JSON.parse(output[0] ?? "{}") as { project?: DiagnosticProject };
  const doctor = JSON.parse(output[1] ?? "{}") as { repoContext?: { project?: DiagnosticProject } };
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
  await expect(target.tools.get("context_vault_repo_map")?.execute("id", { query: "x" })).rejects.toThrow(
    "Repository context is unavailable.",
  );

  await target.events.get("session_start")?.[0]({}, context);
  await target.events.get("session_shutdown")?.[0]({}, context);
  expect(close).not.toHaveBeenCalled();
  expect(ui.setStatus).toHaveBeenLastCalledWith("repo-context", undefined);
  expect(ui.setStatus.mock.calls.some(([key]) => key !== "repo-context")).toBe(false);
});

it("keeps status generic and the alias fail-closed after a malicious configuration failure", async () => {
  const target = harness(["read", "other_extension_tool"]);
  const malicious = `C:\\Users\\secret\\repo\\config.json\u0000${"x".repeat(1024 * 1024)}`;
  registerRepoContext(target.pi, {
    resolveProjectState: async () => projectState,
    loadConfig: async () => Promise.reject(new Error(malicious)),
  });
  await target.events.get("session_start")?.[0]({}, headlessContext);
  expect(target.getActiveTools()).toEqual([
    "read",
    "other_extension_tool",
    "repo_context_search",
    "repo_context_status",
  ]);
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
  };
  expect(search).not.toHaveProperty("isError");
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
  await expect(target.tools.get("repo_context_search")?.execute("id", { query: "needle" })).rejects.toThrow(
    "Repository search failed.",
  );

  query.mockRejectedValue(new Error(malicious));
  for (let index = 0; index < 25; index += 1) {
    await expect(target.tools.get("repo_context_search")?.execute("id", { query: "needle" })).rejects.toThrow(
      "Repository search failed.",
    );
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

it("preserves explicit warming fallback evidence at the 512-byte minimum", () => {
  const warming: RepoMapRuntimeQuery = {
    results: [],
    freshness: "stale",
    generation: 0,
    gitHead: "unavailable",
    workspaceRevision: "unavailable",
    pendingFiles: [],
    fallbackEvidence: [
      {
        kind: "warming",
        excerpt: "Repository index is warming; retry repository search or use direct filesystem search.",
      },
    ],
  };
  const bounded = boundSearchPayload("x".repeat(512), warming, 512, undefined, "warming");
  expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(512);
  expect(bounded.payload.fallbackEvidence).toEqual(warming.fallbackEvidence);
  expect(bounded.payload.truncatedFields).toContain("query");
});

it("keeps a compact useful warming result/evidence pair at 512 bytes when representable", () => {
  const warming: RepoMapRuntimeQuery = {
    results: [
      {
        path: "a.ts",
        score: 1,
        kind: "lexical",
        matchedSymbols: [],
        symbols: [],
        dependencies: [],
      },
    ],
    freshness: "stale",
    generation: 0,
    gitHead: "unavailable",
    workspaceRevision: "unavailable",
    pendingFiles: [],
    fallbackEvidence: [{ kind: "source", path: "a.ts", excerpt: "needle" }],
  };
  const bounded = boundSearchPayload("needle", warming, 512, undefined, "warming");
  expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(512);
  expect(bounded.payload.results).toHaveLength(1);
  expect(bounded.payload.fallbackEvidence).toEqual([{ kind: "source", path: "a.ts", excerpt: "needle" }]);
  expect(JSON.parse(bounded.text)).toEqual(bounded.payload);
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
