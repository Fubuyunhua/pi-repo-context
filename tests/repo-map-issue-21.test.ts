import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  discriminativeStructuredAnchors,
  LEXICAL_FALLBACK_LIMITS,
  scanLexicalFallback,
} from "../src/repo-map/lexical-fallback.js";

const execFileAsync = promisify(execFile);
const TARGET = "django/template/library.py";
const QUERIES = [
  "simple_tag received unexpected keyword argument parse_bits keyword-only defaults",
  "simple_tag received unexpected keyword argument parse_bits keyword-only defaults inclusion_tag",
  "received unexpected keyword argument simple_tag parse_bits keyword-only defaults",
  "TemplateSyntaxError received unexpected keyword argument simple_tag parse_bits keyword-only defaults",
] as const;

let root = "";
let firstPathAfterTargetBatch = "";

async function writeBatch(entries: Array<[string, string]>): Promise<void> {
  await Promise.all(
    entries.map(async ([path, content]) => {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }),
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-repo-context-issue-21-"));
  const entries: Array<[string, string]> = [];
  for (let index = 0; index < 600; index += 1) {
    entries.push([
      `aaa/decoy-${String(index).padStart(4, "0")}.txt`,
      "received unexpected keyword argument defaults\n",
    ]);
  }
  entries.push([
    TARGET,
    [
      "class TemplateSyntaxError(Exception):",
      "    pass",
      "def parse_bits(parser, bits, params, varargs, varkw, defaults, kwonly, kwonly_defaults):",
      "    raise TemplateSyntaxError('received unexpected keyword argument')",
      "def simple_tag(func=None, takes_context=None, name=None):",
      "    return parse_bits",
    ].join("\n"),
  ]);
  for (let index = 0; index < 4_284; index += 1) {
    entries.push([`zzz/extra-${String(index).padStart(4, "0")}.txt`, "ordinary repository fixture content\n"]);
  }
  expect(entries).toHaveLength(4_885);
  for (let offset = 0; offset < entries.length; offset += 128) await writeBatch(entries.slice(offset, offset + 128));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const { stdout } = await execFileAsync("git", ["ls-files"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const paths = stdout.trim().split("\n");
  expect(paths).toHaveLength(4_885);
  const targetIndex = paths.indexOf(TARGET);
  expect(targetIndex).toBeGreaterThan(0);
  const nextBatchOffset =
    targetIndex + (LEXICAL_FALLBACK_LIMITS.concurrency - (targetIndex % LEXICAL_FALLBACK_LIMITS.concurrency));
  firstPathAfterTargetBatch = paths[nextBatchOffset] ?? "";
}, 60_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it.each([
  "received unexpected keyword argument defaults",
  "read-only keyword-only well-known",
  "high-level real-world end-to-end user-facing",
])("rejects open-ended generic prose without a denylist: %s", (query) => {
  expect(discriminativeStructuredAnchors(query)).toEqual([]);
});

it.each([
  ["pkg.foo pkg.foo.bar", ["pkg.foo.bar"]],
  ["parse_bits parse_bits parse_bits", ["parse_bits"]],
  ["pkg.foo.bar pkg.foo pkg.foo.bar OtherThing", ["pkg.foo.bar", "otherthing"]],
  ["parse_bits simple_tag", ["parse_bits", "simple_tag"]],
  ["pkg.render camelCase worker-2", ["pkg.render", "camelcase", "worker-2"]],
  [
    "simple_tag pkg.parse_bits render-item TemplateSyntaxError",
    ["templatesyntaxerror", "pkg.parse_bits", "simple_tag"],
  ],
] as const)("retains only independent structured anchor families: %s", (query, expected) => {
  expect(discriminativeStructuredAnchors(query)).toEqual(expected);
});

it.each(QUERIES)(
  "returns completed paired target evidence for broad cold query: %s",
  async (query) => {
    let postTargetBatchStarted = false;
    const scan = await scanLexicalFallback({
      projectRoot: root,
      query,
      limit: 10,
      beforeRead: async () => undefined,
      operationHook: async (stage, absolutePath) => {
        const path = relative(root, absolutePath).replaceAll("\\", "/");
        if (stage === "before-read" && firstPathAfterTargetBatch && path >= firstPathAfterTargetBatch) {
          postTargetBatchStarted = true;
          await new Promise<void>(() => {});
        }
      },
    });

    expect(postTargetBatchStarted).toBe(false);
    expect(scan).toMatchObject({
      terminalReason: "matched",
      terminalStage: "complete",
      timedOut: false,
      cancelled: false,
      capped: false,
      enumeratedPaths: 4_885,
    });
    expect(scan.filesScanned).toBeLessThanOrEqual(4_885);
    expect(scan.bytesScanned).toBeLessThanOrEqual(LEXICAL_FALLBACK_LIMITS.maxSourceBytes);
    expect(scan.results[0]?.path).toBe(TARGET);
    expect(scan.fallbackEvidence[0]).toMatchObject({ kind: "source", path: TARGET });
    expect(scan.fallbackEvidence[0]?.excerpt).toMatch(/parse_bits|simple_tag|TemplateSyntaxError/iu);
    expect(
      scan.results.every((result) => scan.fallbackEvidence.some((evidence) => evidence.path === result.path)),
    ).toBe(true);
  },
  20_000,
);
