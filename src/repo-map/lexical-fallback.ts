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

/** Hard limits applied again at the trust boundary for injected scanner output. */
export const LEXICAL_FALLBACK_OUTPUT_LIMITS = Object.freeze({
  maxResults: LEXICAL_FALLBACK_LIMITS.maxResults,
  maxEvidence: LEXICAL_FALLBACK_LIMITS.maxResults,
  maxClassificationPaths: LEXICAL_FALLBACK_LIMITS.maxEnumeratedPaths,
  maxPathBytes: 4 * 1024,
  maxExcerptBytes: LEXICAL_FALLBACK_LIMITS.maxExcerptBytes,
  maxReasonFields: 8,
  maxReasonBytes: 256,
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

export interface LexicalFallbackFileSystem {
  lstat: typeof lstat;
  realpath: typeof realpath;
  open: typeof open;
  opendir: typeof opendir;
}

const DEFAULT_FILE_SYSTEM: LexicalFallbackFileSystem = { lstat, realpath, open, opendir };

export interface LexicalFallbackOptions {
  projectRoot: string;
  query: string;
  limit?: number;
  exclude?: string[];
  signal?: AbortSignal;
  /** Test-only bounded overrides. Values can only reduce production limits. */
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
  /** Test-only injectable filesystem operations for actual-operation races. */
  fileSystem?: Partial<LexicalFallbackFileSystem>;
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

export type BoundedLexicalFallbackCompletion =
  | { status: "completed"; scan: unknown }
  | { status: "retired"; timedOut: boolean; cancelled: boolean };

/**
 * Give even an injected scanner that ignores its signal a hard logical deadline.
 * The scanner promise is always observed after retirement; this does not claim
 * that native work has physically stopped.
 */
export async function runBoundedLexicalFallbackScan(
  start: (signal: AbortSignal) => Promise<unknown>,
  signals: readonly AbortSignal[] = [],
  deadlineMs = LEXICAL_FALLBACK_LIMITS.deadlineMs,
): Promise<BoundedLexicalFallbackCompletion> {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, deadlineMs);
  timeout.unref();
  const signal =
    signals.length > 0 ? AbortSignal.any([...signals, timeoutController.signal]) : timeoutController.signal;
  const operation = Promise.resolve().then(() => start(signal));
  try {
    const completed = await abortRace(operation, signal);
    if (completed === ABORTED) {
      return {
        status: "retired",
        timedOut: timedOut && !signals.some((candidate) => candidate.aborted),
        cancelled: signals.some((candidate) => candidate.aborted),
      };
    }
    return { status: "completed", scan: completed };
  } finally {
    clearTimeout(timeout);
  }
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
function ownedClose(start: () => Promise<void>): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return () => {
    if (!closePromise) {
      closePromise = Promise.resolve().then(start);
      void closePromise.catch(() => undefined);
    }
    return closePromise;
  };
}

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

const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:/u;

/** Platform-neutral lexical containment for scanner candidates and output. */
export function normalizeLexicalFallbackPath(value: string): string | undefined {
  if (!value || value.length > LEXICAL_FALLBACK_OUTPUT_LIMITS.maxPathBytes) return undefined;
  let path = value.replaceAll("\\", "/");
  while (path.startsWith("./")) path = path.slice(2);
  if (!path || path.startsWith("/") || WINDOWS_DRIVE_PATH.test(path) || path.includes("\0")) return undefined;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  if (Buffer.byteLength(path, "utf8") > LEXICAL_FALLBACK_OUTPUT_LIMITS.maxPathBytes) return undefined;
  return segments.join("/");
}

export function safeRelativePath(path: string): boolean {
  return normalizeLexicalFallbackPath(path) === path;
}

function utf8Prefix(value: string, maxBytes: number): string {
  // Slice code units before encoding so a hostile huge string cannot force an
  // equally huge temporary allocation merely to enforce the byte limit.
  const prefix = value.slice(0, maxBytes);
  const bytes = Buffer.from(prefix, "utf8");
  if (bytes.byteLength <= maxBytes) return prefix;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function emptySanitizedScan(capped = true): LexicalFallbackScanResult {
  return {
    results: [],
    fallbackEvidence: [],
    conclusivePaths: [],
    unresolvedPaths: [],
    durationMs: 0,
    filesScanned: 0,
    bytesScanned: 0,
    enumeratedPaths: 0,
    enumerationBytes: 0,
    matchesReturned: 0,
    capped,
    timedOut: false,
    cancelled: false,
  };
}

function boundedStringArray(value: unknown, maxEntries: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxEntries) return undefined;
  const strings: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== "string") return undefined;
    strings.push(utf8Prefix(entry, LEXICAL_FALLBACK_OUTPUT_LIMITS.maxReasonBytes));
  }
  return strings;
}

