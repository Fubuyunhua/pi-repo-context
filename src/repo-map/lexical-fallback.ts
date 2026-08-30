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

export interface LexicalFallbackOptions {
  projectRoot: string;
  query: string;
  limit?: number;
  exclude?: string[];
  signal?: AbortSignal;
  limits?: Partial<LexicalFallbackLimits>;
  /** Optional bounded path set used by the stale-index pending-file fallback. */
  candidatePaths?: readonly string[];
  /** Known repository mode for candidatePaths; omitted for full cold enumeration. */
  gitWorkspace?: boolean;
  /** Root ignore patterns already loaded by the non-Git runtime. */
  gitignorePatterns?: readonly string[];
  /** Test-only race hook invoked after identity capture and before open. */
  beforeOpen?: (path: string) => Promise<void>;
  /** Test-only race hook invoked after handle identity validation and before read. */
  beforeRead?: (path: string) => Promise<void>;
}

export interface LexicalFallbackScanResult {
  results: RepoMapQueryResult[];
  fallbackEvidence: RepoMapFallbackEvidence[];
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
}

interface CandidateMatch {
  path: string;
  score: number;
  coverage: number;
  evidenceKind: "source" | "warming";
  excerpt: string;
}

const ABORTED = Symbol("lexical-fallback-aborted");

/** Race an async operation against cancellation while always observing its settlement. */
function abortRace<T>(operation: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolveResult, rejectResult) => {
    const onAbort = () => {
      cleanup();
      resolveResult(ABORTED);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolveResult(value);
      },
      (error) => {
        cleanup();
        rejectResult(error);
      },
    );
  });
}

