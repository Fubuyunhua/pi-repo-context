import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

async function files(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else output.push(path);
    }
  };
  await visit(root);
  return output.sort();
}

it("has no Vault, S03, bench, report, or automatic-injection production boundary", async () => {
  const root = resolve(".");
  for (const forbidden of [
    "src/artifacts",
    "src/observations",
    "src/context",
    "src/bench",
    "src/repo-context",
    "docs/reports",
  ])
    await expect(readdir(join(root, forbidden))).rejects.toMatchObject({ code: "ENOENT" });

  const production = await files(join(root, "src"));
  const text = (await Promise.all(production.map((path) => readFile(path, "utf8")))).join("\n");
  expect(text).not.toContain("pi-context-vault");
  expect(text).not.toContain(".pi/context-vault.json");
  expect(text).not.toContain('join(piRoot, "context-vault"');
  expect(text).not.toContain('pi.on("context"');
  expect(text).not.toContain('pi.on("before_agent_start"');
  expect(text).not.toContain('pi.on("tool_result"');
  expect(text).not.toContain("ProjectionBody");
  expect(text).not.toContain("Planner");

  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    version: string;
    dependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
    files: string[];
  };
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")) as {
    version: string;
    packages: Record<string, { version?: string; peerDependencies?: Record<string, string> }>;
  };
  expect(manifest.dependencies).toEqual({
    chokidar: "5.0.0",
    minisearch: "7.2.0",
    typescript: "5.9.3",
    "web-tree-sitter": "0.26.11",
  });
  const exactPeers = {
    "@earendil-works/pi-coding-agent": "0.84.1",
    typebox: "1.3.7",
  };
  expect(manifest.version).toBe("0.1.0");
  expect(manifest.peerDependencies).toEqual(exactPeers);
  expect(lock.version).toBe("0.1.0");
  expect(lock.packages[""]?.version).toBe("0.1.0");
  expect(lock.packages[""]?.peerDependencies).toEqual(exactPeers);
  expect(manifest.files).toEqual([
    "extensions/index.ts",
    "src/extension.ts",
    "src/repo-map/canonical.ts",
    "src/repo-map/graph.ts",
    "src/repo-map/index.ts",
    "src/repo-map/java.ts",
    "src/repo-map/runtime.ts",
    "src/repo-map/snapshot.ts",
    "src/state/atomic.ts",
    "src/state/config.ts",
    "src/state/owned-state.ts",
    "src/state/project-state.ts",
    "src/telemetry.ts",
    "vendor/tree-sitter-java-orchard/tree-sitter-java_orchard.wasm",
    "vendor/tree-sitter-java-orchard/LICENSE",
    "docs/MIGRATION.md",
    "docs/releases/v0.1.0.md",
    "docs/specs/0005-bounded-repo-map-generations.md",
    "docs/specs/0006-repo-map-file-outcomes.md",
    "docs/specs/0007-cached-repo-map-search.md",
    "docs/specs/0009-turn-start-snapshot-semantics.md",
    "docs/specs/0016-repository-graph-contract.md",
    "docs/specs/0019-lazy-repo-map-startup.md",
    "docs/specs/README.md",
    "README.md",
    "LICENSE",
  ]);
});