function boundedCounter(value: unknown, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(maximum, Math.floor(value));
}

/**
 * Treat scanner implementations as an untrusted boundary. Malformed accessors,
 * oversized arrays, escaping paths, and unpaired evidence all fail closed.
 */
export function sanitizeLexicalFallbackScan(
  input: unknown,
  candidatePaths?: readonly string[],
): LexicalFallbackScanResult {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return emptySanitizedScan();
    const scan = input as Record<string, unknown>;
    const timedOut = scan.timedOut;
    const cancelled = scan.cancelled;
    const capped = scan.capped;
    if (typeof timedOut !== "boolean" || typeof cancelled !== "boolean" || typeof capped !== "boolean") {
      return emptySanitizedScan();
    }
    const durationMs = boundedCounter(scan.durationMs, LEXICAL_FALLBACK_LIMITS.deadlineMs);
    const filesScanned = boundedCounter(scan.filesScanned, LEXICAL_FALLBACK_LIMITS.maxFiles);
    const bytesScanned = boundedCounter(scan.bytesScanned, LEXICAL_FALLBACK_LIMITS.maxSourceBytes);
    const enumeratedPaths = boundedCounter(scan.enumeratedPaths, LEXICAL_FALLBACK_LIMITS.maxEnumeratedPaths);
    const enumerationBytes = boundedCounter(scan.enumerationBytes, LEXICAL_FALLBACK_LIMITS.maxEnumerationBytes);
    if (
      durationMs === undefined ||
      filesScanned === undefined ||
      bytesScanned === undefined ||
      enumeratedPaths === undefined ||
      enumerationBytes === undefined
    ) {
      return emptySanitizedScan();
    }
    const failClosed = (): LexicalFallbackScanResult => ({
      ...emptySanitizedScan(!(timedOut || cancelled)),
      durationMs,
      filesScanned,
      bytesScanned,
      enumeratedPaths,
      enumerationBytes,
      capped: !(timedOut || cancelled),
      timedOut: cancelled ? false : timedOut,
      cancelled,
    });
    const resultsInput = scan.results;
    const evidenceInput = scan.fallbackEvidence;
    const conclusiveInput = scan.conclusivePaths;
    const unresolvedInput = scan.unresolvedPaths;
    if (
      !Array.isArray(resultsInput) ||
      resultsInput.length > LEXICAL_FALLBACK_OUTPUT_LIMITS.maxResults ||
      !Array.isArray(evidenceInput) ||
      evidenceInput.length > LEXICAL_FALLBACK_OUTPUT_LIMITS.maxEvidence ||
      (conclusiveInput !== undefined &&
        (!Array.isArray(conclusiveInput) ||
          conclusiveInput.length > LEXICAL_FALLBACK_OUTPUT_LIMITS.maxClassificationPaths)) ||
      (unresolvedInput !== undefined &&
        (!Array.isArray(unresolvedInput) ||
          unresolvedInput.length > LEXICAL_FALLBACK_OUTPUT_LIMITS.maxClassificationPaths))
    ) {
      return failClosed();
    }

    let candidates: Set<string> | undefined;
    if (candidatePaths !== undefined) {
      candidates = new Set<string>();
      let candidateBytes = 0;
      for (let index = 0; index < candidatePaths.length; index += 1) {
        if (index >= LEXICAL_FALLBACK_LIMITS.maxEnumeratedPaths) break;
        const path = normalizeLexicalFallbackPath(candidatePaths[index] as string);
        if (!path) continue;
        const pathBytes = Buffer.byteLength(path, "utf8") + 1;
        if (candidateBytes + pathBytes > LEXICAL_FALLBACK_LIMITS.maxEnumerationBytes) break;
        candidateBytes += pathBytes;
        candidates.add(path);
      }
    }
    const admitPath = (value: unknown): string | undefined => {
      if (typeof value !== "string") return undefined;
      const path = normalizeLexicalFallbackPath(value);
      if (!path || (candidates && !candidates.has(path))) return undefined;
      return path;
    };

    const evidenceByPath = new Map<string, RepoMapFallbackEvidence>();
    for (let index = 0; index < evidenceInput.length; index += 1) {
      const value = evidenceInput[index];
      if (typeof value !== "object" || value === null || Array.isArray(value)) return failClosed();
      const evidence = value as Record<string, unknown>;
      const path = admitPath(evidence.path);
      if (
        !path ||
        (evidence.kind !== "source" && evidence.kind !== "warming") ||
        typeof evidence.excerpt !== "string"
      ) {
        return failClosed();
      }
      evidenceByPath.set(path, {
        kind: evidence.kind,
        path,
        excerpt: utf8Prefix(evidence.excerpt, LEXICAL_FALLBACK_OUTPUT_LIMITS.maxExcerptBytes),
      });
    }

    const resultsByPath = new Map<string, RepoMapQueryResult>();
    for (let index = 0; index < resultsInput.length; index += 1) {
      const value = resultsInput[index];
      if (typeof value !== "object" || value === null || Array.isArray(value)) return failClosed();
      const result = value as Record<string, unknown>;
      const path = admitPath(result.path);
      const matchedSymbols = boundedStringArray(result.matchedSymbols, LEXICAL_FALLBACK_OUTPUT_LIMITS.maxReasonFields);
      const matchReasons =
        result.matchReasons === undefined
          ? []
          : boundedStringArray(result.matchReasons, LEXICAL_FALLBACK_OUTPUT_LIMITS.maxReasonFields);
      const dependencies = boundedStringArray(result.dependencies, LEXICAL_FALLBACK_OUTPUT_LIMITS.maxReasonFields);
      if (
        !path ||
        !evidenceByPath.has(path) ||
        typeof result.score !== "number" ||
        !Number.isFinite(result.score) ||
        result.kind !== "lexical" ||
        !matchedSymbols ||
        !matchReasons ||
        !dependencies ||
        !Array.isArray(result.symbols) ||
        result.symbols.length !== 0
      ) {
        return failClosed();
      }
      resultsByPath.set(path, {
        path,
        score: Math.max(-1_000_000, Math.min(1_000_000, result.score)),
        kind: "lexical",
        matchedSymbols,
        ...(matchReasons.length > 0 ? { matchReasons } : {}),
        symbols: [],
        dependencies,
      });
    }

    const pairedPaths = [...resultsByPath.keys()].filter((path) => evidenceByPath.has(path));
    const paired = new Set(pairedPaths);
    const classification = (value: unknown): string[] | undefined => {
      if (value === undefined) return [];
      if (!Array.isArray(value)) return undefined;
      const paths: string[] = [];
      let pathBytes = 0;
      for (let index = 0; index < value.length; index += 1) {
        const path = admitPath(value[index]);
        if (!path) return undefined;
        pathBytes += Buffer.byteLength(path, "utf8") + 1;
        if (pathBytes > LEXICAL_FALLBACK_LIMITS.maxEnumerationBytes) return undefined;
        paths.push(path);
      }
      return [...new Set(paths)].sort(stablePathCompare);
    };
    const conclusivePaths = classification(conclusiveInput);
    const unresolvedPaths = classification(unresolvedInput);
    if (!conclusivePaths || !unresolvedPaths) return failClosed();

    const retired = timedOut || cancelled;
    const results = retired ? [] : pairedPaths.map((path) => resultsByPath.get(path) as RepoMapQueryResult);
    const fallbackEvidence = retired
      ? []
      : pairedPaths.map((path) => evidenceByPath.get(path) as RepoMapFallbackEvidence);
    return {
      results,
      fallbackEvidence,
      ...(candidatePaths === undefined
        ? {}
        : {
            conclusivePaths: retired ? [] : conclusivePaths,
            unresolvedPaths: retired ? [...(candidates ?? [])].sort(stablePathCompare) : unresolvedPaths,
          }),
      durationMs,
      filesScanned,
      bytesScanned,
      enumeratedPaths,
      enumerationBytes,
      matchesReturned: retired ? 0 : paired.size,
      capped,
      timedOut: cancelled ? false : timedOut,
      cancelled,
    };
  } catch {
    return emptySanitizedScan();
  }
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
): Promise<EnumerationResult | undefined> {
  return new Promise((resolveEnumeration) => {
    const paths: string[] = [];
    let observedPaths = 0;
    let bytes = 0;
    let buffered = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let capped = false;
    let finished = false;
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
        finish({ paths: [], observedPaths, bytes, capped: false, cancelled: true, git: true });
      } else {
        finish({ paths: [], observedPaths, bytes, capped: true, cancelled: false, git: true });
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
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.byteLength < 4_096) stderr = Buffer.concat([stderr, chunk]).subarray(0, 4_096);
    });
    child.on("close", (code) => {
      if (signal.aborted) {
        finish({ paths: [], observedPaths, bytes, capped: false, cancelled: true, git: true });
      } else if (code === 0 || capped) {
        finish({ paths, observedPaths, bytes, capped, cancelled: false, git: true });
      } else if (stderr.toString("utf8").includes("not a git repository")) {
        // LC_ALL=C makes this the only explicit permission to use the hardened
        // non-Git filesystem walk. Every other Git failure remains fail closed.
        finish(undefined);
      } else {
        finish({ paths: [], observedPaths, bytes, capped: true, cancelled: false, git: true });
      }
    });
  });
}

