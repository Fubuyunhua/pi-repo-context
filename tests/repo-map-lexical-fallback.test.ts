import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, type open, type opendir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import {
  LEXICAL_FALLBACK_LIMITS,
  type LexicalFallbackFileSystem,
  type LexicalFallbackOperationStage,
  scanLexicalFallback,
} from "../src/repo-map/lexical-fallback.js";

const execFileAsync = promisify(execFile);

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

it("ranks linked dotted, underscored, and path terms with match-centered bounded excerpts", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-"));
  await mkdir(join(root, "django", "db"), { recursive: true });
  await writeFile(
    join(root, "django", "db", "models.py"),
    `${"unrelated\n".repeat(80)}class QuerySet:\n    def in_bulk(self, id_list):\n        return self.filter(pk__in=id_list)\n`,
  );
  await writeFile(join(root, "noise.txt"), "query set bulk words without the linked identifier\n");

  const dotted = await scanLexicalFallback({ projectRoot: root, query: "django.db.models", limit: 3 });
  expect(dotted.results[0]?.path).toBe("django/db/models.py");
  const linked = await scanLexicalFallback({ projectRoot: root, query: "QuerySet.in_bulk", limit: 3 });
  expect(linked.results[0]?.path).toBe("django/db/models.py");
  expect(linked.fallbackEvidence[0]).toMatchObject({ kind: "source", path: "django/db/models.py" });
  expect(linked.fallbackEvidence[0]?.excerpt).toContain("in_bulk");
  expect(linked.fallbackEvidence[0]?.excerpt).not.toContain("unrelated\nunrelated\nunrelated\nunrelated");
  expect(Buffer.byteLength(linked.fallbackEvidence[0]?.excerpt ?? "", "utf8")).toBeLessThanOrEqual(
    LEXICAL_FALLBACK_LIMITS.maxExcerptBytes,
  );
});

it("uses explicit path evidence instead of unrelated source for path-only matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-path-"));
  await mkdir(join(root, "src", "QuerySet"), { recursive: true });
  await writeFile(join(root, "src", "QuerySet", "in_bulk.ts"), "unrelated first line\n");

  const result = await scanLexicalFallback({ projectRoot: root, query: "QuerySet.in_bulk" });
  expect(result.results[0]?.path).toBe("src/QuerySet/in_bulk.ts");
  expect(result.fallbackEvidence[0]).toMatchObject({
    kind: "warming",
    path: "src/QuerySet/in_bulk.ts",
    excerpt: expect.stringContaining("Path matched query terms"),
  });
  expect(result.fallbackEvidence[0]?.excerpt).not.toContain("unrelated first line");
});

it("uses actual source evidence for short content-only component matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-short-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "unrelated.ts"), "const db = connect();\n");

  const result = await scanLexicalFallback({ projectRoot: root, query: "foo.db" });
  expect(result.results[0]?.path).toBe("src/unrelated.ts");
  expect(result.fallbackEvidence[0]).toMatchObject({
    kind: "source",
    path: "src/unrelated.ts",
    excerpt: expect.stringContaining("db"),
  });
  expect(result.fallbackEvidence[0]?.excerpt).not.toContain("Path matched query terms");
});

it("matches normal non-Git ignore trimming and comment semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-ignore-parity-"));
  await writeFile(join(root, ".gitignore"), "# comment-only\nsecret.ts   \n");
  await writeFile(join(root, "secret.ts"), "trimmedIgnoreNeedle\n");
  await writeFile(join(root, "# comment-only"), "commentPathNeedle\n");

  expect(await scanLexicalFallback({ projectRoot: root, query: "trimmedIgnoreNeedle" })).toMatchObject({ results: [] });
  expect((await scanLexicalFallback({ projectRoot: root, query: "commentPathNeedle" })).results[0]?.path).toBe(
    "# comment-only",
  );
});

