import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pi-repo-context-package-"));
const npmCli = process.env.npm_execpath;
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
try {
  if (!npmCli) throw new Error("package smoke must run through npm");
  const packed = JSON.parse(run(process.execPath, [npmCli, "pack", "--json", "--pack-destination", scratch]))[0];
  const files = new Set(packed.files.map((entry) => entry.path));
  for (const required of [
    "extensions/index.ts",
    "src/extension.ts",
    "src/repo-map/index.ts",
    "src/repo-map/graph.ts",
    "src/repo-map/snapshot.ts",
    "docs/specs/0016-repository-graph-contract.md",
    "README.md",
    "LICENSE",
  ])
    if (!files.has(required)) throw new Error(`packed artifact missing ${required}`);
  for (const forbidden of [
    "src/artifacts/",
    "src/observations/",
    "src/context/",
    "src/bench/",
    "src/repo-context/",
    "tests/",
    "docs/reports/",
  ]) {
    if ([...files].some((file) => file.startsWith(forbidden))) throw new Error(`packed artifact includes ${forbidden}`);
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
  const packedRoot = join(install, "node_modules", "pi-repo-context");
  const manifest = JSON.parse(readFileSync(join(packedRoot, "package.json"), "utf8"));
  if (manifest.name !== "pi-repo-context" || manifest.version !== "0.1.0")
    throw new Error("installed package identity mismatch");
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
