import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { RepoMapQueryResult } from "./index.js";
import { linkedIdentifierTokens, repoMapPathExclusionMatcher, rootGitignoreMatcher } from "./index.js";
import type { RepoMapFallbackEvidence } from "./runtime.js";

export interface LexicalFallbackLimits {
  deadlineMs: number;
  maxEnumeratedPaths: number;
  maxEnumerationBytes: number;
  maxIgnoreBytes: number;
  maxExcludePatterns: number;
  maxExcludeBytes: number;
  maxFiles: number;
  maxSourceBytes: number;
  maxFileBytes: number;
  concurrency: number;
  maxResults: number;
  maxExcerptBytes: number;
}

export const LEXICAL_FALLBACK_LIMITS: Readonly<LexicalFallbackLimits> = Object.freeze({
  deadlineMs: 2_000,
  maxEnumeratedPaths: 100_000,
  maxEnumerationBytes: 8 * 1024 * 1024,
  maxIgnoreBytes: 256 * 1024,
  maxExcludePatterns: 256,
  maxExcludeBytes: 64 * 1024,
  maxFiles: 20_000,
  maxSourceBytes: 32 * 1024 * 1024,
  maxFileBytes: 512 * 1024,
  concurrency: 4,
  maxResults: 20,
  maxExcerptBytes: 512,
});

export type LexicalFallbackOperationStage =
  | "directory-open"
  | "directory-read"
  | "directory-close"
  | "lstat"
  | "realpath"
  | "before-open"
  | "open"
  | "stat"
  | "before-read"
  | "read"
  | "close";

export interface LexicalFallbackOptions {
  projectRoot: string;
  query: string;
  limit?: number;
  exclude?: string[];
  signal?: AbortSignal;
  limits?: Partial<LexicalFallbackLimits>;
  /**
   * An explicit, bounded path set. This mode is used by a live stale query and
   * never expands beyond the supplied paths.
   */
  candidatePaths?: readonly string[];
  /** Test-only race hook invoked after identity capture and before open. */
  beforeOpen?: (path: string) => Promise<void>;
  /** Test-only race hook invoked after handle identity validation and before read. */
  beforeRead?: (path: string) => Promise<void>;
  /** Test-only operation hook used to gate hard-bound cancellation stages. */
  operationHook?: (stage: LexicalFallbackOperationStage, path: string) => Promise<void>;
}

export interface LexicalFallbackScanResult {
  results: RepoMapQueryResult[];
  fallbackEvidence: RepoMapFallbackEvidence[];
  /** Candidate paths conclusively classified by admission or a complete read. */
  conclusivePaths?: string[];
  /** Candidate paths whose admission/read could not be concluded safely. */
  unresolvedPaths?: string[];
  durationMs: number;
  filesScanned: number;
  bytesScanned: number;
  enumeratedPaths: number;
  enumerationBytes: number;
  matchesReturned: number;
  capped: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

interface EnumerationResult {
  paths: string[];
  observedPaths: number;
  bytes: number;
  capped: boolean;
  cancelled: boolean;
  git: boolean;
  conclusiveExcludedPaths?: string[];
  unresolvedPaths?: string[];
}

interface CandidateRead {
  text?: string;
  bytes: number;
  capped: boolean;
  outcome: "text" | "conclusive" | "unresolved";
}

interface CandidateMatch {
  path: string;
  score: number;
  coverage: number;
  exact: boolean;
  evidenceKind: "source" | "warming";
  excerpt: string;
}

const ABORTED = Symbol("lexical-fallback-aborted");
type Aborted = typeof ABORTED;
type OperationHook = LexicalFallbackOptions["operationHook"];

/** Race logical completion against cancellation while observing every late settlement. */
function abortRace<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void | Promise<void>,
): Promise<T | Aborted> {
  if (signal.aborted) {
    void operation.then(onLateValue, () => undefined).catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolveResult, rejectResult) => {
    let retired = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      retired = true;
      cleanup();
      resolveResult(ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        if (retired) {
          void Promise.resolve()
            .then(() => onLateValue?.(value))
            .catch(() => undefined);
          return;
        }
        cleanup();
        resolveResult(value);
      },
      (error) => {
        if (retired) return;
        cleanup();
        rejectResult(error);
      },
    );
  });
}