it("fails closed for unsafe non-Git ignore files", async () => {
  for (const kind of ["oversized", "symlink", "nonregular", "replaced", "unreadable"] as const) {
    const root = await mkdtemp(join(tmpdir(), `repo-context-lexical-ignore-${kind}-`));
    const ignorePath = join(root, ".gitignore");
    await writeFile(join(root, "secret.ts"), "ignoreEscapeNeedle\n");
    let beforeOpen: ((path: string) => Promise<void>) | undefined;
    if (kind === "oversized") {
      await writeFile(ignorePath, `${"#".repeat(LEXICAL_FALLBACK_LIMITS.maxIgnoreBytes + 1)}\n`);
    } else if (kind === "symlink") {
      const outside = await mkdtemp(join(tmpdir(), "repo-context-lexical-ignore-outside-"));
      await writeFile(join(outside, "ignore"), "secret.ts\n");
      await symlink(join(outside, "ignore"), ignorePath);
    } else if (kind === "nonregular") {
      await mkdir(ignorePath);
    } else {
      await writeFile(ignorePath, "secret.ts\n");
      beforeOpen = async (path) => {
        if (path !== ignorePath) return;
        if (kind === "unreadable") throw Object.assign(new Error("simulated unreadable ignore"), { code: "EACCES" });
        await rename(path, `${path}.original`);
        await writeFile(path, "");
      };
    }
    const result = await scanLexicalFallback({
      projectRoot: root,
      query: "ignoreEscapeNeedle",
      ...(beforeOpen ? { beforeOpen } : {}),
    });
    expect(result).toMatchObject({ capped: true, results: [], fallbackEvidence: [] });
  }
});

it("charges excluded and directory entries against non-Git enumeration bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-bounds-"));
  for (const name of ["one", "two", "three", "four"]) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "needle.ts"), "boundedNeedle\n");
  }

  const result = await scanLexicalFallback({
    projectRoot: root,
    query: "boundedNeedle",
    exclude: ["one/**", "two/**", "three/**", "four/**"],
    limits: { maxEnumeratedPaths: 2 },
  });
  expect(result).toMatchObject({ capped: true, enumeratedPaths: 2, results: [] });
});

it("rejects a file replaced between identity validation and open", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-race-"));
  const target = join(root, "target.ts");
  await writeFile(target, "original content\n");
  let swapped = false;

  const result = await scanLexicalFallback({
    projectRoot: root,
    query: "outsideSecret",
    async beforeOpen(path) {
      if (path !== target || swapped) return;
      swapped = true;
      await rename(path, `${path}.original`);
      await writeFile(path, "outsideSecret must not be returned\n");
    },
  });
  expect(swapped).toBe(true);
  expect(result.results).toEqual([]);
  expect(result.fallbackEvidence).toEqual([]);
});

it("uses authoritative Git admission, including tracked files later ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-git-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, "tracked.log"), "trackedUniqueSecret\n");
  await execFileAsync("git", ["add", "tracked.log"], { cwd: root });
  await writeFile(join(root, ".gitignore"), "*.log\nignored.txt\n");
  await writeFile(join(root, "ignored.txt"), "ignoredUniqueSecret\n");
  await writeFile(join(root, ".pi", "secret.txt"), "builtinUniqueSecret\n");
  await writeFile(join(root, "configured.txt"), "configuredUniqueSecret\n");

  expect((await scanLexicalFallback({ projectRoot: root, query: "trackedUniqueSecret" })).results[0]?.path).toBe(
    "tracked.log",
  );
  expect(await scanLexicalFallback({ projectRoot: root, query: "ignoredUniqueSecret" })).toMatchObject({
    results: [],
  });
  expect(await scanLexicalFallback({ projectRoot: root, query: "builtinUniqueSecret" })).toMatchObject({
    results: [],
  });
  expect(
    await scanLexicalFallback({ projectRoot: root, query: "configuredUniqueSecret", exclude: ["configured.txt"] }),
  ).toMatchObject({ results: [] });
});

