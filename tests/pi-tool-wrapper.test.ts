import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { type RepoMapController, registerRepoContext } from "../src/extension.js";
import type { RepoMapRuntimeQuery } from "../src/repo-map/runtime.js";
import type { RepoContextConfig } from "../src/state/config.js";

const scratchRoots: string[] = [];
let toolCallSequence = 0;

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const baseConfig: RepoContextConfig = {
  enabled: true,
  legacyContextVaultRepoMap: false,
  searchMaxBytes: 6144,
  debounceMs: 300,
  generationRetention: 3,
  quotaBytes: 128 * 1024 * 1024,
  excludePatterns: [],
};

const freshQuery: RepoMapRuntimeQuery = {
  results: [],
  freshness: "fresh",
  generation: 1,
  gitHead: "abc123",
  workspaceRevision: "revision",
  pendingFiles: [],
  fallbackEvidence: [],
};

function controller(query: RepoMapController["query"]): RepoMapController {
  return {
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    rebuild: vi.fn(async () => undefined),
    query,
    status: vi.fn(() => ({
      freshness: "fresh" as const,
      generation: 1,
      gitHead: "abc123",
      workspaceRevision: "revision",
      pendingFiles: [],
      dirtyFiles: [],
    })),
  };
}

async function createPinnedPiSession(config: RepoContextConfig, repoMap: RepoMapController) {
  const root = await mkdtemp(join(tmpdir(), "repo-context-pi-wrapper-"));
  scratchRoots.push(root);
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      {
        name: "unrelated-tool-fixture",
        factory(pi: ExtensionAPI) {
          pi.registerTool({
            name: "other_extension_tool",
            label: "Other Extension Tool",
            description: "Unrelated active tool used to detect active-set clobbering.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            async execute() {
              return { content: [{ type: "text", text: "other" }], details: {} };
            },
          });
        },
      },
      {
        name: "repo-context-test-fixture",
        factory(pi: ExtensionAPI) {
          registerRepoContext(pi, {
            resolveProjectState: async () => ({
              projectId: "fixture",
              projectRoot: root,
              stateRoot: join(agentDir, "pi-repo-context", "projects", "fixture"),
              mapRoot: join(agentDir, "pi-repo-context", "projects", "fixture", "repo-map"),
            }),
            loadConfig: async () => config,
            runtimeFactory: () => repoMap,
          });
        },
      },
    ],
  });
  await resourceLoader.reload();
  const created = await createAgentSession({
    cwd: root,
    agentDir,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    noTools: "builtin",
  });
  await created.session.bindExtensions({ mode: "print" });
  return created.session;
}

function fakeAssistantResponse(message: object) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: message };
      yield { type: "done", reason: "stop", message };
    },
    async result() {
      return message;
    },
  };
}

async function runWrappedTool(
  session: Awaited<ReturnType<typeof createPinnedPiSession>>,
  toolName: string,
  args: Record<string, unknown>,
) {
  toolCallSequence += 1;
  const toolCallId = `call-${toolName}-${toolCallSequence}`;
  let streamCall = 0;
  session.agent.streamFunction = (async (model: Parameters<typeof session.agent.streamFunction>[0]) => {
    streamCall += 1;
    const message = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: streamCall === 1 ? "toolUse" : "stop",
      timestamp: Date.now(),
      content:
        streamCall === 1
          ? [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }]
          : [{ type: "text", text: "done" }],
    };
    return fakeAssistantResponse(message);
  }) as unknown as typeof session.agent.streamFunction;

  let completed:
    | { result: { content: Array<{ type: string; text?: string }>; details?: unknown }; isError: boolean }
    | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolCallId === toolCallId) completed = event;
  });
  try {
    // Agent.prompt is the public pinned-Pi execution path. It bypasses only the
    // AgentSession API-key guard so the deterministic local stream can drive a tool call.
    await session.agent.prompt(`invoke ${toolName}`);
  } finally {
    unsubscribe();
  }
  if (!completed) throw new Error(`Pinned Pi did not complete ${toolName}`);
  return completed;
}

it("exposes deterministic active/all surfaces and canonical prompt metadata through pinned Pi", async () => {
  const session = await createPinnedPiSession(
    baseConfig,
    controller(async () => freshQuery),
  );
  try {
    expect(
      session
        .getAllTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([
      "bash",
      "context_vault_repo_map",
      "edit",
      "find",
      "grep",
      "ls",
      "other_extension_tool",
      "read",
      "repo_context_search",
      "repo_context_status",
      "write",
    ]);
    expect(session.getActiveToolNames()).toEqual([
      "other_extension_tool",
      "repo_context_search",
      "repo_context_status",
    ]);
    expect(session.state.systemPrompt).toContain(
      "repo_context_search: Search the live repository index with explicit freshness evidence",
    );
    expect(session.state.systemPrompt).toContain(
      "Use repo_context_search to find relevant repository files and symbols before broad filesystem searches.",
    );
    expect(session.state.systemPrompt).not.toContain("context_vault_repo_map");
  } finally {
    session.dispose();
  }
});

it("lets pinned Pi mark hard errors and fulfilled degraded evidence for canonical and enabled alias tools", async () => {
  let rejectQueries = true;
  const privateFailure = "/home/private/repo-index.json";
  const degraded: RepoMapRuntimeQuery = {
    ...freshQuery,
    freshness: "stale",
    fallbackEvidence: [{ kind: "source", path: "src/fallback.ts", excerpt: "fallback evidence" }],
    error: privateFailure,
  };
  const session = await createPinnedPiSession(
    { ...baseConfig, legacyContextVaultRepoMap: true },
    controller(async () => {
      if (rejectQueries) throw new Error(privateFailure);
      return degraded;
    }),
  );
  try {
    expect(session.getActiveToolNames()).toContain("context_vault_repo_map");
    for (const toolName of ["repo_context_search", "context_vault_repo_map"]) {
      const hardFailure = await runWrappedTool(session, toolName, { query: "needle" });
      expect(hardFailure.isError).toBe(true);
      expect(hardFailure.result.content).toEqual([{ type: "text", text: "Repository search failed." }]);
      expect(JSON.stringify(hardFailure)).not.toContain("private");
    }

    rejectQueries = false;
    for (const toolName of ["repo_context_search", "context_vault_repo_map"]) {
      const degradedSuccess = await runWrappedTool(session, toolName, { query: "needle" });
      expect(degradedSuccess.isError).toBe(false);
      expect(degradedSuccess.result.details).toMatchObject({
        freshness: "stale",
        error: "Repository search returned degraded results.",
        fallbackEvidence: [{ kind: "source", path: "src/fallback.ts" }],
      });
      expect(JSON.stringify(degradedSuccess)).not.toContain("private");
    }
  } finally {
    session.dispose();
  }
});
