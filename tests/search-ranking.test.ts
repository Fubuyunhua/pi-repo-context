import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type RepoMapFile, RepoMapSearch, type RepoMapSnapshot } from "../src/repo-map/index.js";

interface GoldFile {
  path: string;
  terms: string;
  symbols?: string[];
  exports?: string[];
}

interface GoldProject {
  files: GoldFile[];
}

interface SearchRankingGold {
  django: GoldProject & {
    query: string;
    implementation: string;
    vendor: string;
    minified: string;
    explicitMinifiedQuery: string;
  };
  sphinx: GoldProject & {
    query: string;
    implementation: string;
    qualifiedQuery: string;
    qualifiedImplementation: string;
    exactQuery: string;
    exactImplementation: string;
  };
  symbols: GoldProject;
}

const gold = JSON.parse(
  readFileSync(new URL("./fixtures/search-ranking-gold.json", import.meta.url), "utf8"),
) as SearchRankingGold;

function repoFile(input: GoldFile): RepoMapFile {
  const symbols = (input.symbols ?? []).map((name, index) => ({
    name,
    kind: "class" as const,
    signature: `class ${name}`,
    exported: input.exports?.includes(name) ?? false,
    line: index + 1,
  }));
  return {
    path: input.path,
    kind: symbols.length > 0 ? "semantic" : "lexical",
    language: symbols.length > 0 ? "typescript" : "text",
    contentHash: input.path.padEnd(64, "0").slice(0, 64),
    sizeBytes: input.terms.length,
    lexicalTerms: input.terms.split(" "),
    imports: [],
    exports: (input.exports ?? []).map((name) => ({ name, typeOnly: false })),
    symbols,
    dependencies: [],
  };
}

function snapshot(files: GoldFile[]): RepoMapSnapshot {
  return {
    schemaVersion: 1,
    provenance: {
      generator: "pi-repo-context",
      generatorVersion: "0.1.0",
      parser: "typescript-compiler-api",
      typescriptVersion: "5.9.3",
      generatedAt: "2026-08-29T00:00:00.000Z",
      projectRoot: "/gold/repository",
    },
    files: files.map(repoFile),
    warnings: [],
  };
}

function indexOfPath(paths: string[], path: string): number {
  const index = paths.indexOf(path);
  expect(index, `expected ${path} in ${paths.join(", ")}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("repository search ranking gold queries", () => {
  it("puts Django QuerySet.in_bulk implementation in the top three above vendor and minified noise", () => {
    const search = new RepoMapSearch(snapshot(gold.django.files));
    const topThree = search.query(gold.django.query, { limit: 3 });
    const results = search.query(gold.django.query, { limit: gold.django.files.length });
    const paths = results.map((result) => result.path);
    const implementationIndex = indexOfPath(paths, gold.django.implementation);

    expect(topThree.map((result) => result.path)).toContain(gold.django.implementation);
    expect(implementationIndex).toBeLessThan(3);
    expect(indexOfPath(paths, gold.django.vendor)).toBeGreaterThan(implementationIndex);
    expect(indexOfPath(paths, gold.django.minified)).toBeGreaterThan(implementationIndex);
    expect(results[implementationIndex]?.matchReasons).toContain("exact identifier: in_bulk, field_name");
  });

  it("keeps an explicitly requested minified path retrievable", () => {
    const results = new RepoMapSearch(snapshot(gold.django.files)).query(gold.django.explicitMinifiedQuery, {
      limit: 3,
    });

    expect(results.map((result) => result.path)).toContain(gold.django.minified);
    expect(results.find((result) => result.path === gold.django.minified)?.matchReasons).not.toContain(
      "de-boosted minified",
    );
  });

  it("puts Sphinx HTML signature implementation in the top three above locale catalogs", () => {
    const search = new RepoMapSearch(snapshot(gold.sphinx.files));
    const topThree = search.query(gold.sphinx.query, { limit: 3 });
    const results = search.query(gold.sphinx.query, { limit: gold.sphinx.files.length });
    const paths = results.map((result) => result.path);
    const implementationIndex = indexOfPath(paths, gold.sphinx.implementation);
    const firstLocaleIndex = paths.findIndex((path) => path.includes("/locale/"));

    expect(topThree.map((result) => result.path)).toContain(gold.sphinx.implementation);
    expect(implementationIndex).toBeLessThan(3);
    expect(firstLocaleIndex).toBeGreaterThan(implementationIndex);
    expect(results[firstLocaleIndex]?.matchReasons).toContain("de-boosted locale-catalog");
  });

  it("keeps qualified-path and established exact-query regressions top-ranked", () => {
    const search = new RepoMapSearch(snapshot(gold.sphinx.files));

    expect(search.query(gold.sphinx.qualifiedQuery, { limit: 3 })[0]?.path).toBe(gold.sphinx.qualifiedImplementation);
    expect(search.query(gold.sphinx.exactQuery, { limit: 3 })[0]?.path).toBe(gold.sphinx.exactImplementation);
  });

  it("boosts exact symbols and exports while bounding match reasons", () => {
    const result = new RepoMapSearch(snapshot(gold.symbols.files)).query("QuerySet", { limit: 2 })[0];

    expect(result?.path).toBe("src/query-set.ts");
    expect(result?.matchedSymbols).toEqual(["QuerySet"]);
    expect(result?.matchReasons).toEqual(expect.arrayContaining(["exact symbol: QuerySet", "exact export: QuerySet"]));
    expect(result?.matchReasons?.length).toBeLessThanOrEqual(5);
  });

  it("returns deterministic results with path-ordered score ties", () => {
    const search = new RepoMapSearch(snapshot(gold.symbols.files));
    const first = search.query("deterministic_tie_marker", { limit: 4 });

    expect(search.query("deterministic_tie_marker", { limit: 4 })).toEqual(first);
    expect(first.map((result) => result.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
