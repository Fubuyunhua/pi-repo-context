import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { registerRepoContext } from "../src/extension.js";
import { buildRepoMap } from "../src/repo-map/index.js";
import { resolveProjectState } from "../src/state/project-state.js";

interface Tool {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

it("cold-builds in the new root without reading or mutating a valid legacy tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-legacy-isolation-"));
  try {
    const project = join(root, "project");
    const legacyProject = join(root, "legacy-fixture");
    const piRoot = join(root, "pi-state");
    await mkdir(join(project, ".pi"), { recursive: true });
    await mkdir(legacyProject, { recursive: true });
    await writeFile(join(project, "entry.ts"), "export const freshTarget = true;\n");
    await writeFile(join(project, ".pi", "repo-context.json"), JSON.stringify({ debounceMs: 1 }));
    await writeFile(join(legacyProject, "legacy.ts"), "export const legacyOnlyTarget = true;\n");

    const state = await resolveProjectState(project, { PI_CODING_AGENT_DIR: piRoot });
    const legacyRoot = join(piRoot, "context-vault", "projects", state.projectId, "repo-map");
    const legacyGenerations = join(legacyRoot, "generations");
    await mkdir(legacyGenerations, { recursive: true });
    const legacySnapshot = structuredClone(await buildRepoMap({ projectRoot: legacyProject })) as unknown as {
      provenance: { generator: string };
    } & Record<string, unknown>;
    legacySnapshot.provenance.generator = "pi-context-vault";
    const legacyGeneration = {
      schemaVersion: 1,
      generation: 1,
      gitHead: "legacy-head",
      dirtyFiles: [],
      workspaceRevision: "legacy-revision",
      freshness: "fresh",
      pendingFiles: [],
      snapshot: legacySnapshot,
      activatedAt: "2025-01-01T00:00:00.000Z",
    };
    const activeText = `${JSON.stringify({ generation: 1, path: "generations/1.json" }, null, 2)}\n`;
    const generationText = `${JSON.stringify(legacyGeneration, null, 2)}\n`;
    const sentinelText = "legacy derived state must remain untouched\n";
    await writeFile(join(legacyRoot, "active.json"), activeText);
    await writeFile(join(legacyGenerations, "1.json"), generationText);
    await writeFile(join(legacyRoot, "sentinel.txt"), sentinelText);

    const events = new Map<string, (...args: unknown[]) => unknown>();
    const tools = new Map<string, Tool>();
    let activeTools: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        events.set(name, handler);
      },
      registerTool(tool: Tool) {
        tools.set(tool.name, tool);
        activeTools.push(tool.name);
      },
      registerCommand() {},
      getActiveTools() {
        return [...activeTools];
      },
      setActiveTools(names: string[]) {
        activeTools = [...names];
      },
    } as unknown as ExtensionAPI;
    registerRepoContext(pi, {
      resolveProjectState: (cwd) => resolveProjectState(cwd, { PI_CODING_AGENT_DIR: piRoot }),
      initializationWaiter: async (initialization) => {
        await initialization;
        return "ready";
      },
    });
    const context = { cwd: project, hasUI: false, ui: { setStatus() {}, notify() {} } };
    await events.get("session_start")?.({}, context);

    const dormant = (await tools.get("repo_context_status")?.execute()) as {
      content: Array<{ text: string }>;
      details: { available: boolean; lifecycle: string };
    };
    expect(dormant.details).toMatchObject({ available: false, lifecycle: "dormant" });
    expect(dormant.content[0]?.text).not.toContain(state.mapRoot);
    expect(dormant.content[0]?.text).not.toContain(legacyRoot);

    const search = (await tools.get("repo_context_search")?.execute("id", { query: "freshTarget", limit: 10 })) as {
      details: { results: Array<{ path: string }> };
    };
    expect(search.details.results.map((row) => row.path)).toContain("entry.ts");
    expect(search.details.results.map((row) => row.path)).not.toContain("legacy.ts");
    const ready = (await tools.get("repo_context_status")?.execute()) as {
      details: { available: boolean; lifecycle: string };
    };
    expect(ready.details).toMatchObject({ available: true, lifecycle: "ready" });
    await expect(readFile(join(state.mapRoot, "active.json"), "utf8")).resolves.toContain('"generation"');

    await events.get("session_shutdown")?.({}, context);
    expect(await readFile(join(legacyRoot, "active.json"), "utf8")).toBe(activeText);
    expect(await readFile(join(legacyGenerations, "1.json"), "utf8")).toBe(generationText);
    expect(await readFile(join(legacyRoot, "sentinel.txt"), "utf8")).toBe(sentinelText);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
