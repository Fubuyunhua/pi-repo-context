import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pi-repo-context-package-"));
const npmCli = process.env.npm_execpath;
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
const MANIFEST_FILE_ALLOWLIST = [
  "extensions/index.ts",
  "src/extension.ts",
  "src/repo-map/canonical.ts",
  "src/repo-map/graph.ts",
  "src/repo-map/index.ts",
  "src/repo-map/java.ts",
  "src/repo-map/runtime.ts",
  "src/repo-map/snapshot.ts",
  "src/state/atomic.ts",
  "src/state/config.ts",
  "src/state/owned-state.ts",
  "src/state/project-state.ts",
  "src/telemetry.ts",
  "docs/MIGRATION.md",
  "docs/releases/v0.1.0.md",
  "docs/specs/0005-bounded-repo-map-generations.md",
  "docs/specs/0006-repo-map-file-outcomes.md",
  "docs/specs/0007-cached-repo-map-search.md",
  "docs/specs/0009-turn-start-snapshot-semantics.md",
  "docs/specs/0016-repository-graph-contract.md",
  "docs/specs/README.md",
  "README.md",
  "LICENSE",
];
const PACKED_FILE_ALLOWLIST = [...MANIFEST_FILE_ALLOWLIST, "package.json"].sort();

function assertDependencyAbsent(tree, forbidden) {
  const visit = (node, ancestry) => {
    if (node?.name === forbidden) throw new Error(`dependency tree contains ${forbidden} at ${ancestry}`);
    for (const [name, dependency] of Object.entries(node?.dependencies ?? {})) {
      const next = `${ancestry}>${name}`;
      if (name === forbidden) throw new Error(`dependency tree contains ${forbidden} at ${next}`);
      visit(dependency, next);
    }
  };
  visit(tree, "root");
}

try {
  if (!npmCli) throw new Error("package smoke must run through npm");
  const packed = JSON.parse(run(process.execPath, [npmCli, "pack", "--json", "--pack-destination", scratch]))[0];
  const packedFiles = packed.files.map((entry) => entry.path).sort();
  if (JSON.stringify(packedFiles) !== JSON.stringify(PACKED_FILE_ALLOWLIST)) {
    throw new Error(
      `packed file allowlist mismatch\nexpected=${JSON.stringify(PACKED_FILE_ALLOWLIST)}\nactual=${JSON.stringify(packedFiles)}`,
    );
  }
  const install = join(scratch, "install");
  mkdirSync(install, { recursive: true });
  writeFileSync(join(install, "package.json"), '{"name":"repo-context-smoke","private":true}\n');
  run(
    process.execPath,
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      join(scratch, packed.filename),
      "@earendil-works/pi-coding-agent@0.84.1",
      "typebox@1.3.7",
    ],
    install,
  );
  const dependencyTree = JSON.parse(run(process.execPath, [npmCli, "ls", "--all", "--json"], install));
  assertDependencyAbsent(dependencyTree, "pi-context-vault");
  const packedRoot = join(install, "node_modules", "pi-repo-context");
  const manifest = JSON.parse(readFileSync(join(packedRoot, "package.json"), "utf8"));
  if (manifest.name !== "pi-repo-context" || manifest.version !== "0.1.0")
    throw new Error("installed package identity mismatch");
  if (JSON.stringify([...manifest.files].sort()) !== JSON.stringify([...MANIFEST_FILE_ALLOWLIST].sort()))
    throw new Error("installed package manifest file allowlist mismatch");
  const expectedPeers = { "@earendil-works/pi-coding-agent": "0.84.1", typebox: "1.3.7" };
  if (JSON.stringify(manifest.peerDependencies) !== JSON.stringify(expectedPeers))
    throw new Error(`installed package peer mismatch: ${JSON.stringify(manifest.peerDependencies)}`);
  if (existsSync(join(install, "node_modules", "pi-context-vault")))
    throw new Error("package smoke unexpectedly installed pi-context-vault");

  const loader = join(install, "load-packed-extension.mjs");
  writeFileSync(
    loader,
    `import{pathToFileURL}from"node:url";\nconst{createJiti}=await import(pathToFileURL(process.argv[3]).href);\nconst jiti=createJiti(import.meta.url,{moduleCache:false});\nconst factory=await jiti.import(process.argv[2],{default:true});\nif(typeof factory!=="function")throw new Error("packed extension has no default factory");\nconst events=[],tools=[],commands=[];\nfactory({on:(name)=>events.push(name),registerTool:(tool)=>tools.push(tool.name),registerCommand:(name)=>commands.push(name)});\nconst actual={events,tools:tools.sort(),commands};\nconst expected={events:["session_start","session_shutdown"],tools:["context_vault_repo_map","repo_context_search","repo_context_status"],commands:["repo-context"]};\nif(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error("unexpected packed registration: "+JSON.stringify(actual));\nif(events.some((name)=>["before_agent_start","context","tool_result"].includes(name)))throw new Error("packed extension registered injection hook");\nconsole.log("packed-extension-registration-ok");\n`,
  );
  const jiti = join(
    install,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
    "jiti",
    "lib",
    "jiti-static.mjs",
  );
  if (!existsSync(jiti)) throw new Error("installed Pi peer does not provide its approved TypeScript loader");
  const loaded = run(process.execPath, [loader, join(packedRoot, "extensions", "index.ts"), jiti], install);
  if (!loaded.includes("packed-extension-registration-ok")) throw new Error("packed extension did not load");
  console.log("packed-repo-context-install-load-ok");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