it("bounds and authoritatively admits explicit Git candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-candidates-git-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, "tracked.log"), "candidateTrackedNeedle\n");
  await execFileAsync("git", ["add", "tracked.log"], { cwd: root });
  await writeFile(join(root, ".gitignore"), "*.log\nignored.txt\n");
  await writeFile(join(root, "ignored.txt"), "candidateIgnoredNeedle\n");

  const tracked = await scanLexicalFallback({
    projectRoot: root,
    query: "candidateTrackedNeedle",
    candidatePaths: ["tracked.log", "tracked.log", "ignored.txt"],
  });
  expect(tracked.results[0]).toMatchObject({
    path: "tracked.log",
    matchReasons: ["pending lexical fallback: exact query"],
  });
  expect(tracked).toMatchObject({ enumeratedPaths: 3, conclusivePaths: ["ignored.txt", "tracked.log"] });
  expect(
    await scanLexicalFallback({
      projectRoot: root,
      query: "candidateIgnoredNeedle",
      candidatePaths: ["ignored.txt"],
    }),
  ).toMatchObject({ results: [] });
});

it("fails closed on ambiguous Git candidate-admission errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-candidates-ambiguous-git-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, ".git", "config"), "this is not valid git config\n");
  await writeFile(join(root, "secret.ts"), "ambiguousGitSecret\n");

  const candidate = await scanLexicalFallback({
    projectRoot: root,
    query: "ambiguousGitSecret",
    candidatePaths: ["secret.ts"],
  });
  expect(candidate).toMatchObject({ capped: true, results: [], fallbackEvidence: [] });
  const full = await scanLexicalFallback({ projectRoot: root, query: "ambiguousGitSecret" });
  expect(full).toMatchObject({ capped: true, results: [], fallbackEvidence: [] });
});

it("uses only explicit candidates with hardened non-Git ignore and work bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-candidates-walk-"));
  await writeFile(join(root, ".gitignore"), "ignored.ts\n");
  await writeFile(join(root, "kept.ts"), "candidateKeptNeedle\n");
  await writeFile(join(root, "ignored.ts"), "candidateIgnoredNeedle\n");
  await writeFile(join(root, "unsupplied.ts"), "candidateUnsuppliedNeedle\n");

  const kept = await scanLexicalFallback({
    projectRoot: root,
    query: "candidateKeptNeedle",
    candidatePaths: ["./kept.ts", "ignored.ts", "../escape.ts", "kept.ts"],
  });
  expect(kept.results[0]?.path).toBe("kept.ts");
  expect(kept.enumeratedPaths).toBe(4);
  expect(kept.conclusivePaths).toEqual(["ignored.ts", "kept.ts"]);
  for (const [query, candidatePaths] of [
    ["candidateIgnoredNeedle", ["ignored.ts"]],
    ["candidateUnsuppliedNeedle", ["kept.ts"]],
  ] as const) {
    expect((await scanLexicalFallback({ projectRoot: root, query, candidatePaths })).results).toEqual([]);
  }

  const capped = await scanLexicalFallback({
    projectRoot: root,
    query: "candidateKeptNeedle",
    candidatePaths: ["kept.ts", "ignored.ts"],
    limits: { maxEnumeratedPaths: 1 },
  });
  expect(capped).toMatchObject({ capped: true, enumeratedPaths: 1 });
});

it("keeps explicit candidate reads within the configured concurrency", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-candidate-concurrency-"));
  const candidatePaths = Array.from({ length: 6 }, (_, index) => `${index}.ts`);
  await Promise.all(candidatePaths.map((path) => writeFile(join(root, path), `concurrentNeedle${path}\n`)));
  let active = 0;
  let maximum = 0;
  const result = await scanLexicalFallback({
    projectRoot: root,
    query: "concurrentNeedle",
    candidatePaths,
    limits: { concurrency: 2 },
    beforeOpen: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      active -= 1;
    },
  });
  expect(result.filesScanned).toBe(6);
  expect(maximum).toBe(2);
});

