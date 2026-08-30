import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-static.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { registerRepoContext } = await jiti.import(resolve("src/extension.ts"));
const fixtures = [
  { query: "django.db.models", path: "django/db/models.py", content: "# django.db.models model helpers\n" },
  { query: "catalogSelection", path: "src/catalog.ts", content: "export const catalogSelection = 'source';\n" },
  {
    query: "QuerySet.in_bulk",
    path: "django/query.py",
    content: "def QuerySet_in_bulk(): # QuerySet.in_bulk\n    pass\n",
  },
  { query: "save_base", path: "django/save.py", content: "def save_base(self):\n    return self\n" },
  {
    query: "hydrateFastReuse",
    path: "src/runtime.ts",
    content: "export function hydrateFastReuse() { return true; }\n",
  },
  {
    query: "RepositoryResolver.resolve",
    path: "src/RepositoryResolver.java",
    content: "class RepositoryResolver { void resolve() {} } // RepositoryResolver.resolve\n",
  },
];
const config = {
  enabled: true,
  legacyContextVaultRepoMap: false,
  searchMaxBytes: 6144,
  debounceMs: 300,
  generationRetention: 3,
  quotaBytes: 128 * 1024 * 1024,
  excludePatterns: [],
};
const observations = [];

try {
  for (const [index, fixture] of fixtures.entries()) {
    const root = await mkdtemp(join(tmpdir(), `repo-context-cold-${index}-`));
    await mkdir(join(root, fixture.path.slice(0, fixture.path.lastIndexOf("/"))), { recursive: true });
    await writeFile(join(root, fixture.path), fixture.content);
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi", "excluded.txt"), `${fixture.query} excluded sentinel\n`);
    await writeFile(join(root, "binary.bin"), Buffer.from(`${fixture.query}\0binary sentinel`));
    const events = new Map();
    const tools = new Map();
    let activeTools = [];
    const pi = {
      on(name, handler) {
        const handlers = events.get(name) ?? [];
        handlers.push(handler);
        events.set(name, handlers);
      },
      registerTool(tool) {
        tools.set(tool.name, tool);
        activeTools.push(tool.name);
      },
      registerCommand() {},
      getActiveTools: () => [...activeTools],
      setActiveTools: (next) => {
        activeTools = [...next];
      },
    };
    const never = new Promise(() => {});
    registerRepoContext(pi, {
      resolveProjectState: async () => ({
        projectId: `fixture-${index}`,
        projectRoot: root,
        stateRoot: join(tmpdir(), "repo-context-surrogate-state", `fixture-${index}`),
        mapRoot: join(tmpdir(), "repo-context-surrogate-state", `fixture-${index}`, "repo-map"),
      }),
      loadConfig: async () => config,
      runtimeFactory: () => ({
        start: () => never,
        close: async () => {},
        rebuild: async () => {},
        query: async () => {
          throw new Error("cold surrogate unexpectedly reached indexed query");
        },
        status: () => {
          throw new Error("cold surrogate unexpectedly inspected warming controller");
        },
      }),
      initializationWaiter: async () => "timeout",
    });
    await events.get("session_start")[0]({}, { cwd: root, hasUI: false, ui: {} });
    const started = Date.now();
    const response = await tools
      .get("repo_context_search")
      .execute(`fixture-${index}`, { query: fixture.query, limit: 3 });
    const elapsedMs = Date.now() - started;
    const payload = response.details;
    const bytes = Buffer.byteLength(response.content[0].text, "utf8");
    if (bytes > 6144) throw new Error(`fixture ${index} payload overflow: ${bytes}`);
    if (payload.lifecycle !== "warming" || payload.freshness !== "stale" || payload.generation !== 0)
      throw new Error(`fixture ${index} has non-conservative lifecycle metadata`);
    if (payload.gitHead !== "unavailable" || payload.workspaceRevision !== "unavailable")
      throw new Error(`fixture ${index} claimed an unavailable revision`);
    if (!payload.results.some((row) => row.path === fixture.path))
      throw new Error(`fixture ${index} missing same-call relevant path ${fixture.path}`);
    if (
      !payload.fallbackEvidence.some(
        (row) => row.path === fixture.path && row.excerpt.toLowerCase().includes(fixture.query.toLowerCase()),
      )
    )
      throw new Error(`fixture ${index} missing matching source excerpt`);
    if (
      response.content[0].text.includes(root) ||
      response.content[0].text.includes("excluded sentinel") ||
      response.content[0].text.includes("binary sentinel")
    )
      throw new Error(`fixture ${index} leaked excluded/binary/absolute evidence`);
    observations.push({ run: index + 1, path: fixture.path, elapsedMs, payloadBytes: bytes });
    await rm(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ status: "six-run-cold-first-search-ok", observations }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