async function operationGate(
  hook: OperationHook,
  stage: LexicalFallbackOperationStage,
  path: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (!hook) return !signal.aborted;
  return (
    (await abortRace(
      Promise.resolve().then(() => hook(stage, path)),
      signal,
    )) !== ABORTED
  );
}

/** Start the real operation before a test gate, then hard-race its result. */
async function stagedOperation<T>(
  hook: OperationHook,
  stage: LexicalFallbackOperationStage,
  path: string,
  signal: AbortSignal,
  start: () => Promise<T>,
  onLateValue?: (value: T) => void | Promise<void>,
  startWhenAborted = false,
): Promise<T | Aborted> {
  if (signal.aborted && !startWhenAborted) return ABORTED;
  const operation = Promise.resolve().then(start);
  // Observe rejection immediately even when a test gate retains the result.
  void operation.catch(() => undefined);
  try {
    if (!(await operationGate(hook, stage, path, signal))) {
      void abortRace(operation, signal, onLateValue);
      return ABORTED;
    }
  } catch (error) {
    void operation
      .then(
        (value) => onLateValue?.(value),
        () => undefined,
      )
      .catch(() => undefined);
    throw error;
  }
  return abortRace(operation, signal, onLateValue);
}

function slash(path: string): string {
  return path.split(sep).join("/");
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "";
}

function stablePathCompare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function safeRelativePath(path: string): boolean {
  return Boolean(path) && !path.startsWith("/") && !path.split("/").some((segment) => segment === "..");
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function matchCenteredExcerpt(text: string, matchIndex: number, matchLength: number, maxBytes: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, matchIndex - 1)) + 1;
  const lineEndIndex = text.indexOf("\n", matchIndex + matchLength);
  const lineEnd = lineEndIndex < 0 ? text.length : lineEndIndex;
  const previousStart = lineStart > 0 ? text.lastIndexOf("\n", Math.max(0, lineStart - 2)) + 1 : lineStart;
  const nextEndIndex = text.indexOf("\n", lineEnd + 1);
  const nextEnd = nextEndIndex < 0 ? lineEnd : nextEndIndex;
  const contextual = text.slice(previousStart, nextEnd).trim();
  if (Buffer.byteLength(contextual, "utf8") <= maxBytes) return contextual;

  const line = text.slice(lineStart, lineEnd);
  const inLineIndex = Math.max(0, matchIndex - lineStart);
  const lineBytes = Buffer.from(line, "utf8");
  const matchByte = Buffer.byteLength(line.slice(0, inLineIndex), "utf8");
  const matchBytes = Math.max(1, Buffer.byteLength(line.slice(inLineIndex, inLineIndex + matchLength), "utf8"));
  let start = Math.max(0, matchByte - Math.floor((maxBytes - Math.min(matchBytes, maxBytes)) / 2));
  while (start < lineBytes.byteLength && (lineBytes[start] & 0xc0) === 0x80) start += 1;
  let end = Math.min(lineBytes.byteLength, start + maxBytes);
  while (end > start && end < lineBytes.byteLength && (lineBytes[end] & 0xc0) === 0x80) end -= 1;
  if (end <= matchByte && matchByte < lineBytes.byteLength) {
    start = Math.max(0, matchByte - Math.floor(maxBytes / 2));
    while (start < matchByte && (lineBytes[start] & 0xc0) === 0x80) start += 1;
    end = Math.min(lineBytes.byteLength, start + maxBytes);
    while (end > start && end < lineBytes.byteLength && (lineBytes[end] & 0xc0) === 0x80) end -= 1;
  }
  return lineBytes.subarray(start, end).toString("utf8").trim();
}

function queryTerms(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  return [...new Set([normalized, ...linkedIdentifierTokens(query).map((term) => term.toLowerCase())])]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length || stablePathCompare(left, right));
}

