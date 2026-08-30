import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { RepoMapRuntime } from "../../src/repo-map/runtime.ts";
import { Telemetry } from "../../src/telemetry.ts";

const files = Number(process.argv[2]);
if (![100, 1000, 5000].includes(files)) throw new Error("usage: phase-a-repo-scale.ts 100|1000|5000");
const projectRoot = await mkdtemp(join(tmpdir(), `phase-a-repo-${files}-`));
const stateRoot = await mkdtemp(join(tmpdir(), `phase-a-repo-state-${files}-`));
const src = join(projectRoot, "src");
const filePath = (index: number) => join(src, `file-${String(index).padStart(5, "0")}.ts`);
const fileText = (index: number, marker = "") => `export function syntheticSymbol${index}() { return ${index}; }\n${marker}\n`;
async function treeBytes(path: string): Promise<number> { let total=0;for(const name of await readdir(path)){const child=join(path,name);const info=await stat(child);total+=info.isDirectory()?await treeBytes(child):info.size;}return total; }
async function stage<T>(name: string, fn: () => Promise<T>) { const cpu=process.cpuUsage();const rssBefore=process.memoryUsage().rss;const start=performance.now();const value=await fn();const elapsedMs=performance.now()-start;const used=process.cpuUsage(cpu);const rssAfter=process.memoryUsage().rss;Bun.gc(true);const memoryAfterGc=process.memoryUsage();return {name,elapsedMs:Number(elapsedMs.toFixed(2)),cpuUserMs:Number((used.user/1000).toFixed(2)),cpuSystemMs:Number((used.system/1000).toFixed(2)),rssBefore,rssAfter,rssAfterGc:memoryAfterGc.rss,heapUsedAfterGc:memoryAfterGc.heapUsed,externalAfterGc:memoryAfterGc.external,arrayBuffersAfterGc:memoryAfterGc.arrayBuffers,maxRssKb:process.resourceUsage().maxRSS,value}; }
try {
  await mkdir(src);
  await Promise.all(Array.from({length:files},(_,index)=>writeFile(filePath(index),fileText(index))));
  const coldTelemetry=new Telemetry();let cold:any=new RepoMapRuntime({projectRoot,stateRoot,watch:false,telemetry:coldTelemetry});
  const coldStart=await stage("coldStart",()=>cold.start());
  const coldQuery=await stage("coldQuery",()=>cold.query(`syntheticSymbol${files-1}`));
  const coldStatus=cold.status();await cold.close();cold=undefined;Bun.gc(true);
  const warmTelemetry=new Telemetry();const warm=new RepoMapRuntime({projectRoot,stateRoot,watch:false,telemetry:warmTelemetry});
  const warmStart=await stage("warmStart",()=>warm.start());
  const warmQuery=await stage("warmQuery",()=>warm.query(`syntheticSymbol${files-1}`));
  await writeFile(filePath(files-1),fileText(files-1,"export const UPDATED_ONE_MARKER = true;"));warm.notify("change",`src/file-${String(files-1).padStart(5,"0")}.ts`);
  const incrementalOne=await stage("incrementalOne",()=>warm.query("UPDATED_ONE_MARKER"));
  const batch=Math.min(100,files);await Promise.all(Array.from({length:batch},(_,index)=>writeFile(filePath(index),fileText(index,`export const BATCH_MARKER_${index} = true;`))));for(let index=0;index<batch;index++)warm.notify("change",`src/file-${String(index).padStart(5,"0")}.ts`);
  const incrementalHundred=await stage("incrementalHundred",()=>warm.query(`BATCH_MARKER_${batch-1}`));
  const statusAfterIncrementalHundred=warm.status();
  const incrementalHundredRetry=await stage("incrementalHundredRetry",()=>warm.query(`BATCH_MARKER_${batch-1}`));
  const warmStatus=warm.status();await warm.close();
  console.log(JSON.stringify({generatedAt:new Date().toISOString(),files,stateBytes:await treeBytes(stateRoot),coldStatus:{generation:coldStatus.generation,freshness:coldStatus.freshness,indexedFiles:coldStatus.files,workspaceRevision:coldStatus.workspaceRevision},warmStatus:{generation:warmStatus.generation,freshness:warmStatus.freshness,indexedFiles:warmStatus.files,workspaceRevision:warmStatus.workspaceRevision},queries:{coldTop:coldQuery.value.results[0]?.path,warmTop:warmQuery.value.results[0]?.path,incrementalOneTop:incrementalOne.value.results[0]?.path,incrementalHundredTop:incrementalHundred.value.results[0]?.path,incrementalHundredRetryTop:incrementalHundredRetry.value.results[0]?.path,incrementalHundredFallbackEvidence:incrementalHundred.value.fallbackEvidence,incrementalHundredResults:incrementalHundred.value.results.slice(0,10).map((result:any)=>({path:result.path,score:result.score,matchedSymbols:result.matchedSymbols,matchReasons:result.matchReasons}))},statusAfterIncrementalHundred:{generation:statusAfterIncrementalHundred.generation,freshness:statusAfterIncrementalHundred.freshness,pendingFiles:statusAfterIncrementalHundred.pendingFiles},stages:[coldStart,coldQuery,warmStart,warmQuery,incrementalOne,incrementalHundred,incrementalHundredRetry].map(({value,...row})=>row),telemetry:{cold:coldTelemetry.snapshot(),warm:warmTelemetry.snapshot()}},null,2));
} finally { await Promise.all([rm(projectRoot,{recursive:true,force:true}),rm(stateRoot,{recursive:true,force:true})]); }
