import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepoMap, RepoMapSearch, type RepoMapSnapshot } from "../src/repo-map/index.js";
import { type RepoMapGeneration, RepoMapRuntime } from "../src/repo-map/runtime.js";
import { RepoStateBoundary } from "../src/state/owned-state.js";
import { resolveProjectState } from "../src/state/project-state.js";

const roots: string[] = [];
const VAULT_EVIDENCE = "uniquelyValidVaultEvidence_7d3f9c2a";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  root: string;
  project: string;
  piRoot: string;
  mapRoot: string;
  projectId: string;
  vaultArtifacts: string;
  vaultMetadata: string;
  legacyMap: string;
  vaultTargets: string[];
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "repo-context-state-boundary-"));
  roots.push(root);
  const project = join(root, "project");
  const piRoot = join(root, "pi-root");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "safe.ts"), "export const repositoryOwnedEvidence = true;\n");
  const state = await resolveProjectState(project, { PI_CODING_AGENT_DIR: piRoot });
  const vaultArtifacts = join(piRoot, "context-vault", "artifacts");
  const vaultMetadata = join(piRoot, "context-vault", "metadata");
  const legacyMap = join(piRoot, "context-vault", "projects", state.projectId, "repo-map");
  for (const target of [vaultArtifacts, vaultMetadata, legacyMap]) {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "vault-sentinel.bin"), Buffer.from([0, 255, 86, 65, 85, 76, 84, 10]));
  }
  await seedVaultGeneration(project, legacyMap);
  // Give every redirect depth a plausible legacy state suffix. A vulnerable
  // recursive mkdir/read must still not be able to reach evidence through it.
  await seedVaultGeneration(project, join(vaultArtifacts, "projects", state.projectId, "repo-map"));
  await seedVaultGeneration(project, join(vaultMetadata, state.projectId, "repo-map"));
  await seedVaultGeneration(project, join(legacyMap, "repo-map"));
  return {
    root,
    project,
    piRoot,
    mapRoot: state.mapRoot,
    projectId: state.projectId,
    vaultArtifacts,
    vaultMetadata,
    legacyMap,
    vaultTargets: [vaultArtifacts, vaultMetadata, legacyMap],
  };
}

async function seedVaultGeneration(project: string, mapRoot: string): Promise<void> {
  const source = await mkdtemp(join(tmpdir(), "repo-context-vault-evidence-"));
  roots.push(source);
  await writeFile(join(source, "vault-only.ts"), `export const ${VAULT_EVIDENCE} = true;\n`);
  const safeSnapshot = await buildRepoMap({ projectRoot: project });
  const vaultSnapshot = await buildRepoMap({ projectRoot: source });
  const snapshot = structuredClone(safeSnapshot) as RepoMapSnapshot;
  snapshot.files.push(...vaultSnapshot.files);
  snapshot.files.sort((left, right) => left.path.localeCompare(right.path));
  if (new RepoMapSearch(snapshot).query(VAULT_EVIDENCE)[0]?.path !== "vault-only.ts") {
    throw new Error("seeded Vault generation does not expose its unique matching evidence");
  }
  const generation: RepoMapGeneration = {
    schemaVersion: 1,
    generation: 1,
    gitHead: "vault-head",
    dirtyFiles: [],
    workspaceRevision: createHash("sha256").update("vault-revision").digest("hex"),
    freshness: "fresh",
    pendingFiles: [],
    snapshot,
    activatedAt: "2025-01-01T00:00:00.000Z",
  };
  await mkdir(join(mapRoot, "generations"), { recursive: true });
  await writeFile(join(mapRoot, "active.json"), `${JSON.stringify({ generation: 1, path: "generations/1.json" })}\n`);
  await writeFile(join(mapRoot, "generations", "1.json"), `${JSON.stringify(generation)}\n`);
}

async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(path: string): Promise<void> {
    const names = await readdir(path);
    for (const name of names.sort()) {
      const child = join(path, name);
      const info = await lstat(child);
      hash.update(`${relative(root, child)}\0${info.mode}\0${info.size}\0`);
      if (info.isSymbolicLink()) hash.update(`link:${await readFile(child, "utf8")}\0`);
      else if (info.isDirectory()) await walk(child);
      else hash.update(await readFile(child));
    }
  }
  await walk(root);
  return hash.digest("hex");
}

async function vaultDigests(targets: string[]): Promise<string[]> {
  return Promise.all(targets.map(treeDigest));
}

function ownedComponents(value: Fixture): Array<{ name: string; path: string; target: string }> {
  const product = join(value.piRoot, "pi-repo-context");
  const projects = join(product, "projects");
  const project = join(projects, value.projectId);
  return [
    { name: "pi-repo-context", path: product, target: value.vaultArtifacts },
    { name: "projects", path: projects, target: value.vaultMetadata },
    { name: "project ID", path: project, target: value.legacyMap },
    { name: "repo-map", path: value.mapRoot, target: value.legacyMap },
    { name: "generations", path: join(value.mapRoot, "generations"), target: join(value.legacyMap, "generations") },
  ];
}