function scoreCandidate(
  path: string,
  text: string,
  terms: readonly string[],
  query: string,
  maxExcerptBytes: number,
): CandidateMatch | undefined {
  const lowerPath = path.toLowerCase();
  const lowerText = text.toLowerCase();
  const matched = terms.filter((term) => lowerPath.includes(term) || lowerText.includes(term));
  if (matched.length === 0) return undefined;
  const normalizedQuery = query.trim().toLowerCase();
  const exactPath = normalizedQuery.length > 0 && lowerPath.includes(normalizedQuery);
  const exactTextIndex = normalizedQuery.length > 0 ? lowerText.indexOf(normalizedQuery) : -1;
  const pathCoverage = matched.filter((term) => lowerPath.includes(term)).length;
  const excerptTerm =
    exactTextIndex >= 0
      ? normalizedQuery
      : (matched.find((term) => lowerText.includes(term) && (term === normalizedQuery || term.length >= 3)) ??
        (pathCoverage === 0 ? matched.find((term) => lowerText.includes(term)) : undefined));
  const matchIndex = excerptTerm ? lowerText.indexOf(excerptTerm) : -1;
  const excerpt =
    matchIndex >= 0 && excerptTerm
      ? matchCenteredExcerpt(text, matchIndex, excerptTerm.length, maxExcerptBytes)
      : utf8Prefix(`Path matched query terms: ${path}`, maxExcerptBytes);
  const basenameExact = basename(lowerPath, extname(lowerPath)) === normalizedQuery;
  return {
    path,
    coverage: matched.length,
    exact: exactTextIndex >= 0 || exactPath,
    evidenceKind: matchIndex >= 0 ? "source" : "warming",
    score:
      matched.length * 100 +
      pathCoverage * 25 +
      (exactTextIndex >= 0 ? 60 : 0) +
      (exactPath ? 80 : 0) +
      (basenameExact ? 100 : 0),
    excerpt,
  };
}

function spawnGitCandidateAdmission(
  projectRoot: string,
  signal: AbortSignal,
  limits: Readonly<LexicalFallbackLimits>,
  candidatePaths: readonly string[],
): Promise<EnumerationResult | undefined> {
  return new Promise((resolveEnumeration) => {
    const paths: string[] = [];
    let bytes = 0;
    let observedOutputPaths = 0;
    let buffered = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let capped = false;
    let finished = false;
    const admitted = new Set(candidatePaths);
    const child = spawn(
      "git",
      ["-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: projectRoot,
        env: { ...process.env, LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      },
    );
    const finish = (result: EnumerationResult | undefined) => {
      if (finished) return;
      finished = true;
      resolveEnumeration(result);
    };
    child.on("error", (error) => {
      if (signal.aborted || error.name === "AbortError") {
        finish({ paths: [], observedPaths: candidatePaths.length, bytes: 0, capped, cancelled: true, git: true });
      } else {
        // A missing/broken Git executable is ambiguous, so candidate admission
        // fails closed rather than silently using non-Git ignore semantics.
        finish({
          paths: [],
          observedPaths: candidatePaths.length,
          bytes: 0,
          capped: true,
          cancelled: false,
          git: true,
        });
      }
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (finished) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (bytes + buffered.byteLength > limits.maxEnumerationBytes) {
        capped = true;
        child.kill();
        return;
      }
      let separator = buffered.indexOf(0);
      while (separator >= 0) {
        const raw = buffered.subarray(0, separator);
        buffered = buffered.subarray(separator + 1);
        const pathBytes = raw.byteLength + 1;
        if (observedOutputPaths >= limits.maxEnumeratedPaths || bytes + pathBytes > limits.maxEnumerationBytes) {
          capped = true;
          child.kill();
          break;
        }
        observedOutputPaths += 1;
        bytes += pathBytes;
        const path = slash(raw.toString("utf8"));
        if (safeRelativePath(path) && admitted.has(path)) paths.push(path);
        separator = buffered.indexOf(0);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.byteLength < 4_096) stderr = Buffer.concat([stderr, chunk]).subarray(0, 4_096);
    });
    child.on("close", (code) => {
      if (signal.aborted) {
        finish({ paths: [], observedPaths: candidatePaths.length, bytes, capped, cancelled: true, git: true });
      } else if (code === 0 || capped) {
        finish({
          paths: [...new Set(paths)].sort(stablePathCompare),
          observedPaths: candidatePaths.length,
          bytes,
          capped,
          cancelled: false,
          git: true,
        });
      } else if (stderr.toString("utf8").includes("not a git repository")) {
        // LC_ALL=C makes this the one unambiguous non-Git result. All other
        // failures remain fail-closed Git ambiguity.
        finish(undefined);
      } else {
        finish({ paths: [], observedPaths: candidatePaths.length, bytes, capped: true, cancelled: false, git: true });
      }
    });
  });
}

function spawnGitEnumeration(
  projectRoot: string,
  signal: AbortSignal,
  limits: Readonly<LexicalFallbackLimits>,
  excluded: (path: string) => boolean,
): Promise<EnumerationResult> {
  return new Promise((resolveEnumeration) => {
    const paths: string[] = [];
    let observedPaths = 0;
    let bytes = 0;
    let buffered = Buffer.alloc(0);
    let capped = false;
    let finished = false;
    const child = spawn("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "ignore"],
      signal,
    });
    const finish = (git: boolean, cancelled = false) => {
      if (finished) return;
      finished = true;
      resolveEnumeration({ paths, observedPaths, bytes, capped, cancelled, git });
    };
    child.on("error", (error) => finish(false, signal.aborted || error.name === "AbortError"));
    child.stdout.on("data", (chunk: Buffer) => {
      if (finished) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (bytes + buffered.byteLength > limits.maxEnumerationBytes) {
        capped = true;
        child.kill();
        return;
      }
      let separator = buffered.indexOf(0);
      while (separator >= 0) {
        const raw = buffered.subarray(0, separator);
        buffered = buffered.subarray(separator + 1);
        const pathBytes = raw.byteLength + 1;
        if (bytes + pathBytes > limits.maxEnumerationBytes || observedPaths >= limits.maxEnumeratedPaths) {
          capped = true;
          child.kill();
          break;
        }
        observedPaths += 1;
        bytes += pathBytes;
        const path = slash(raw.toString("utf8"));
        if (safeRelativePath(path) && !excluded(path)) paths.push(path);
        separator = buffered.indexOf(0);
      }
    });
    child.on("close", (code) => finish(code === 0 || capped, signal.aborted));
  });
}