function closeAfter<T>(operation: Promise<T>, handle: Awaited<ReturnType<typeof open>>): void {
  void operation
    .then(
      () => handle.close(),
      () => handle.close(),
    )
    .catch(() => undefined);
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

function spawnGitEnumeration(
  projectRoot: string,
  signal: AbortSignal,
  limits: Readonly<LexicalFallbackLimits>,
  excluded: (path: string) => boolean,
  candidatePaths?: readonly string[],
): Promise<EnumerationResult> {
  return new Promise((resolveEnumeration) => {
    const paths: string[] = [];
    let observedPaths = 0;
    let bytes = 0;
    let buffered = Buffer.alloc(0);
    let capped = false;
    let finished = false;
    const child = spawn(
      "git",
      [
        "--literal-pathspecs",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        ...(candidatePaths ? ["--", ...candidatePaths] : []),
      ],
      {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "ignore"],
        signal,
      },
    );
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
): Promise<EnumerationResult> {
  let ignorePatterns: string[] = [];
  const ignorePath = join(projectRoot, ".gitignore");
  try {
    const ignoreInfo = await lstat(ignorePath);
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
    try {
      const entries = await opendir(directory);
      for await (const entry of entries) {
        if (signal.aborted) break;
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
      continue;
    }
    childDirectories.sort(stablePathCompare);
    for (let index = childDirectories.length - 1; index >= 0; index -= 1)
      directories.push(childDirectories[index] as string);
  }
  return { paths, observedPaths, bytes, capped, cancelled: signal.aborted, git: false };
}

async function enumerate(
  projectRoot: string,
  signal: AbortSignal,
  limits: Readonly<LexicalFallbackLimits>,
  exclude: string[],
  beforeOpen?: (path: string) => Promise<void>,
  candidatePaths?: readonly string[],
  gitWorkspace?: boolean,
  gitignorePatterns?: readonly string[],
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
  if (candidatePaths) {
    let bytes = 0;
    let observedPaths = 0;
    let capped = false;
    const bounded: string[] = [];
    for (const rawPath of [...new Set(candidatePaths.map(slash))].sort(stablePathCompare)) {
      const pathBytes = Buffer.byteLength(rawPath, "utf8") + 1;
      if (observedPaths >= limits.maxEnumeratedPaths || bytes + pathBytes > limits.maxEnumerationBytes) {
        capped = true;
        break;
      }
      observedPaths += 1;
      bytes += pathBytes;
      if (safeRelativePath(rawPath) && !excluded(rawPath)) bounded.push(rawPath);
    }
    if (bounded.length === 0) {
      return { paths: [], observedPaths, bytes, capped, cancelled: signal.aborted, git: gitWorkspace === true };
    }
    if (gitWorkspace !== false) {
      const git = await spawnGitEnumeration(projectRoot, signal, limits, excluded, bounded);
      if (git.git || git.cancelled || gitWorkspace === true) {
        return {
          ...git,
          observedPaths,
          bytes,
          capped: capped || git.capped || (gitWorkspace === true && !git.git),
          paths: [...new Set(git.paths)].sort(stablePathCompare),
        };
      }
    }
    const ignored = rootGitignoreMatcher([...(gitignorePatterns ?? [])]);
    return {
      paths: bounded.filter((path) => !ignored(path)),
      observedPaths,
      bytes,
      capped,
      cancelled: signal.aborted,
      git: false,
    };
  }
  const git = await spawnGitEnumeration(projectRoot, signal, limits, excluded);
  if (git.git || git.cancelled) return { ...git, paths: [...new Set(git.paths)].sort(stablePathCompare) };
  const fallback = await fallbackEnumeration(projectRoot, signal, limits, excluded, beforeOpen);
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
): Promise<{ text?: string; bytes: number; capped: boolean }> {
  if (budget <= 0 || signal.aborted) return { bytes: 0, capped: budget <= 0 };
  const absolute = resolve(projectRoot, path);
  const relativePath = relative(projectRoot, absolute);
  if (!safeRelativePath(slash(relativePath))) return { bytes: 0, capped: false };
  try {
    const info = await abortRace(lstat(absolute, { bigint: true }), signal);
    if (info === ABORTED || !info.isFile()) return { bytes: 0, capped: false };
    const canonical = await abortRace(realpath(absolute), signal);
    if (canonical === ABORTED || canonical !== absolute || !safeRelativePath(slash(relative(projectRoot, canonical)))) {
      return { bytes: 0, capped: false };
    }
    if (beforeOpen) {
      const openedGate = await abortRace(beforeOpen(absolute), signal);
      if (openedGate === ABORTED) return { bytes: 0, capped: false };
    }
    const openOperation = open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await abortRace(openOperation, signal);
    if (opened === ABORTED) {
      void openOperation.then((handle) => handle.close()).catch(() => undefined);
      return { bytes: 0, capped: false };
    }
    const handle = opened;
    let deferredClose = false;
    try {
      const statOperation = handle.stat({ bigint: true });
      const current = await abortRace(statOperation, signal);
      if (current === ABORTED) {
        deferredClose = true;
        closeAfter(statOperation, handle);
        return { bytes: 0, capped: false };
      }
      // Opening by pathname cannot make every parent traversal race-free on
      // every supported platform. Identity-check the opened handle before any
      // content is read so a swapped parent/final entry cannot expose a
      // different file.
      if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) {
        return { bytes: 0, capped: false };
      }
      if (beforeRead) {
        const readGate = await abortRace(beforeRead(absolute), signal);
        if (readGate === ABORTED) return { bytes: 0, capped: false };
      }
      const length = Math.min(budget, maxFileBytes);
      const content = Buffer.alloc(length);
      const readOperation = handle.read(content, 0, length, 0);
      const read = await abortRace(readOperation, signal);
      if (read === ABORTED) {
        deferredClose = true;
        closeAfter(readOperation, handle);
        return { bytes: 0, capped: false };
      }
      const bounded = content.subarray(0, read.bytesRead);
      if (bounded.subarray(0, Math.min(8_192, bounded.length)).includes(0)) {
        return { bytes: read.bytesRead, capped: false };
      }
      return { text: bounded.toString("utf8"), bytes: read.bytesRead, capped: current.size > read.bytesRead };
    } finally {
      if (!deferredClose) {
        const closeOperation = handle.close();
        if ((await abortRace(closeOperation, signal)) === ABORTED) void closeOperation.catch(() => undefined);
      }
    }
  } catch {
    return { bytes: 0, capped: false };
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
  try {
    const enumerationOperation = enumerate(
      options.projectRoot,
      signal,
      limits,
      options.exclude ?? [],
      options.beforeOpen,
      options.candidatePaths,
      options.gitWorkspace,
      options.gitignorePatterns,
    );
    const completedEnumeration = await abortRace(enumerationOperation, signal);
    if (completedEnumeration === ABORTED) {
      void enumerationOperation.catch(() => undefined);
    } else {
      enumeration = completedEnumeration;
    }
    capped = enumeration.capped;
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
          ),
        ),
      );
      const completedBatch = await abortRace(batchOperation, signal);
      if (completedBatch === ABORTED) {
        void batchOperation.catch(() => undefined);
        break;
      }
      const rows = completedBatch;
      for (let index = 0; index < batch.length; index += 1) {
        const row = rows[index];
        const path = batch[index];
        if (!row || !path) continue;
        filesScanned += 1;
        bytesScanned += row.bytes;
        capped ||= row.capped;
        if (row.text !== undefined) {
          const match = scoreCandidate(path, row.text, terms, options.query, limits.maxExcerptBytes);
          if (match) matches.push(match);
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  const requestedLimit = Math.min(Math.max(1, options.limit ?? 10), limits.maxResults);
  // A timeout or caller cancellation never publishes partial evidence. Reads
  // already in flight are observed and drained by abortRace/readCandidate.
  const discardMatches = signal.aborted || timedOut;
  const ranked = discardMatches
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
    matchReasons: [`direct lexical fallback: ${match.coverage} query term${match.coverage === 1 ? "" : "s"}`],
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
    durationMs: Math.max(0, Date.now() - started),
    filesScanned,
    bytesScanned,
    enumeratedPaths: enumeration.observedPaths,
    enumerationBytes: enumeration.bytes,
    matchesReturned: ranked.length,
    capped,
    timedOut,
    cancelled: Boolean(options.signal?.aborted) || (enumeration.cancelled && !timedOut),
  };
}
