import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildRepoMap, loadRepoMapSnapshot } from "../src/repo-map/index.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/state/config.js";
import { resolveProjectState } from "../src/state/project-state.js";
import { RepoContextTelemetry } from "../src/telemetry.js";

it("loads only .pi/repo-context.json with exact defaults and rejects legacy/unknown keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-config-"));
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi", "context-vault.json"), "not-json", "utf8");
  expect(await loadConfig(root)).toEqual({ ...DEFAULT_CONFIG, excludePatterns: [] });

  await writeFile(
    join(root, ".pi", "repo-context.json"),
    JSON.stringify({
      enabled: false,
      searchMaxBytes: 512,
      debounceMs: 1,
      generationRetention: 1,
      quotaBytes: 1,
      excludePatterns: ["vendor"],
    }),
  );
  expect(await loadConfig(root)).toEqual({
    enabled: false,
    searchMaxBytes: 512,
    debounceMs: 1,
    generationRetention: 1,
    quotaBytes: 1,
    excludePatterns: ["vendor"],
  });

  for (const invalid of [
    { repoMapEnabled: true },
    { mapInjectionMode: "off" },
    { searchMaxBytes: 511 },
    { excludePatterns: [""] },
  ]) {
    await writeFile(join(root, ".pi", "repo-context.json"), JSON.stringify(invalid));
    await expect(loadConfig(root)).rejects.toThrow();
  }
});

it("computes the isolated state root without creating it", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-project-"));
  const piRoot = join(root, "pi-state");
  const state = await resolveProjectState(root, { PI_CODING_AGENT_DIR: piRoot });
  expect(state.projectRoot).toBe(root);
  expect(state.stateRoot).toBe(join(piRoot, "pi-repo-context", "projects", state.projectId));
  expect(state.mapRoot).toBe(join(state.stateRoot, "repo-map"));
  await expect(readFile(join(piRoot, "context-vault", "projects", state.projectId, "repo-map"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(readFile(state.mapRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

it("uses new schema-1 provenance and rejects legacy generators", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-provenance-"));
  await writeFile(join(root, "entry.ts"), "export const value = 1;\n");
  const snapshot = await buildRepoMap({ projectRoot: root });
  expect(snapshot.schemaVersion).toBe(1);
  expect(snapshot.provenance).toMatchObject({ generator: "pi-repo-context", generatorVersion: "0.1.0" });

  const path = join(root, "snapshot.json");
  await writeFile(
    path,
    JSON.stringify({ ...snapshot, provenance: { ...snapshot.provenance, generator: "pi-context-vault" } }),
  );
  await expect(loadRepoMapSnapshot(path)).rejects.toThrow();
});

it("exposes repository-only bounded telemetry", () => {
  const telemetry = new RepoContextTelemetry();
  telemetry.recordRepoMapQuery(2);
  telemetry.recordEnsureFresh(3);
  telemetry.recordGitHead(4);
  telemetry.recordGenerationCreated(10);
  const snapshot = telemetry.snapshot();
  expect(snapshot).toMatchObject({
    repoMapQueryCount: 1,
    repoMapQueryDurationMsTotal: 2,
    ensureFreshCount: 1,
    ensureFreshDurationMsTotal: 3,
    gitHeadCount: 1,
    generationCreatedCount: 1,
    generationBytesWritten: 10,
  });
  expect(Object.keys(snapshot).some((key) => /capsule|archive|metadata|reduction/iu.test(key))).toBe(false);
  expect(Object.is(snapshot, telemetry.snapshot())).toBe(false);
});