async function fallbackEnumeration(
  projectRoot: string,
  signal: AbortSignal,
  limits: Readonly<LexicalFallbackLimits>,
  excluded: (path: string) => boolean,
  beforeOpen?: (path: string) => Promise<void>,
  beforeRead?: (path: string) => Promise<void>,
  operationHook?: OperationHook,
): Promise<EnumerationResult> {
  let ignorePatterns: string[] = [];
  const ignorePath = join(projectRoot, ".gitignore");
  try {
    const ignoreInfo = await stagedOperation(operationHook, "lstat", ignorePath, signal, () => lstat(ignorePath));
    if (ignoreInfo === ABORTED) {
      return { paths: [], observedPaths: 0, bytes: 0, capped: false, cancelled: true, git: false };
    }
    if (!ignoreInfo.isFile() || ignoreInfo.isSymbolicLink()) {
      return { paths: [], observedPaths: 0, bytes: 0, capped: true, cancelled: signal.aborted, git: false };
    }
    const ignore = await readCandidate(
      projectRoot,
      ".gitignore",
      limits.maxIgnoreBytes,
      limits.maxIgnoreBytes,
      signal,
      beforeOpen,
      beforeRead,
      operationHook,
    );
    if (ignore.text === undefined || ignore.capped) {
      return { paths: [], observedPaths: 0, bytes: 0, capped: true, cancelled: signal.aborted, git: false };
    }
    ignorePatterns = ignore.text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      return { paths: [], observedPaths: 0, bytes: 0, capped: true, cancelled: signal.aborted, git: false };
    }
  }
  const ignored = rootGitignoreMatcher(ignorePatterns);
  const paths: string[] = [];
  let observedPaths = 0;
  let bytes = 0;
  let capped = false;
  const directories = [projectRoot];
  while (directories.length > 0 && !signal.aborted && !capped) {
    const directory = directories.pop();
    if (!directory) break;
    const childDirectories: string[] = [];
    let entries: Awaited<ReturnType<typeof opendir>> | undefined;
    let deferredClose = false;
    try {
      const opened = await stagedOperation(
        operationHook,
        "directory-open",
        directory,
        signal,
        () => opendir(directory),
        (lateEntries) => lateEntries.close(),
      );
      if (opened === ABORTED) break;
      entries = opened;
      while (!signal.aborted) {
        const entry = await stagedOperation(
          operationHook,
          "directory-read",
          directory,
          signal,
          () => (entries as Awaited<ReturnType<typeof opendir>>).read(),
          () => (entries as Awaited<ReturnType<typeof opendir>>).close(),
        );
        if (entry === ABORTED) {
          deferredClose = true;
          break;
        }
        if (entry === null) break;
        const absolute = join(directory, entry.name);
        const path = slash(relative(projectRoot, absolute));
        const pathBytes = Buffer.byteLength(path, "utf8") + 1;
        if (bytes + pathBytes > limits.maxEnumerationBytes || observedPaths >= limits.maxEnumeratedPaths) {
          capped = true;
          break;
        }
        observedPaths += 1;
        bytes += pathBytes;
        if (!safeRelativePath(path) || excluded(path) || ignored(path)) continue;
        if (entry.isDirectory()) childDirectories.push(absolute);
        else if (entry.isFile()) paths.push(path);
      }
    } catch {
      // An unreadable directory is skipped. Cancellation is represented below.
    } finally {
      if (entries && !deferredClose) {
        await stagedOperation(
          operationHook,
          "directory-close",
          directory,
          signal,
          () => (entries as Awaited<ReturnType<typeof opendir>>).close(),
          undefined,
          true,
        );
      }
    }
    childDirectories.sort(stablePathCompare);
    for (let index = childDirectories.length - 1; index >= 0; index -= 1)
      directories.push(childDirectories[index] as string);
  }
  return { paths, observedPaths, bytes, capped, cancelled: signal.aborted, git: false };
}

