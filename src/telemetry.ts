/** Bounded repository-only runtime telemetry. No request rows or repository content are retained. */
function finiteNonnegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export interface RepoContextTelemetrySnapshot {
  initializationAttemptCount: number;
  warmupTimeoutCount: number;
  searchAttemptCount: number;
  indexedResultReturnCount: number;
  warmingEmptyReturnCount: number;
  lexicalFallbackAttemptCount: number;
  lexicalFallbackUsedCount: number;
  lexicalFallbackNoMatchCount: number;
  lexicalFallbackCappedCount: number;
  lexicalFallbackTimeoutCount: number;
  lexicalFallbackCancelledCount: number;
  lexicalFallbackMatchedCount: number;
  lexicalFallbackGenuineNoMatchCount: number;
  lexicalFallbackEnumerationTimeoutCount: number;
  lexicalFallbackSourceTimeoutCount: number;
  lexicalFallbackEnumerationPathCapCount: number;
  lexicalFallbackEnumerationByteCapCount: number;
  lexicalFallbackSourceByteCapCount: number;
  lexicalFallbackFileCountCapCount: number;
  lexicalFallbackFilePrefixCapCount: number;
  lexicalFallbackInvalidOutputCount: number;
  lexicalFallbackDurationMsTotal: number;
  lexicalFallbackFilesScanned: number;
  lexicalFallbackBytesScanned: number;
  lexicalFallbackMatchesReturned: number;
  hydrationCount: number;
  hydrationDurationMsTotal: number;
  hydratedFastReuseCount: number;
  fullBuildCount: number;
  fullBuildDurationMsTotal: number;
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
    initializationAttemptCount: 0,
    warmupTimeoutCount: 0,
    searchAttemptCount: 0,
    indexedResultReturnCount: 0,
    warmingEmptyReturnCount: 0,
    lexicalFallbackAttemptCount: 0,
    lexicalFallbackUsedCount: 0,
    lexicalFallbackNoMatchCount: 0,
    lexicalFallbackCappedCount: 0,
    lexicalFallbackTimeoutCount: 0,
    lexicalFallbackCancelledCount: 0,
    lexicalFallbackMatchedCount: 0,
    lexicalFallbackGenuineNoMatchCount: 0,
    lexicalFallbackEnumerationTimeoutCount: 0,
    lexicalFallbackSourceTimeoutCount: 0,
    lexicalFallbackEnumerationPathCapCount: 0,
    lexicalFallbackEnumerationByteCapCount: 0,
    lexicalFallbackSourceByteCapCount: 0,
    lexicalFallbackFileCountCapCount: 0,
    lexicalFallbackFilePrefixCapCount: 0,
    lexicalFallbackInvalidOutputCount: 0,
    lexicalFallbackDurationMsTotal: 0,
    lexicalFallbackFilesScanned: 0,
    lexicalFallbackBytesScanned: 0,
    lexicalFallbackMatchesReturned: 0,
    hydrationCount: 0,
    hydrationDurationMsTotal: 0,
    hydratedFastReuseCount: 0,
    fullBuildCount: 0,
    fullBuildDurationMsTotal: 0,
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
  recordInitializationAttempt(): void {
    this.#values.initializationAttemptCount += 1;
  }
  recordWarmupTimeout(): void {
    this.#values.warmupTimeoutCount += 1;
  }
  recordSearchAttempt(): void {
    this.#values.searchAttemptCount += 1;
  }
  recordIndexedResultReturn(): void {
    this.#values.indexedResultReturnCount += 1;
  }
  recordWarmingEmptyReturn(): void {
    this.#values.warmingEmptyReturnCount += 1;
  }
  recordLexicalFallbackAttempt(): void {
    this.#values.lexicalFallbackAttemptCount += 1;
  }
  recordLexicalFallback(
    result: {
      durationMs: number;
      filesScanned: number;
      bytesScanned: number;
      matchesReturned: number;
      capped: boolean;
      timedOut: boolean;
      cancelled: boolean;
      terminalReason?:
        | "matched"
        | "no-match"
        | "enumeration-timeout"
        | "source-timeout"
        | "enumeration-path-cap"
        | "enumeration-byte-cap"
        | "source-byte-cap"
        | "file-count-cap"
        | "file-prefix-cap"
        | "cancelled"
        | "invalid-scanner-output";
      terminalStage?: "enumeration" | "source" | "complete" | "cancelled" | "output";
    },
    used: boolean,
    returnedMatches = used ? result.matchesReturned : 0,
  ): void {
    this.#values.lexicalFallbackDurationMsTotal += finiteNonnegative(result.durationMs);
    this.#values.lexicalFallbackFilesScanned += finiteNonnegative(result.filesScanned);
    this.#values.lexicalFallbackBytesScanned += finiteNonnegative(result.bytesScanned);
    const safeReturnedMatches = result.cancelled || result.timedOut ? 0 : returnedMatches;
    this.#values.lexicalFallbackMatchesReturned += finiteNonnegative(safeReturnedMatches);
    // Terminal outcome counters are mutually exclusive and ordered by the
    // strongest retirement reason. A timed-out/cancelled scan never counts as
    // used, no-match, or capped even if an injected scanner reports otherwise.
    if (result.cancelled) this.#values.lexicalFallbackCancelledCount += 1;
    else if (result.timedOut) this.#values.lexicalFallbackTimeoutCount += 1;
    else if (result.capped) this.#values.lexicalFallbackCappedCount += 1;
    else if (used) this.#values.lexicalFallbackUsedCount += 1;
    else this.#values.lexicalFallbackNoMatchCount += 1;

    const terminalReason = result.cancelled
      ? "cancelled"
      : result.timedOut
        ? result.terminalStage === "enumeration" || result.terminalReason === "enumeration-timeout"
          ? "enumeration-timeout"
          : "source-timeout"
        : (result.terminalReason ?? (result.capped ? "source-byte-cap" : used ? "matched" : "no-match"));
    switch (terminalReason) {
      case "matched":
        this.#values.lexicalFallbackMatchedCount += 1;
        break;
      case "no-match":
        this.#values.lexicalFallbackGenuineNoMatchCount += 1;
        break;
      case "enumeration-timeout":
        this.#values.lexicalFallbackEnumerationTimeoutCount += 1;
        break;
      case "source-timeout":
        this.#values.lexicalFallbackSourceTimeoutCount += 1;
        break;
      case "enumeration-path-cap":
        this.#values.lexicalFallbackEnumerationPathCapCount += 1;
        break;
      case "enumeration-byte-cap":
        this.#values.lexicalFallbackEnumerationByteCapCount += 1;
        break;
      case "source-byte-cap":
        this.#values.lexicalFallbackSourceByteCapCount += 1;
        break;
      case "file-count-cap":
        this.#values.lexicalFallbackFileCountCapCount += 1;
        break;
      case "file-prefix-cap":
        this.#values.lexicalFallbackFilePrefixCapCount += 1;
        break;
      case "invalid-scanner-output":
        this.#values.lexicalFallbackInvalidOutputCount += 1;
        break;
      case "cancelled":
        break;
    }
  }
  recordHydration(durationMs: number): void {
    this.#values.hydrationCount += 1;
    this.#values.hydrationDurationMsTotal += finiteNonnegative(durationMs);
  }
  recordHydratedFastReuse(): void {
    this.#values.hydratedFastReuseCount += 1;
  }
  recordFullBuild(durationMs: number): void {
    this.#values.fullBuildCount += 1;
    this.#values.fullBuildDurationMsTotal += finiteNonnegative(durationMs);
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
