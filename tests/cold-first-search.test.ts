import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { type RepoMapController, registerRepoContext } from "../src/extension.js";
import { RepoMapRuntime } from "../src/repo-map/runtime.js";
import type { RepoContextConfig } from "../src/state/config.js";
import type { RepoContextTelemetry } from "../src/telemetry.js";

const execFileAsync = promisify(execFile);

interface CapturedTool {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

function extensionHarness() {
  const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, CapturedTool>();
  let activeTools: string[] = [];
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
      activeTools = [...new Set([...activeTools, tool.name])];
    },
    registerCommand() {},
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
  } as unknown as ExtensionAPI;
  return { pi, events, tools };
}

const config: RepoContextConfig = {
  enabled: true,
  legacyContextVaultRepoMap: false,
  searchMaxBytes: 6144,
  debounceMs: 300,
  generationRetention: 3,
  quotaBytes: 128 * 1024 * 1024,
  excludePatterns: [],
};

it("returns indexed evidence on every first search in a six-run cold-start matrix", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "repo-context-cold-search-project-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "repo-context-cold-search-state-"));
  try {
    await mkdir(join(projectRoot, "src"));
    await writeFile(
      join(projectRoot, "src", "cold-search.ts"),
      "export function coldStartNeedle(): string { return 'ready'; }\n",
    );
    await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "user.email", "cold-search@example.invalid"], { cwd: projectRoot });
    await execFileAsync("git", ["config", "user.name", "Cold Search Test"], { cwd: projectRoot });
    await execFileAsync("git", ["add", "."], { cwd: projectRoot });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: projectRoot });

    let usefulFirstSearches = 0;
    for (let run = 0; run < 6; run += 1) {
      const target = extensionHarness();
      const factory = vi.fn(
        (input: { projectRoot: string; mapRoot: string; config: RepoContextConfig; telemetry: RepoContextTelemetry }) =>
          new RepoMapRuntime({
            projectRoot: input.projectRoot,
            stateRoot: input.mapRoot,
            exclude: input.config.excludePatterns,
            watch: false,
            telemetry: input.telemetry,
          }) as RepoMapController,
      );
      registerRepoContext(target.pi, {
        resolveProjectState: async () => ({
          projectId: `cold-${run}`,
          projectRoot,
          stateRoot: join(stateRoot, `cold-${run}`),
          mapRoot: join(stateRoot, `cold-${run}`, "repo-map"),
        }),
        loadConfig: async () => config,
        runtimeFactory: factory,
      });
      const context = { cwd: projectRoot, hasUI: false, ui: { setStatus: vi.fn(), notify: vi.fn() } };

      await target.events.get("session_start")?.[0]({}, context);
      expect(factory).not.toHaveBeenCalled();

      const first = (await target.tools.get("repo_context_search")?.execute("first", { query: "coldStartNeedle" })) as {
        details: {
          lifecycle: string;
          results: Array<{ path: string }>;
          fallbackEvidence: Array<{ kind: string }>;
        };
      };
      const useful =
        first.details.results.length > 0 ||
        first.details.fallbackEvidence.some((evidence) => evidence.kind === "source" || evidence.kind === "git-diff");
      if (useful) usefulFirstSearches += 1;
      expect(first.details).toMatchObject({
        lifecycle: "ready",
        results: [{ path: "src/cold-search.ts" }],
      });

      await target.events.get("session_shutdown")?.[0]({}, context);
    }

    expect(usefulFirstSearches).toBe(6);
  } finally {
    await Promise.all([
      rm(projectRoot, { recursive: true, force: true }),
      rm(stateRoot, { recursive: true, force: true }),
    ]);
  }
}, 60_000);