async function candidateEnumeration(
  projectRoot: string,
  signal: AbortSignal,
  limits: Readonly<LexicalFallbackLimits>,
  candidatePaths: readonly string[],
  excluded: (path: string) => boolean,
  beforeOpen?: (path: string) => Promise<void>,
  beforeRead?: (path: string) => Promise<void>,
  operationHook?: OperationHook,
): Promise<EnumerationResult> {
  const normalized: string[] = [];
  const conclusiveExcludedPaths: string[] = [];
  let observedPaths = 0;
  let bytes = 0;
  let capped = false;
  // Charge supplied entries before normalization, deduplication, exclusion, or
  // admission. Stop at the hard envelope without inspecting an uncharged path.
  for (const supplied of candidatePaths) {
    const pathBytes = Buffer.byteLength(supplied, "utf8") + 1;
    if (observedPaths >= limits.maxEnumeratedPaths || bytes + pathBytes > limits.maxEnumerationBytes) {
      capped = true;
      break;
    }
    observedPaths += 1;
    bytes += pathBytes;
    const path = supplied.replaceAll("\\", "/").replace(/^\.\//u, "");
    if (!safeRelativePath(path)) continue;
    if (excluded(path)) conclusiveExcludedPaths.push(path);
    else normalized.push(path);
  }
  const ordered = [...new Set(normalized)].sort(stablePathCompare);
  if (signal.aborted) return { paths: [], observedPaths, bytes, capped, cancelled: true, git: true };
  const remainingAdmissionLimits = {
    ...limits,
    maxEnumeratedPaths: Math.max(0, limits.maxEnumeratedPaths - observedPaths),
    maxEnumerationBytes: Math.max(0, limits.maxEnumerationBytes - bytes),
  };
  if (
    ordered.length > 0 &&
    (remainingAdmissionLimits.maxEnumeratedPaths === 0 || remainingAdmissionLimits.maxEnumerationBytes === 0)
  ) {
    return {
      paths: [],
      observedPaths,
      bytes,
      capped: true,
      cancelled: signal.aborted,
      git: true,
      conclusiveExcludedPaths,
      unresolvedPaths: ordered,
    };
  }
  const git = await spawnGitCandidateAdmission(projectRoot, signal, remainingAdmissionLimits, ordered);
  if (git) {
    const admitted = new Set(git.paths);
    const unresolved = capped || git.capped || git.cancelled;
    return {
      ...git,
      observedPaths,
      // Candidate charging, rather than Git output, owns this envelope.
      bytes,
      capped: capped || git.capped,
      conclusiveExcludedPaths: unresolved
        ? conclusiveExcludedPaths
        : [...conclusiveExcludedPaths, ...ordered.filter((path) => !admitted.has(path))],
      unresolvedPaths: unresolved ? ordered.filter((path) => !admitted.has(path)) : [],
    };
  }

  // The Git operation confirmed this is not a repository. Apply the same
  // hardened root-ignore admission used by full non-Git enumeration, but never
  // walk beyond the supplied set.
  let ignorePatterns: string[] = [];
  const ignorePath = join(projectRoot, ".gitignore");
  try {
    const ignoreInfo = await stagedOperation(operationHook, "lstat", ignorePath, signal, () => lstat(ignorePath));
    if (ignoreInfo === ABORTED) {
      return { paths: [], observedPaths, bytes, capped: false, cancelled: true, git: false };
    }
    if (!ignoreInfo.isFile() || ignoreInfo.isSymbolicLink()) {
      return { paths: [], observedPaths, bytes, capped: true, cancelled: signal.aborted, git: false };
    }
    const ignore = await readCandidate(
      projectRoot,
      ".gitignore",
      limits.maxIgnoreBytes,
      limits.maxIgnoreBytes,
      signal,
      beforeOpen,
      beforeRead,
      operationHook,
    );
    if (ignore.text === undefined || ignore.capped) {
      return { paths: [], observedPaths, bytes, capped: true, cancelled: signal.aborted, git: false };
    }
    ignorePatterns = ignore.text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      return { paths: [], observedPaths, bytes, capped: true, cancelled: signal.aborted, git: false };
    }
  }
  const ignored = rootGitignoreMatcher(ignorePatterns);
  const paths = ordered.filter((path) => !ignored(path));
  return {
    paths,
    observedPaths,
    bytes,
    capped,
    cancelled: signal.aborted,
    git: false,
    conclusiveExcludedPaths: [...conclusiveExcludedPaths, ...ordered.filter((path) => ignored(path))],
    unresolvedPaths: signal.aborted || capped ? paths : [],
  };
}

