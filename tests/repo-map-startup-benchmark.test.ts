import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { RepoMapRuntime } from "../src/repo-map/runtime.js";
import { Telemetry } from "../src/telemetry.js";

const execFileAsync = promisify(execFile);

/**
 * Diagnostic regression for issue #10. The low-latency warm target is <2s on
 * the reference machine, but CI gates deterministic phase/work avoidance—not
 * portable wall-clock timing.
 */
it("avoids full build work on a 3k-file compatible warm generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-context-warm-benchmark-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "repo-context-warm-benchmark-state-"));
  try {
    await mkdir(join(root, "src"));
    const files = 3_000;
    const writes: Promise<void>[] = [];
    for (let index = 0; index < files; index += 1) {
      writes.push(
        writeFile(
          join(root, "src", `file-${index.toString().padStart(4, "0")}.ts`),
          `export const syntheticValue${index} = ${index};\n`,
        ),
      );
    }
    await Promise.all(writes);
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "benchmark@example.invalid"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Benchmark"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: root });

    const coldTelemetry = new Telemetry();
    const coldStarted = performance.now();
    const cold = new RepoMapRuntime({ projectRoot: root, stateRoot, watch: false, telemetry: coldTelemetry });
    await cold.start();
    const coldReadyMs = performance.now() - coldStarted;
    const generation = cold.status().generation;
    await cold.close();

    const warmTelemetry = new Telemetry();
    const snapshotBuilder = vi.fn(async () => {
      throw new Error("warm benchmark unexpectedly entered full build");
    });
    const warmStarted = performance.now();
    const warm = new RepoMapRuntime({
      projectRoot: root,
      stateRoot,
      watch: false,
      telemetry: warmTelemetry,
      snapshotBuilder,
    });
    await warm.start();
    const warmReadyMs = performance.now() - warmStarted;
    const result = await warm.query("syntheticValue2999");
    const evidence = {
      files,
      coldReadyMs: Math.round(coldReadyMs),
      warmReadyMs: Math.round(warmReadyMs),
      cold: coldTelemetry.snapshot(),
      warm: warmTelemetry.snapshot(),
    };
    console.info("repo-map-startup-benchmark", JSON.stringify(evidence));

    expect(snapshotBuilder).not.toHaveBeenCalled();
    expect(result.generation).toBe(generation);
    expect(result.results[0]?.path).toBe("src/file-2999.ts");
    expect(warmTelemetry.snapshot()).toMatchObject({
      hydrationCount: 1,
      hydratedFastReuseCount: 1,
      fullBuildCount: 0,
      filesReindexed: 0,
      generationWriteCount: 0,
      generationCreatedCount: 0,
    });
    await warm.close();
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]);
  }
}, 60_000);
