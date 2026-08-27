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
    dependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
    files: string[];
  };
  expect(manifest.dependencies).toEqual({
    chokidar: "5.0.0",
    "java-parser": "3.0.1",
    minisearch: "7.2.0",
    typescript: "5.9.3",
  });
  expect(manifest.peerDependencies).not.toHaveProperty("pi-context-vault");
  expect(manifest.files).not.toContain("tests");
});
