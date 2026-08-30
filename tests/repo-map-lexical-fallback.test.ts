import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { LEXICAL_FALLBACK_LIMITS, scanLexicalFallback } from "../src/repo-map/lexical-fallback.js";

const execFileAsync = promisify(execFile);

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
