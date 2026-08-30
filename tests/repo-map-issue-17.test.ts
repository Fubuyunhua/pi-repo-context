import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { RepoMapFileSystem } from "../src/repo-map/index.js";
import { RepoMapRuntime, type RepoMapScheduler } from "../src/repo-map/runtime.js";
import { Telemetry } from "../src/telemetry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class ManualScheduler implements RepoMapScheduler {
  tasks = new Set<() => void>();
  schedule(_delayMs: number, task: () => void): unknown {
    this.tasks.add(task);
    return task;
  }
  cancel(handle: unknown): void {
    this.tasks.delete(handle as () => void);
  }
}

it("returns the exact pending match on the first bounded live query in a 5,000-file repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-issue-17-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "repo-context-issue-17-state-"));
  roots.push(root, stateRoot);
  await mkdir(join(root, "src"));
  const filePath = (index: number) => join(root, "src", `file-${index.toString().padStart(5, "0")}.ts`);
  for (let offset = 0; offset < 5_000; offset += 250) {
    await Promise.all(
      Array.from({ length: 250 }, (_, index) => offset + index).map((index) =>
        writeFile(
          filePath(index),
          index === 19 ? `export const BATCH_MARKER_19 = ${index};\n` : `export const INITIAL_${index} = ${index};\n`,
        ),
      ),
    );
  }

  let armed = false;
  let incrementalReads = 0;
  let deadlineExpired = false;
  const fileSystem: RepoMapFileSystem = {
    lstat,
    async readFile(path) {
      const content = await readFile(path);
      if (armed && path.includes("/src/file-") && ++incrementalReads === 64) deadlineExpired = true;
      return content;
    },
  };
  const telemetry = new Telemetry();
  const runtime = new RepoMapRuntime({
    projectRoot: root,
    stateRoot,
    watch: false,
    scheduler: new ManualScheduler(),
    indexFileSystem: fileSystem,
    monotonicNow: () => (deadlineExpired ? 1_001 : 0),
    telemetry,
  });
  await runtime.start();

  armed = true;
  for (let index = 0; index < 100; index += 1) {
    await writeFile(filePath(index), `export const BATCH_MARKER_${index} = ${index};\n`);
    runtime.notify("change", `src/file-${index.toString().padStart(5, "0")}.ts`);
  }
  const coherentOnly = await runtime.queryCurrent("BATCH_MARKER_99");
  expect(coherentOnly.freshness).toBe("stale");
  expect(coherentOnly.results.some((row) => row.matchReasons?.some((reason) => reason.startsWith("pending ")))).toBe(
    false,
  );
  expect(coherentOnly.fallbackEvidence.some((evidence) => evidence.excerpt.includes("BATCH_MARKER_99"))).toBe(false);

  const result = await runtime.query("BATCH_MARKER_99", { limit: 20 });
  expect(result.freshness).toBe("stale");
  expect(result.pendingFiles).toContain("src/file-00099.ts");
  expect(result.results[0]).toMatchObject({
    path: "src/file-00099.ts",
    matchReasons: ["pending lexical fallback: exact query"],
  });
  expect(result.fallbackEvidence[0]).toMatchObject({
    kind: "source",
    path: "src/file-00099.ts",
    excerpt: expect.stringContaining("BATCH_MARKER_99"),
  });
  const partialIndex = result.results.findIndex((row) => row.path === "src/file-00019.ts");
  expect(partialIndex).toBeGreaterThan(0);

  const status = runtime.status();
  expect(status.generation).toBe(result.generation);
  expect(status.workspaceRevision).toBe(result.workspaceRevision);
  expect(status.pendingFiles).toEqual(result.pendingFiles);
  const work = telemetry.snapshot();
  expect(work.lexicalFallbackAttemptCount).toBe(1);
  expect(work.lexicalFallbackUsedCount).toBe(1);
  expect(work.lexicalFallbackMatchesReturned).toBe(1);
  expect(work.lexicalFallbackFilesScanned).toBeLessThanOrEqual(result.pendingFiles.length);
  expect(work.lexicalFallbackBytesScanned).toBeLessThanOrEqual(32 * 1024 * 1024);
  await runtime.close();
}, 120_000);
