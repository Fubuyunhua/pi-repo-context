/** Bounded repository-only runtime telemetry. No request rows or repository content are retained. */
function finiteNonnegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export interface RepoContextTelemetrySnapshot {
  repoMapQueryCount: number;
  repoMapQueryDurationMsTotal: number;
  ensureFreshCount: number;
  ensureFreshDurationMsTotal: number;
  filesReindexed: number;
  gitHeadCount: number;
  gitHeadDurationMsTotal: number;
  gitDirtyCount: number;
  gitDirtyDurationMsTotal: number;
  gitDiffCount: number;
  gitDiffDurationMsTotal: number;
  searchIndexBuildCount: number;
  searchIndexBuildDurationMsTotal: number;
  generationWriteCount: number;
  generationWriteDurationMsTotal: number;
  generationCreatedCount: number;
  generationBytesWritten: number;
  repoMapTotalBytes: number;
  generationPruneCount: number;
  generationPruneDurationMsTotal: number;
  generationPrunedFiles: number;
  generationPrunedBytes: number;
  maintenanceFailureCount: number;
}

export class RepoContextTelemetry {
  #values: RepoContextTelemetrySnapshot = {
    repoMapQueryCount: 0,
    repoMapQueryDurationMsTotal: 0,
    ensureFreshCount: 0,
    ensureFreshDurationMsTotal: 0,
    filesReindexed: 0,
    gitHeadCount: 0,
    gitHeadDurationMsTotal: 0,
    gitDirtyCount: 0,
    gitDirtyDurationMsTotal: 0,
    gitDiffCount: 0,
    gitDiffDurationMsTotal: 0,
    searchIndexBuildCount: 0,
    searchIndexBuildDurationMsTotal: 0,
    generationWriteCount: 0,
    generationWriteDurationMsTotal: 0,
    generationCreatedCount: 0,
    generationBytesWritten: 0,
    repoMapTotalBytes: 0,
    generationPruneCount: 0,
    generationPruneDurationMsTotal: 0,
    generationPrunedFiles: 0,
    generationPrunedBytes: 0,
    maintenanceFailureCount: 0,
  };

  snapshot(): RepoContextTelemetrySnapshot {
    return { ...this.#values };
  }
  recordRepoMapQuery(durationMs: number): void {
    this.#values.repoMapQueryCount += 1;
    this.#values.repoMapQueryDurationMsTotal += finiteNonnegative(durationMs);
  }
  recordEnsureFresh(durationMs: number): void {
    this.#values.ensureFreshCount += 1;
    this.#values.ensureFreshDurationMsTotal += finiteNonnegative(durationMs);
  }
  recordFileReindexed(): void {
    this.#values.filesReindexed += 1;
  }
  recordGitHead(durationMs: number): void {
    this.#values.gitHeadCount += 1;
    this.#values.gitHeadDurationMsTotal += finiteNonnegative(durationMs);
  }
  recordGitDirty(durationMs: number): void {
    this.#values.gitDirtyCount += 1;
    this.#values.gitDirtyDurationMsTotal += finiteNonnegative(durationMs);
  }
  recordGitDiff(durationMs: number): void {
    this.#values.gitDiffCount += 1;
    this.#values.gitDiffDurationMsTotal += finiteNonnegative(durationMs);
  }
  recordSearchIndexBuild(durationMs = 0): void {
    this.#values.searchIndexBuildCount += 1;
    this.#values.searchIndexBuildDurationMsTotal += finiteNonnegative(durationMs);
  }
  recordGenerationWrite(durationMs: number): void {
    this.#values.generationWriteCount += 1;
    this.#values.generationWriteDurationMsTotal += finiteNonnegative(durationMs);
  }
  recordGenerationFileWritten(bytesWritten: number): void {
    const bytes = finiteNonnegative(bytesWritten);
    this.#values.generationBytesWritten += bytes;
    this.#values.repoMapTotalBytes += bytes;
  }
  recordGenerationActivated(): void {
    this.#values.generationCreatedCount += 1;
  }
  recordGenerationCreated(bytesWritten: number): void {
    this.recordGenerationFileWritten(bytesWritten);
    this.recordGenerationActivated();
  }
  recordRepoMapTotalBytes(totalBytes: number): void {
    this.#values.repoMapTotalBytes = finiteNonnegative(totalBytes);
  }
  recordGenerationPrune(durationMs: number, filesPruned: number, bytesPruned: number): void {
    const files = finiteNonnegative(filesPruned);
    const bytes = finiteNonnegative(bytesPruned);
    this.#values.generationPruneCount += 1;
    this.#values.generationPruneDurationMsTotal += finiteNonnegative(durationMs);
    this.#values.generationPrunedFiles += files;
    this.#values.generationPrunedBytes += bytes;
    this.#values.repoMapTotalBytes = Math.max(0, this.#values.repoMapTotalBytes - bytes);
  }
  recordMaintenanceFailure(): void {
    this.#values.maintenanceFailureCount += 1;
  }
}

/** Compatibility name retained only inside the extracted core/tests. */
export { RepoContextTelemetry as Telemetry };