async function enumerate(
  projectRoot: string,
  signal: AbortSignal,
  limits: Readonly<LexicalFallbackLimits>,
  exclude: string[],
  beforeOpen?: (path: string) => Promise<void>,
  beforeRead?: (path: string) => Promise<void>,
  operationHook?: OperationHook,
  candidatePaths?: readonly string[],
): Promise<EnumerationResult> {
  if (exclude.length > limits.maxExcludePatterns) {
    return { paths: [], observedPaths: 0, bytes: 0, capped: true, cancelled: signal.aborted, git: false };
  }
  let excludeBytes = 0;
  for (const pattern of exclude) {
    excludeBytes += Buffer.byteLength(pattern, "utf8");
    if (excludeBytes > limits.maxExcludeBytes) {
      return { paths: [], observedPaths: 0, bytes: 0, capped: true, cancelled: signal.aborted, git: false };
    }
  }
  const excluded = repoMapPathExclusionMatcher(exclude);
  if (candidatePaths !== undefined) {
    return candidateEnumeration(
      projectRoot,
      signal,
      limits,
      candidatePaths,
      excluded,
      beforeOpen,
      beforeRead,
      operationHook,
    );
  }
  const git = await spawnGitEnumeration(projectRoot, signal, limits, excluded);
  if (git.git || git.cancelled) return { ...git, paths: [...new Set(git.paths)].sort(stablePathCompare) };
  const fallback = await fallbackEnumeration(
    projectRoot,
    signal,
    limits,
    excluded,
    beforeOpen,
    beforeRead,
    operationHook,
  );
  return { ...fallback, paths: [...new Set(fallback.paths)].sort(stablePathCompare) };
}