it("rejects deleted, non-regular, binary, and unreadable explicit candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-candidate-outcomes-"));
  await writeFile(join(root, "binary.bin"), Buffer.from("candidateBinaryNeedle\0tail"));
  await mkdir(join(root, "directory.ts"));
  await writeFile(join(root, "unreadable.ts"), "candidateUnreadableNeedle\n");

  for (const query of ["candidateBinaryNeedle", "candidateMissingNeedle", "candidateDirectoryNeedle"]) {
    const path = query.includes("Binary") ? "binary.bin" : query.includes("Missing") ? "missing.ts" : "directory.ts";
    expect((await scanLexicalFallback({ projectRoot: root, query, candidatePaths: [path] })).results).toEqual([]);
  }
  const unreadable = await scanLexicalFallback({
    projectRoot: root,
    query: "candidateUnreadableNeedle",
    candidatePaths: ["unreadable.ts"],
    beforeOpen: async (path) => {
      if (path.endsWith("unreadable.ts")) throw Object.assign(new Error("simulated unreadable"), { code: "EACCES" });
    },
  });
  expect(unreadable.results).toEqual([]);
  expect(unreadable.fallbackEvidence).toEqual([]);
  expect(unreadable.conclusivePaths).toEqual([]);
  expect(unreadable.unresolvedPaths).toEqual(["unreadable.ts"]);
});

it("honors non-Git root ignore negation and skips symlinks and binary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-walk-"));
  const outside = await mkdtemp(join(tmpdir(), "repo-context-lexical-outside-"));
  await writeFile(join(root, ".gitignore"), "ignored/**\n!ignored/\n!ignored/kept.txt\n");
  await mkdir(join(root, "ignored"));
  await writeFile(join(root, "ignored", "hidden.txt"), "hiddenUniqueNeedle\n");
  await writeFile(join(root, "ignored", "kept.txt"), "keptUniqueNeedle\n");
  await writeFile(join(root, "binary.bin"), Buffer.from("binaryUniqueNeedle\0tail"));
  await writeFile(join(outside, "outside.txt"), "outsideUniqueNeedle\n");
  await symlink(join(outside, "outside.txt"), join(root, "escape.txt"));

  expect((await scanLexicalFallback({ projectRoot: root, query: "keptUniqueNeedle" })).results[0]?.path).toBe(
    "ignored/kept.txt",
  );
  for (const query of ["hiddenUniqueNeedle", "binaryUniqueNeedle", "outsideUniqueNeedle"]) {
    expect((await scanLexicalFallback({ projectRoot: root, query })).results).toEqual([]);
  }
});

it("enforces source/file/result bounds and cancellation without leaking partial retired evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-bounds-"));
  for (let index = 0; index < 8; index += 1) {
    await writeFile(join(root, `${index}.txt`), `${"x".repeat(2048)} bounded_needle_${index}\n`);
  }
  const capped = await scanLexicalFallback({
    projectRoot: root,
    query: "bounded_needle",
    limit: 20,
    limits: {
      maxEnumeratedPaths: 2,
      maxEnumerationBytes: 4096,
      maxFiles: 2,
      maxSourceBytes: 4096,
      maxFileBytes: 2048,
      concurrency: 1,
    },
  });
  expect(capped.capped).toBe(true);
  expect(capped.enumeratedPaths).toBeLessThanOrEqual(2);
  expect(capped.enumerationBytes).toBeLessThanOrEqual(4096);
  expect(capped.filesScanned).toBeLessThanOrEqual(2);
  expect(capped.bytesScanned).toBeLessThanOrEqual(4096);

  const controller = new AbortController();
  controller.abort();
  const cancelled = await scanLexicalFallback({
    projectRoot: root,
    query: "bounded_needle",
    candidatePaths: ["0.txt", "1.txt"],
    signal: controller.signal,
  });
  expect(cancelled).toMatchObject({ cancelled: true, results: [], fallbackEvidence: [] });
  expect(cancelled.filesScanned).toBe(0);

  const timedOut = await scanLexicalFallback({
    projectRoot: root,
    query: "bounded_needle",
    limits: { deadlineMs: 0 },
  });
  expect(timedOut.timedOut).toBe(true);
  expect(timedOut.filesScanned).toBeLessThanOrEqual(LEXICAL_FALLBACK_LIMITS.maxFiles);
  expect(timedOut.bytesScanned).toBeLessThanOrEqual(LEXICAL_FALLBACK_LIMITS.maxSourceBytes);
});