function diagnosticText(value: unknown): string {
  if (value instanceof Error)
    return `${value.name}: ${value.message}${value.cause ? `; cause=${diagnosticText(value.cause)}` : ""}`;
  return JSON.stringify(value);
}

async function assertNoVaultEvidence(runtime: RepoMapRuntime): Promise<void> {
  const result = await runtime.queryCurrent(VAULT_EVIDENCE).catch((error: unknown) => error);
  const diagnostic = diagnosticText(result);
  expect(diagnostic).not.toContain("vault-only.ts");
  expect(diagnostic).not.toContain(VAULT_EVIDENCE);
}

describe("Repo-owned state boundary isolation", () => {
  it("preserves a configured Pi root symlink while capturing all five owned directory identities", async () => {
    const value = await fixture();
    const physicalPiRoot = join(value.root, "physical-pi-root");
    const linkedPiRoot = join(value.root, "linked-pi-root");
    await mkdir(physicalPiRoot);
    await symlink(physicalPiRoot, linkedPiRoot, "dir");
    const state = await resolveProjectState(value.project, { PI_CODING_AGENT_DIR: linkedPiRoot });
    const boundary = await RepoStateBoundary.create(state.mapRoot);
    const canonicalPiRoot = await realpath(physicalPiRoot);
    expect(boundary.identities).toHaveLength(5);
    expect(boundary.identities.map(({ path }) => path)).toEqual([
      join(canonicalPiRoot, "pi-repo-context"),
      join(canonicalPiRoot, "pi-repo-context", "projects"),
      join(canonicalPiRoot, "pi-repo-context", "projects", state.projectId),
      join(canonicalPiRoot, "pi-repo-context", "projects", state.projectId, "repo-map"),
      join(canonicalPiRoot, "pi-repo-context", "projects", state.projectId, "repo-map", "generations"),
    ]);
    expect(boundary.stateRoot).toBe(join(canonicalPiRoot, "pi-repo-context", "projects", state.projectId, "repo-map"));
    await expect(boundary.validate()).resolves.toBeUndefined();
  });

  it("pins canonical state paths when the configured Pi root symlink is repointed before a write", async () => {
    const value = await fixture();
    const physicalPiRoot = join(value.root, "captured-pi-root");
    const linkedPiRoot = join(value.root, "configured-pi-root");
    await mkdir(physicalPiRoot);
    await symlink(physicalPiRoot, linkedPiRoot, "dir");
    const state = await resolveProjectState(value.project, { PI_CODING_AGENT_DIR: linkedPiRoot });
    const canonicalPiRoot = await realpath(physicalPiRoot);
    let armed = false;
    let repointed = false;
    const runtime = new RepoMapRuntime({
      projectRoot: value.project,
      stateRoot: state.mapRoot,
      watch: false,
      beforeStateWrite: async (path) => {
        if (!armed || repointed) return;
        expect(relative(canonicalPiRoot, path).startsWith("..")).toBe(false);
        await rm(linkedPiRoot);
        await symlink(value.vaultArtifacts, linkedPiRoot, "dir");
        repointed = true;
      },
    });
    await runtime.start();
    const before = await vaultDigests(value.vaultTargets);
    armed = true;
    await writeFile(join(value.project, "src", "safe.ts"), "export const repositoryOwnedEvidence = 4;\n");
    runtime.notify("change", "src/safe.ts");
    await runtime.flush();
    expect(repointed).toBe(true);
    expect(runtime.status().error).toBeUndefined();
    expect((await runtime.query("repositoryOwnedEvidence")).results[0]?.path).toBe("src/safe.ts");
    expect(await vaultDigests(value.vaultTargets)).toEqual(before);
    await expect(
      readFile(
        join(canonicalPiRoot, "pi-repo-context", "projects", state.projectId, "repo-map", "active.json"),
        "utf8",
      ),
    ).resolves.toContain('"generation"');
    await runtime.close();
    expect(await vaultDigests(value.vaultTargets)).toEqual(before);
  });

  it("uses the before-write seam to reject a final-file swap without mutating Vault", async () => {
    const value = await fixture();
    let armed = false;
    let savedActive = "";
    const runtime = new RepoMapRuntime({
      projectRoot: value.project,
      stateRoot: value.mapRoot,
      watch: false,
      beforeStateWrite: async (path) => {
        if (!armed || !path.endsWith("active.json") || savedActive) return;
        savedActive = `${path}.owned-original`;
        await rename(path, savedActive);
        await symlink(join(value.legacyMap, "active.json"), path, "file");
      },
    });
    await runtime.start();
    const before = await vaultDigests(value.vaultTargets);
    armed = true;
    await writeFile(join(value.project, "src", "safe.ts"), "export const repositoryOwnedEvidence = 5;\n");
    runtime.notify("change", "src/safe.ts");
    await runtime.flush();
    expect(savedActive).not.toBe("");
    expect(runtime.status()).toMatchObject({ freshness: "stale" });
    await assertNoVaultEvidence(runtime);
    expect(await vaultDigests(value.vaultTargets)).toEqual(before);
    await rm(join(value.mapRoot, "active.json"));
    await rename(savedActive, join(value.mapRoot, "active.json"));
    await runtime.close();
  });

  for (const componentName of ["pi-repo-context", "projects", "project ID", "repo-map", "generations"]) {
    it(`rejects a static ${componentName} redirect without touching Vault trees`, async () => {
      const value = await fixture();
      const component = ownedComponents(value).find(({ name }) => name === componentName);
      if (!component) throw new Error("missing component fixture");
      await mkdir(dirname(component.path), { recursive: true });
      await symlink(component.target, component.path, "dir");
      const before = await vaultDigests(value.vaultTargets);
      const runtime = new RepoMapRuntime({ projectRoot: value.project, stateRoot: value.mapRoot, watch: false });
      await expect(runtime.start()).rejects.toThrow(/state boundary|non-symlink directory/iu);
      await assertNoVaultEvidence(runtime);
      await expect(runtime.close()).resolves.toBeUndefined();
      expect(await vaultDigests(value.vaultTargets)).toEqual(before);
    });
  }

  const postStartOperations = ["query", "status", "rebuild", "watcher", "maintenance", "shutdown"] as const;
  for (const componentName of ["pi-repo-context", "projects", "project ID", "repo-map", "generations"]) {
    for (const operation of postStartOperations) {
      it(`rejects a post-start ${componentName} replacement during ${operation}`, async () => {
        const value = await fixture();
        const component = ownedComponents(value).find(({ name }) => name === componentName);
        if (!component) throw new Error("missing component fixture");
        const runtime = new RepoMapRuntime({ projectRoot: value.project, stateRoot: value.mapRoot, watch: false });
        await runtime.start();
        const before = await vaultDigests(value.vaultTargets);
        const original = `${component.path}.owned-original`;
        await rename(component.path, original);
        await symlink(component.target, component.path, "dir");

        if (operation === "query")
          await expect(runtime.query("repositoryOwnedEvidence")).rejects.toThrow(/state boundary/iu);
        if (operation === "status") expect(runtime.status()).toMatchObject({ freshness: "stale" });
        if (operation === "rebuild") await expect(runtime.rebuild()).rejects.toThrow(/state boundary/iu);
        if (operation === "watcher") {
          runtime.notify("change", "src/safe.ts");
          expect(runtime.status()).toMatchObject({ freshness: "stale" });
          await expect(runtime.flush()).rejects.toThrow(/state boundary/iu);
        }
        if (operation === "maintenance") await expect(runtime.maintenance()).rejects.toThrow(/state boundary/iu);
        if (operation === "shutdown") await expect(runtime.close()).rejects.toThrow(/state boundary/iu);
        await assertNoVaultEvidence(runtime);
        expect(await vaultDigests(value.vaultTargets)).toEqual(before);

        await rm(component.path);
        await rename(original, component.path);
        await expect(runtime.close()).resolves.toBeUndefined();
      });
    }
  }

  it.each(["symlink", "directory"] as const)(
    "rejects static active.json %s entries and never hydrates their Vault evidence",
    async (entryKind) => {
      const value = await fixture();
      const boundary = await RepoStateBoundary.create(value.mapRoot);
      expect(boundary.identities).toHaveLength(5);
      const active = join(value.mapRoot, "active.json");
      const target = join(value.legacyMap, "active.json");
      if (entryKind === "symlink") await symlink(target, active, "file");
      else await mkdir(active);
      const before = await vaultDigests(value.vaultTargets);
      const runtime = new RepoMapRuntime({ projectRoot: value.project, stateRoot: value.mapRoot, watch: false });
      await runtime.start();
      expect(runtime.status()).toMatchObject({ freshness: "stale" });
      await assertNoVaultEvidence(runtime);
      await runtime.close();
      expect(await vaultDigests(value.vaultTargets)).toEqual(before);
    },
  );

  it.each(["symlink", "directory"] as const)(
    "rejects generation snapshot %s entries during hydration and pruning",
    async (entryKind) => {
      const value = await fixture();
      await RepoStateBoundary.create(value.mapRoot);
      const generation = join(value.mapRoot, "generations", "1.json");
      if (entryKind === "symlink") await symlink(join(value.legacyMap, "generations", "1.json"), generation, "file");
      else await mkdir(generation);
      await writeFile(
        join(value.mapRoot, "active.json"),
        `${JSON.stringify({ generation: 1, path: "generations/1.json" })}\n`,
      );
      const before = await vaultDigests(value.vaultTargets);
      const runtime = new RepoMapRuntime({
        projectRoot: value.project,
        stateRoot: value.mapRoot,
        watch: false,
        snapshotBuilder: async () => {
          throw new Error("forced cold rebuild failure");
        },
      });
      await runtime.start();
      await expect(runtime.maintenance()).rejects.toThrow(/regular file/iu);
      await assertNoVaultEvidence(runtime);
      await runtime.close();
      expect(await vaultDigests(value.vaultTargets)).toEqual(before);
    },
  );

  it("rejects post-start active and generation redirects on reads, writes, activation, and prune", async () => {
    const value = await fixture();
    const runtime = new RepoMapRuntime({
      projectRoot: value.project,
      stateRoot: value.mapRoot,
      watch: false,
      mapGenerationRetention: 1,
    });
    await runtime.start();
    const before = await vaultDigests(value.vaultTargets);
    const active = join(value.mapRoot, "active.json");
    const savedActive = `${active}.owned-original`;
    await rename(active, savedActive);
    await symlink(join(value.legacyMap, "active.json"), active, "file");
    await expect(runtime.maintenance()).rejects.toThrow(/regular file/iu);
    await writeFile(join(value.project, "src", "safe.ts"), "export const repositoryOwnedEvidence = 2;\n");
    runtime.notify("change", "src/safe.ts");
    await runtime.flush();
    expect(runtime.status()).toMatchObject({ freshness: "stale" });
    await assertNoVaultEvidence(runtime);
    expect(await vaultDigests(value.vaultTargets)).toEqual(before);
    await rm(active);
    await rename(savedActive, active);

    const loaded = JSON.parse(await readFile(active, "utf8")) as { generation: number };
    const generation = join(value.mapRoot, "generations", `${loaded.generation}.json`);
    const savedGeneration = `${generation}.owned-original`;
    await rename(generation, savedGeneration);
    await symlink(join(value.legacyMap, "generations", "1.json"), generation, "file");
    await expect(runtime.maintenance()).rejects.toThrow(/regular file/iu);
    expect(await vaultDigests(value.vaultTargets)).toEqual(before);
    await rm(generation);
    await rename(savedGeneration, generation);
    await runtime.close();
  });

  it("revalidates the boundary before shutdown flush", async () => {
    const value = await fixture();
    const runtime = new RepoMapRuntime({ projectRoot: value.project, stateRoot: value.mapRoot, watch: false });
    await runtime.start();
    const before = await vaultDigests(value.vaultTargets);
    const savedMap = `${value.mapRoot}.owned-original`;
    await rename(value.mapRoot, savedMap);
    await symlink(value.legacyMap, value.mapRoot, "dir");
    await expect(runtime.close()).rejects.toThrow(/state boundary/iu);
    expect(await vaultDigests(value.vaultTargets)).toEqual(before);
    await rm(value.mapRoot);
    await rename(savedMap, value.mapRoot);
  });

  it.each(["symlink", "file"] as const)(
    "rejects a static lock-target %s without writing into the target tree",
    async (entryKind) => {
      const value = await fixture();
      await RepoStateBoundary.create(value.mapRoot);
      const lock = join(value.mapRoot, "activation.lock");
      if (entryKind === "symlink") await symlink(value.vaultMetadata, lock, "dir");
      else await writeFile(lock, "not a lock directory\n");
      const before = await vaultDigests(value.vaultTargets);
      const runtime = new RepoMapRuntime({ projectRoot: value.project, stateRoot: value.mapRoot, watch: false });
      await runtime.start();
      expect(runtime.status()).toMatchObject({ freshness: "stale" });
      await assertNoVaultEvidence(runtime);
      await runtime.close();
      expect(await vaultDigests(value.vaultTargets)).toEqual(before);
    },
  );

  it("rejects a post-start lock redirect during watcher activation", async () => {
    const value = await fixture();
    const runtime = new RepoMapRuntime({ projectRoot: value.project, stateRoot: value.mapRoot, watch: false });
    await runtime.start();
    const before = await vaultDigests(value.vaultTargets);
    const lock = join(value.mapRoot, "activation.lock");
    await symlink(value.vaultArtifacts, lock, "dir");
    await writeFile(join(value.project, "src", "safe.ts"), "export const repositoryOwnedEvidence = 3;\n");
    runtime.notify("change", "src/safe.ts");
    await runtime.flush();
    expect(runtime.status()).toMatchObject({ freshness: "stale" });
    await assertNoVaultEvidence(runtime);
    expect(await vaultDigests(value.vaultTargets)).toEqual(before);
    await rm(lock);
    await runtime.close();
  });
});