async function readCandidate(
  projectRoot: string,
  path: string,
  budget: number,
  maxFileBytes: number,
  signal: AbortSignal,
  beforeOpen?: (path: string) => Promise<void>,
  beforeRead?: (path: string) => Promise<void>,
  operationHook?: OperationHook,
): Promise<CandidateRead> {
  if (budget <= 0 || signal.aborted) return { bytes: 0, capped: budget <= 0, outcome: "unresolved" };
  const absolute = resolve(projectRoot, path);
  const relativePath = relative(projectRoot, absolute);
  if (!safeRelativePath(slash(relativePath))) return { bytes: 0, capped: false, outcome: "conclusive" };
  try {
    const info = await stagedOperation(operationHook, "lstat", absolute, signal, () =>
      lstat(absolute, { bigint: true }),
    );
    if (info === ABORTED) return { bytes: 0, capped: false, outcome: "unresolved" };
    if (!info.isFile()) return { bytes: 0, capped: false, outcome: "conclusive" };
    const canonical = await stagedOperation(operationHook, "realpath", absolute, signal, () => realpath(absolute));
    if (canonical === ABORTED || canonical !== absolute || !safeRelativePath(slash(relative(projectRoot, canonical)))) {
      return { bytes: 0, capped: false, outcome: "unresolved" };
    }
    if (beforeOpen) {
      if (!(await operationGate(operationHook, "before-open", absolute, signal))) {
        return { bytes: 0, capped: false, outcome: "unresolved" };
      }
      if ((await abortRace(beforeOpen(absolute), signal)) === ABORTED) {
        return { bytes: 0, capped: false, outcome: "unresolved" };
      }
    }
    const opened = await stagedOperation(
      operationHook,
      "open",
      absolute,
      signal,
      () => open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
      (lateHandle) => lateHandle.close(),
    );
    if (opened === ABORTED) return { bytes: 0, capped: false, outcome: "unresolved" };
    const handle = opened;
    let deferredClose = false;
    try {
      const current = await stagedOperation(
        operationHook,
        "stat",
        absolute,
        signal,
        () => handle.stat({ bigint: true }),
        () => handle.close(),
      );
      if (current === ABORTED) {
        deferredClose = true;
        return { bytes: 0, capped: false, outcome: "unresolved" };
      }
      // Opening by pathname cannot make every parent traversal race-free on
      // every supported platform. Identity-check the opened handle before any
      // content is read so a swapped parent/final entry cannot expose a
      // different file.
      if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) {
        return { bytes: 0, capped: false, outcome: "unresolved" };
      }
      if (beforeRead) {
        if (!(await operationGate(operationHook, "before-read", absolute, signal))) {
          return { bytes: 0, capped: false, outcome: "unresolved" };
        }
        if ((await abortRace(beforeRead(absolute), signal)) === ABORTED) {
          return { bytes: 0, capped: false, outcome: "unresolved" };
        }
      }
      const length = Math.min(budget, maxFileBytes);
      const content = Buffer.alloc(length);
      const read = await stagedOperation(
        operationHook,
        "read",
        absolute,
        signal,
        () => handle.read(content, 0, length, 0),
        () => handle.close(),
      );
      if (read === ABORTED) {
        deferredClose = true;
        return { bytes: 0, capped: false, outcome: "unresolved" };
      }
      const bounded = content.subarray(0, read.bytesRead);
      if (bounded.subarray(0, Math.min(8_192, bounded.length)).includes(0)) {
        return { bytes: read.bytesRead, capped: false, outcome: "conclusive" };
      }
      return {
        text: bounded.toString("utf8"),
        bytes: read.bytesRead,
        capped: current.size > read.bytesRead,
        outcome: "text",
      };
    } finally {
      if (!deferredClose) {
        await stagedOperation(operationHook, "close", absolute, signal, () => handle.close(), undefined, true);
      }
    }
  } catch (error) {
    return {
      bytes: 0,
      capped: false,
      outcome: errorCode(error) === "ENOENT" ? "conclusive" : "unresolved",
    };
  }
}