it("hard-bounds and drains every candidate file-operation stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-hard-file-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, "pending.ts"), "hardBoundPendingNeedle\n");
  await execFileAsync("git", ["add", "pending.ts"], { cwd: root });
  const stages: LexicalFallbackOperationStage[] = ["lstat", "realpath", "open", "stat", "read", "close"];

  for (const stage of stages) {
    const controller = new AbortController();
    const entered = deferred();
    const gate = deferred();
    let gated = false;
    const scanning = scanLexicalFallback({
      projectRoot: root,
      query: "hardBoundPendingNeedle",
      candidatePaths: ["pending.ts"],
      signal: controller.signal,
      operationHook: async (current, path) => {
        if (gated || current !== stage || !path.endsWith("pending.ts")) return;
        gated = true;
        entered.resolve();
        await gate.promise;
      },
    });
    await entered.promise;
    controller.abort(new Error(`cancel-${stage}`));
    await expect(scanning).resolves.toMatchObject({
      results: [],
      fallbackEvidence: [],
      timedOut: false,
      cancelled: true,
    });
    // Reject after logical retirement: the late hook settlement must remain
    // observed and cannot become an unhandled rejection or mutate the result.
    gate.reject(new Error(`late-${stage}`));
    await Promise.resolve();
    await Promise.resolve();
  }
});

it("hard-bounds before-open, before-read, and the enclosing batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-hard-hooks-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, "pending.ts"), "hookBoundPendingNeedle\n");
  await execFileAsync("git", ["add", "pending.ts"], { cwd: root });

  for (const hook of ["beforeOpen", "beforeRead"] as const) {
    const controller = new AbortController();
    const entered = deferred();
    const gate = deferred();
    const scanning = scanLexicalFallback({
      projectRoot: root,
      query: "hookBoundPendingNeedle",
      candidatePaths: ["pending.ts"],
      signal: controller.signal,
      [hook]: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    await entered.promise;
    controller.abort();
    await expect(scanning).resolves.toMatchObject({ cancelled: true, results: [], fallbackEvidence: [] });
    gate.resolve();
  }
});

it("hard-bounds non-Git directory open, iteration, and close", async () => {
  const stages: LexicalFallbackOperationStage[] = ["directory-open", "directory-read", "directory-close"];
  for (const stage of stages) {
    const root = await mkdtemp(join(tmpdir(), `repo-context-lexical-hard-${stage}-`));
    await writeFile(join(root, "pending.ts"), "directoryBoundPendingNeedle\n");
    const controller = new AbortController();
    const entered = deferred();
    const gate = deferred();
    let gated = false;
    const scanning = scanLexicalFallback({
      projectRoot: root,
      query: "directoryBoundPendingNeedle",
      signal: controller.signal,
      operationHook: async (current) => {
        if (gated || current !== stage) return;
        gated = true;
        entered.resolve();
        await gate.promise;
      },
    });
    await entered.promise;
    controller.abort();
    await expect(scanning).resolves.toMatchObject({ cancelled: true, results: [], fallbackEvidence: [] });
    gate.resolve();
  }
});

it("hard-bounds actual lstat and realpath operations and observes late rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-actual-path-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, "pending.ts"), "actualPathNeedle\n");
  await execFileAsync("git", ["add", "pending.ts"], { cwd: root });

  for (const stage of ["lstat", "realpath"] as const) {
    const controller = new AbortController();
    const entered = deferred();
    const operation = deferred<never>();
    const fileSystem: Partial<LexicalFallbackFileSystem> =
      stage === "lstat"
        ? {
            lstat: ((path: string, options?: object) => {
              if (path.endsWith("pending.ts")) {
                entered.resolve();
                return operation.promise;
              }
              return lstat(path, options as never);
            }) as LexicalFallbackFileSystem["lstat"],
          }
        : {
            realpath: ((path: string) => {
              if (path.endsWith("pending.ts")) {
                entered.resolve();
                return operation.promise;
              }
              return realpath(path);
            }) as LexicalFallbackFileSystem["realpath"],
          };
    const scanning = scanLexicalFallback({
      projectRoot: root,
      query: "actualPathNeedle",
      candidatePaths: ["pending.ts"],
      signal: controller.signal,
      fileSystem,
    });
    await entered.promise;
    controller.abort();
    await expect(scanning).resolves.toMatchObject({ cancelled: true, results: [], fallbackEvidence: [] });
    operation.reject(new Error(`late actual ${stage} rejection`));
    await Promise.resolve();
    await Promise.resolve();
  }
});