async function fallbackEnumeration(
  projectRoot: string,
  signal: AbortSignal,
  limits: Readonly<LexicalFallbackLimits>,
  excluded: (path: string) => boolean,
  beforeOpen: ((path: string) => Promise<void>) | undefined,
  beforeRead: ((path: string) => Promise<void>) | undefined,
  operationHook: OperationHook,
  fileSystem: LexicalFallbackFileSystem,
): Promise<EnumerationResult> {
  let ignorePatterns: string[] = [];
  const ignorePath = join(projectRoot, ".gitignore");
  try {
    const ignoreInfo = await stagedOperation(operationHook, "lstat", ignorePath, signal, () =>
      fileSystem.lstat(ignorePath),
    );
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
      fileSystem,
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
    let initiateDirectoryClose: (() => Promise<void>) | undefined;
    try {
      const opened = await stagedOperation(
        operationHook,
        "directory-open",
        directory,
        signal,
        () => fileSystem.opendir(directory),
        (lateEntries) => lateEntries.close(),
      );
      if (opened === ABORTED) break;
      entries = opened;
      initiateDirectoryClose = ownedClose(() => opened.close());
      while (!signal.aborted) {
        const entry = await stagedOperation(operationHook, "directory-read", directory, signal, () =>
          (entries as Awaited<ReturnType<typeof opendir>>).read(),
        );
        if (entry === ABORTED) {
          initiateDirectoryClose();
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
      if (entries && initiateDirectoryClose) {
        await stagedOperation(
          operationHook,
          "directory-close",
          directory,
          signal,
          initiateDirectoryClose,
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
  beforeOpen: ((path: string) => Promise<void>) | undefined,
  beforeRead: ((path: string) => Promise<void>) | undefined,
  operationHook: OperationHook,
  fileSystem: LexicalFallbackFileSystem,
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
    const ignoreInfo = await stagedOperation(operationHook, "lstat", ignorePath, signal, () =>
      fileSystem.lstat(ignorePath),
    );
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
      fileSystem,
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
  beforeOpen: ((path: string) => Promise<void>) | undefined,
  beforeRead: ((path: string) => Promise<void>) | undefined,
  operationHook: OperationHook,
  fileSystem: LexicalFallbackFileSystem,
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
      fileSystem,
    );
  }
  const git = await spawnGitEnumeration(projectRoot, signal, limits, excluded);
  if (git) return { ...git, paths: [...new Set(git.paths)].sort(stablePathCompare) };
  const fallback = await fallbackEnumeration(
    projectRoot,
    signal,
    limits,
    excluded,
    beforeOpen,
    beforeRead,
    operationHook,
    fileSystem,
  );
  return { ...fallback, paths: [...new Set(fallback.paths)].sort(stablePathCompare) };
}

async function readCandidate(
  projectRoot: string,
  path: string,
  budget: number,
  maxFileBytes: number,
  signal: AbortSignal,
  beforeOpen: ((path: string) => Promise<void>) | undefined,
  beforeRead: ((path: string) => Promise<void>) | undefined,
  operationHook: OperationHook,
  fileSystem: LexicalFallbackFileSystem,
): Promise<CandidateRead> {
  if (budget <= 0 || signal.aborted) return { bytes: 0, capped: budget <= 0, outcome: "unresolved" };
  const absolute = resolve(projectRoot, path);
  const relativePath = relative(projectRoot, absolute);
  if (!safeRelativePath(slash(relativePath))) return { bytes: 0, capped: false, outcome: "conclusive" };
  try {
    const info = await stagedOperation(operationHook, "lstat", absolute, signal, () =>
      fileSystem.lstat(absolute, { bigint: true }),
    );
    if (info === ABORTED) return { bytes: 0, capped: false, outcome: "unresolved" };
    if (!info.isFile()) return { bytes: 0, capped: false, outcome: "conclusive" };
    const canonical = await stagedOperation(operationHook, "realpath", absolute, signal, () =>
      fileSystem.realpath(absolute),
    );
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
      () => fileSystem.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
      (lateHandle) => lateHandle.close(),
    );
    if (opened === ABORTED) return { bytes: 0, capped: false, outcome: "unresolved" };
    const handle = opened;
    const initiateClose = ownedClose(() => handle.close());
    try {
      const current = await stagedOperation(operationHook, "stat", absolute, signal, () =>
        handle.stat({ bigint: true }),
      );
      if (current === ABORTED) {
        initiateClose();
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
      const read = await stagedOperation(operationHook, "read", absolute, signal, () =>
        handle.read(content, 0, length, 0),
      );
      if (read === ABORTED) {
        initiateClose();
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
      // Always initiate owned-handle closure exactly once. Cancellation never
      // waits for OS completion, but both operation and close settlements stay observed.
      await stagedOperation(operationHook, "close", absolute, signal, initiateClose, undefined, true);
    }
  } catch (error) {
    return {
      bytes: 0,
      capped: false,
      outcome: errorCode(error) === "ENOENT" ? "conclusive" : "unresolved",
    };
  }
}

function boundedLexicalFallbackLimits(overrides: Partial<LexicalFallbackLimits> | undefined): LexicalFallbackLimits {
  const limits = { ...LEXICAL_FALLBACK_LIMITS };
  if (!overrides) return limits;
  for (const key of Object.keys(LEXICAL_FALLBACK_LIMITS) as Array<keyof LexicalFallbackLimits>) {
    const value = overrides[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const minimum = key === "deadlineMs" || key === "concurrency" ? 1 : 0;
    limits[key] = Math.min(LEXICAL_FALLBACK_LIMITS[key], Math.max(minimum, Math.floor(value)));
  }
  return limits;
}

/** A read-only, bounded scanner used only while the coherent repository index is warming. */
export async function scanLexicalFallback(options: LexicalFallbackOptions): Promise<LexicalFallbackScanResult> {
  const started = Date.now();
  const limits = boundedLexicalFallbackLimits(options.limits);
  const fileSystem: LexicalFallbackFileSystem = { ...DEFAULT_FILE_SYSTEM, ...options.fileSystem };
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
      fileSystem,
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
            fileSystem,
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