/** A read-only, bounded scanner used only while the coherent repository index is warming. */
export async function scanLexicalFallback(options: LexicalFallbackOptions): Promise<LexicalFallbackScanResult> {
  const started = Date.now();
  const limits = { ...LEXICAL_FALLBACK_LIMITS, ...options.limits };
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, limits.deadlineMs);
  timeout.unref();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  let enumeration: EnumerationResult = {
    paths: [],
    observedPaths: 0,
    bytes: 0,
    capped: false,
    cancelled: false,
    git: false,
  };
  let filesScanned = 0;
  let bytesScanned = 0;
  let capped = false;
  const matches: CandidateMatch[] = [];
  const conclusivePaths = new Set<string>();
  const unresolvedPaths = new Set<string>();
  const processedPaths = new Set<string>();
  try {
    const enumerationOperation = enumerate(
      options.projectRoot,
      signal,
      limits,
      options.exclude ?? [],
      options.beforeOpen,
      options.beforeRead,
      options.operationHook,
      options.candidatePaths,
    );
    const completedEnumeration = await abortRace(enumerationOperation, signal);
    if (completedEnumeration !== ABORTED) enumeration = completedEnumeration;
    capped = enumeration.capped;
    for (const path of enumeration.conclusiveExcludedPaths ?? []) conclusivePaths.add(path);
    for (const path of enumeration.unresolvedPaths ?? []) unresolvedPaths.add(path);
    const terms = queryTerms(options.query);
    for (let offset = 0; offset < enumeration.paths.length && !signal.aborted; offset += limits.concurrency) {
      if (filesScanned >= limits.maxFiles || bytesScanned >= limits.maxSourceBytes) {
        capped = true;
        break;
      }
      const remainingFiles = limits.maxFiles - filesScanned;
      const batch = enumeration.paths.slice(
        offset,
        Math.min(offset + limits.concurrency, offset + remainingFiles, enumeration.paths.length),
      );
      const remaining = limits.maxSourceBytes - bytesScanned;
      const allocations = batch.map((_, index) =>
        Math.min(limits.maxFileBytes, Math.floor((remaining + index) / batch.length)),
      );
      const batchOperation = Promise.all(
        batch.map((path, index) =>
          readCandidate(
            options.projectRoot,
            path,
            allocations[index] ?? 0,
            limits.maxFileBytes,
            signal,
            options.beforeOpen,
            options.beforeRead,
            options.operationHook,
          ),
        ),
      );
      const completedBatch = await abortRace(batchOperation, signal);
      if (completedBatch === ABORTED) break;
      const rows = completedBatch;
      for (let index = 0; index < batch.length; index += 1) {
        const row = rows[index];
        const path = batch[index];
        if (!row || !path) continue;
        processedPaths.add(path);
        filesScanned += 1;
        bytesScanned += row.bytes;
        capped ||= row.capped;
        if (row.outcome === "conclusive" || (row.outcome === "text" && !row.capped)) {
          conclusivePaths.add(path);
          unresolvedPaths.delete(path);
        } else {
          unresolvedPaths.add(path);
        }
        if (row.text !== undefined) {
          const match = scoreCandidate(path, row.text, terms, options.query, limits.maxExcerptBytes);
          if (match) matches.push(match);
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  for (const path of enumeration.paths) {
    if (!processedPaths.has(path)) unresolvedPaths.add(path);
  }
  const externallyCancelled = Boolean(options.signal?.aborted);
  const finalTimedOut = timedOut && !externallyCancelled;
  const discardEvidence = externallyCancelled || finalTimedOut || signal.aborted;
  const requestedLimit = Math.min(Math.max(1, options.limit ?? 10), limits.maxResults);
  const ranked = discardEvidence
    ? []
    : matches
        .sort(
          (left, right) =>
            right.score - left.score || right.coverage - left.coverage || stablePathCompare(left.path, right.path),
        )
        .slice(0, requestedLimit);
  const results: RepoMapQueryResult[] = ranked.map((match) => ({
    path: match.path,
    score: match.score,
    kind: "lexical",
    matchedSymbols: [],
    matchReasons: [
      options.candidatePaths === undefined
        ? `direct lexical fallback: ${match.coverage} query term${match.coverage === 1 ? "" : "s"}`
        : match.exact
          ? "pending lexical fallback: exact query"
          : `pending lexical fallback: ${match.coverage} query component${match.coverage === 1 ? "" : "s"}`,
    ],
    symbols: [],
    dependencies: [],
  }));
  return {
    results,
    fallbackEvidence: ranked.map((match) => ({
      kind: match.evidenceKind,
      path: match.path,
      excerpt: match.excerpt,
    })),
    ...(options.candidatePaths === undefined
      ? {}
      : {
          conclusivePaths: discardEvidence ? [] : [...conclusivePaths].sort(stablePathCompare),
          unresolvedPaths: discardEvidence
            ? [...new Set(options.candidatePaths)].sort(stablePathCompare)
            : [...unresolvedPaths].sort(stablePathCompare),
        }),
    durationMs: Math.max(0, Date.now() - started),
    filesScanned,
    bytesScanned,
    enumeratedPaths: enumeration.observedPaths,
    enumerationBytes: enumeration.bytes,
    matchesReturned: ranked.length,
    capped: discardEvidence ? false : capped,
    timedOut: finalTimedOut,
    cancelled: externallyCancelled || (enumeration.cancelled && !finalTimedOut),
  };
}