it("initiates owned file closure immediately for stalled stat/read and closes late opens", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-actual-file-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  const target = join(root, "pending.ts");
  await writeFile(target, "actualFileNeedle\n");
  await execFileAsync("git", ["add", "pending.ts"], { cwd: root });
  const info = await lstat(target, { bigint: true });

  // A handle that arrives only after retirement is still closed.
  {
    const controller = new AbortController();
    const entered = deferred();
    const opening = deferred<Awaited<ReturnType<typeof open>>>();
    const close = vi.fn(async () => undefined);
    const scanning = scanLexicalFallback({
      projectRoot: root,
      query: "actualFileNeedle",
      candidatePaths: ["pending.ts"],
      signal: controller.signal,
      fileSystem: {
        open: (() => {
          entered.resolve();
          return opening.promise;
        }) as LexicalFallbackFileSystem["open"],
      },
    });
    await entered.promise;
    controller.abort();
    await expect(scanning).resolves.toMatchObject({ cancelled: true, results: [] });
    opening.resolve({ close } as unknown as Awaited<ReturnType<typeof open>>);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  }

  for (const stage of ["stat", "read"] as const) {
    const controller = new AbortController();
    const entered = deferred();
    const stalled = deferred<never>();
    const close = vi.fn(async () => undefined);
    const handle = {
      stat: vi.fn(async () => {
        if (stage === "stat") {
          entered.resolve();
          return stalled.promise;
        }
        return info;
      }),
      read: vi.fn(async (buffer: Buffer) => {
        if (stage === "read") {
          entered.resolve();
          return stalled.promise;
        }
        return { bytesRead: 0, buffer };
      }),
      close,
    } as unknown as Awaited<ReturnType<typeof open>>;
    const scanning = scanLexicalFallback({
      projectRoot: root,
      query: "actualFileNeedle",
      candidatePaths: ["pending.ts"],
      signal: controller.signal,
      fileSystem: { open: (async () => handle) as LexicalFallbackFileSystem["open"] },
    });
    await entered.promise;
    controller.abort();
    await expect(scanning).resolves.toMatchObject({ cancelled: true, results: [], fallbackEvidence: [] });
    expect(close).toHaveBeenCalledOnce();
    stalled.reject(new Error(`late actual ${stage} rejection`));
    await Promise.resolve();
    await Promise.resolve();
  }

  // A never-settling close is initiated once but cannot hold logical return.
  {
    const controller = new AbortController();
    const closeEntered = deferred();
    const close = vi.fn(() => {
      closeEntered.resolve();
      return new Promise<void>(() => undefined);
    });
    const content = Buffer.from("actualFileNeedle\n");
    const handle = {
      stat: vi.fn(async () => info),
      read: vi.fn(async (buffer: Buffer) => {
        content.copy(buffer);
        return { bytesRead: content.byteLength, buffer };
      }),
      close,
    } as unknown as Awaited<ReturnType<typeof open>>;
    const scanning = scanLexicalFallback({
      projectRoot: root,
      query: "actualFileNeedle",
      candidatePaths: ["pending.ts"],
      signal: controller.signal,
      fileSystem: { open: (async () => handle) as LexicalFallbackFileSystem["open"] },
    });
    await closeEntered.promise;
    controller.abort();
    await expect(scanning).resolves.toMatchObject({ cancelled: true, results: [], fallbackEvidence: [] });
    expect(close).toHaveBeenCalledOnce();
  }
});

