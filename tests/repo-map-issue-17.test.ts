import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RepoMapFileSystem } from "../src/repo-map/index.js";
import { scanLexicalFallback } from "../src/repo-map/lexical-fallback.js";
import { RepoMapRuntime, type RepoMapScheduler } from "../src/repo-map/runtime.js";
import { Telemetry } from "../src/telemetry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function isIssueIncrementalRead(path: string): boolean {
  return path.replaceAll("\\", "/").includes("/src/file-");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("normalizes Windows separators in the issue-17 incremental-read predicate", () => {
  expect(isIssueIncrementalRead("C:\\repo\\src\\file-00099.ts")).toBe(true);
});

it("returns the exact pending match when the 300ms production-style scheduler fires during the first live query", async () => {
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
      if (armed && isIssueIncrementalRead(path) && ++incrementalReads === 64) deadlineExpired = true;
      return content;
    },
  };
  const scheduledCallbackFired = deferred();
  const scheduledDelays: number[] = [];
  let queryOutstanding = false;
  let callbackFiredWhileQueryLeased = false;
  const scheduler: RepoMapScheduler = {
    schedule(delayMs, task) {
      scheduledDelays.push(delayMs);
      return setTimeout(() => {
        if (queryOutstanding) {
          callbackFiredWhileQueryLeased = true;
          scheduledCallbackFired.resolve();
        }
        task();
      }, delayMs);
    },
    cancel(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
  const telemetry = new Telemetry();
  const pendingScanner = vi.fn(async (options: Parameters<typeof scanLexicalFallback>[0]) => {
    await scheduledCallbackFired.promise;
    return scanLexicalFallback(options);
  });
  const runtime = new RepoMapRuntime({
    projectRoot: root,
    stateRoot,
    watch: false,
    mapDebounceMs: 300,
    scheduler,
    indexFileSystem: fileSystem,
    monotonicNow: () => (deadlineExpired ? 1_001 : 0),
    telemetry,
    pendingScanner,
  });
  await runtime.start();

  armed = true;
  for (let index = 0; index < 100; index += 1) {
    await writeFile(filePath(index), `export const BATCH_MARKER_${index} = ${index};\n`);
    runtime.notify("change", `src/file-${index.toString().padStart(5, "0")}.ts`);
  }
  queryOutstanding = true;
  const result = await runtime.query("BATCH_MARKER_99", { limit: 20 });
  queryOutstanding = false;
  expect(callbackFiredWhileQueryLeased).toBe(true);
  expect(scheduledDelays).toContain(300);
  expect(pendingScanner).toHaveBeenCalledOnce();
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