it("initiates owned directory closure for stalled iteration and observes late operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-actual-dir-"));
  await writeFile(join(root, "pending.ts"), "actualDirectoryNeedle\n");

  // A directory arriving after cancellation is closed.
  {
    const controller = new AbortController();
    const entered = deferred();
    const opening = deferred<Awaited<ReturnType<typeof opendir>>>();
    const close = vi.fn(async () => undefined);
    const scanning = scanLexicalFallback({
      projectRoot: root,
      query: "actualDirectoryNeedle",
      signal: controller.signal,
      fileSystem: {
        opendir: (() => {
          entered.resolve();
          return opening.promise;
        }) as LexicalFallbackFileSystem["opendir"],
      },
    });
    await entered.promise;
    controller.abort();
    await expect(scanning).resolves.toMatchObject({ cancelled: true, results: [] });
    opening.resolve({ close } as unknown as Awaited<ReturnType<typeof opendir>>);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  }

  // A never-settling read triggers immediate owned closure; late rejection is observed.
  {
    const controller = new AbortController();
    const readEntered = deferred();
    const reading = deferred<never>();
    const close = vi.fn(async () => undefined);
    const directory = {
      read: vi.fn(() => {
        readEntered.resolve();
        return reading.promise;
      }),
      close,
    } as unknown as Awaited<ReturnType<typeof opendir>>;
    const scanning = scanLexicalFallback({
      projectRoot: root,
      query: "actualDirectoryNeedle",
      signal: controller.signal,
      fileSystem: { opendir: (async () => directory) as LexicalFallbackFileSystem["opendir"] },
    });
    await readEntered.promise;
    controller.abort();
    await expect(scanning).resolves.toMatchObject({ cancelled: true, results: [], fallbackEvidence: [] });
    expect(close).toHaveBeenCalledOnce();
    reading.reject(new Error("late actual directory read rejection"));
    await Promise.resolve();
    await Promise.resolve();
  }
});

it("returns at the logical deadline while a read hook remains stalled", async () => {
  vi.useFakeTimers();
  try {
    const root = await mkdtemp(join(tmpdir(), "repo-context-lexical-hard-deadline-"));
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, "pending.ts"), "deadlineBoundPendingNeedle\n");
    await execFileAsync("git", ["add", "pending.ts"], { cwd: root });
    const entered = deferred();
    const gate = deferred();
    const scanning = scanLexicalFallback({
      projectRoot: root,
      query: "deadlineBoundPendingNeedle",
      candidatePaths: ["pending.ts"],
      limits: { deadlineMs: 25 },
      beforeRead: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(25);
    await expect(scanning).resolves.toMatchObject({
      results: [],
      fallbackEvidence: [],
      capped: false,
      timedOut: true,
      cancelled: false,
    });
    gate.resolve();
  } finally {
    vi.useRealTimers();
  }
});
