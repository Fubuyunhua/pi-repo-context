import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set([
  "EBADF",
  "EINVAL",
  "EISDIR",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
]);
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OWNER_FILE_PATTERN = new RegExp(`^owner-(${UUID_PATTERN})\\.json$`);
const PREPARATION_SUFFIX_PATTERN = new RegExp(`^\\.prepare-(${UUID_PATTERN})$`);
const REPLACEMENT_DIRECTORY_ERRORS = new Set(["EEXIST", "ENOTEMPTY"]);
const TRANSIENT_LOCK_INSPECTION_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const MAX_OWNER_METADATA_BYTES = 4 * 1024;
const ABANDONED_PREPARATION_RETENTION_MS = 24 * 60 * 60 * 1_000;

interface LockOwnerMetadata {
  schemaVersion: 1;
  owner: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

interface PreparedLock {
  directory: string;
  ownerFilename: string;
  directoryDev: bigint;
  directoryIno: bigint;
  ownerDev: bigint;
  ownerIno: bigint;
}

type OwnerRecordRead =
  | { kind: "valid"; metadata: LockOwnerMetadata; mtimeMs: number }
  | { kind: "missing" }
  | { kind: "invalid" };

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "";
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(errorCode(error));
}

function isTransientLockInspectionError(error: unknown): boolean {
  return TRANSIENT_LOCK_INSPECTION_ERRORS.has(errorCode(error));
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    await handle?.close();
  }
}

export async function syncParentDirectory(path: string): Promise<void> {
  await syncDirectory(dirname(path));
}

/** Creates every missing directory and durably publishes each new parent entry. */
export async function durableMkdir(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
    await syncParentDirectory(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      // A concurrent creator may have published the entry but not synced it yet.
      // Sync it ourselves rather than treating existence as proof of durability.
      await syncParentDirectory(path);
      return;
    }
    if (code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    await durableMkdir(parent);
    try {
      await mkdir(path, { mode: 0o700 });
      await syncParentDirectory(path);
    } catch (retryError) {
      if (errorCode(retryError) !== "EEXIST") throw retryError;
      await syncParentDirectory(path);
    }
  }
}

export async function atomicWriteFile(path: string, content: string | Uint8Array): Promise<void> {
  await durableMkdir(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  let handleClosed = false;
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handleClosed = true;
    await rename(temporary, path);
    await syncParentDirectory(path);
  } catch (error) {
    if (!handleClosed) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export interface FileLockHeartbeatScheduler {
  schedule(delayMs: number, task: () => Promise<void>): unknown;
  cancel(handle: unknown): void;
}

export interface FileLockOptions {
  retryMs?: number;
  staleMs?: number;
  timeoutMs?: number;
  /** Revalidates the caller-owned directory boundary around every lock phase. */
  guard?: () => Promise<void>;
  /** Product-owned lock targets reject unexpected fixed entries immediately. */
  rejectUnsafeTarget?: boolean;
  /** Injectable scheduler used to test heartbeat behavior without wall-clock timing. */
  heartbeatScheduler?: FileLockHeartbeatScheduler;
}

const DEFAULT_HEARTBEAT_SCHEDULER: FileLockHeartbeatScheduler = {
  schedule(delayMs, task) {
    const handle = setInterval(() => {
      void task().catch(() => undefined);
    }, delayMs);
    handle.unref();
    return handle;
  },
  cancel(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

function encodeOwner(metadata: LockOwnerMetadata): string {
  return JSON.stringify(metadata);
}

function parseOwner(source: string, filename: string): LockOwnerMetadata | undefined {
  const match = OWNER_FILE_PATTERN.exec(filename);
  if (match === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<LockOwnerMetadata>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.owner !== match[1] ||
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid ?? 0) <= 0 ||
    typeof candidate.hostname !== "string" ||
    candidate.hostname.length === 0 ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt))
  ) {
    return undefined;
  }
  return candidate as LockOwnerMetadata;
}

async function prepareLock(path: string, owner: string): Promise<PreparedLock> {
  const directory = `${path}.prepare-${owner}`;
  const ownerFilename = `owner-${owner}.json`;
  const ownerPath = join(directory, ownerFilename);
  await mkdir(directory, { mode: 0o700 });
  const directoryInfo = await lstat(directory, { bigint: true });
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error(`Unsafe prepared state lock directory: ${directory}`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(ownerPath, "wx", 0o600);
    await handle.writeFile(
      encodeOwner({
        schemaVersion: 1,
        owner,
        pid: process.pid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
      }),
    );
    await handle.sync();
    const ownerInfo = await handle.stat({ bigint: true });
    if (!ownerInfo.isFile()) throw new Error(`Unsafe state lock owner file: ${ownerPath}`);
    await handle.close();
    handle = undefined;
    await syncDirectory(directory);
    return {
      directory,
      ownerFilename,
      directoryDev: directoryInfo.dev,
      directoryIno: directoryInfo.ino,
      ownerDev: ownerInfo.dev,
      ownerIno: ownerInfo.ino,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(ownerPath).catch(() => undefined);
    await rmdir(directory).catch(() => undefined);
    throw error;
  }
}

async function cleanPreparation(prepared: PreparedLock): Promise<void> {
  await unlink(join(prepared.directory, prepared.ownerFilename)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await rmdir(prepared.directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function readBoundedOwnerRecord(ownerPath: string, ownerFilename: string): Promise<OwnerRecordRead> {
  let before: BigIntStats;
  try {
    before = await lstat(ownerPath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" };
    if (isTransientLockInspectionError(error)) return { kind: "invalid" };
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(MAX_OWNER_METADATA_BYTES)) {
    return { kind: "invalid" };
  }

  let flags = constants.O_RDONLY;
  if (process.platform !== "win32") {
    flags |= constants.O_NONBLOCK;
    if (typeof constants.O_NOFOLLOW === "number") flags |= constants.O_NOFOLLOW;
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(ownerPath, flags);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" };
    if (isTransientLockInspectionError(error) || ["ELOOP", "EISDIR", "EINVAL", "ENXIO"].includes(errorCode(error))) {
      return { kind: "invalid" };
    }
    throw error;
  }

  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.size > BigInt(MAX_OWNER_METADATA_BYTES) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      return { kind: "invalid" };
    }

    const buffer = Buffer.allocUnsafe(MAX_OWNER_METADATA_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > MAX_OWNER_METADATA_BYTES) return { kind: "invalid" };

    const after = await handle.stat({ bigint: true });
    if (
      !after.isFile() ||
      after.size > BigInt(MAX_OWNER_METADATA_BYTES) ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      return { kind: "invalid" };
    }
    const metadata = parseOwner(buffer.subarray(0, length).toString("utf8"), ownerFilename);
    return metadata === undefined ? { kind: "invalid" } : { kind: "valid", metadata, mtimeMs: Number(after.mtimeMs) };
  } finally {
    await handle.close();
  }
}

function isDemonstrablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

async function removeEmptyLockDirectory(path: string): Promise<boolean> {
  try {
    await rmdir(path);
    await syncParentDirectory(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    if (REPLACEMENT_DIRECTORY_ERRORS.has(errorCode(error)) || errorCode(error) === "EPERM") return false;
    throw error;
  }
}

async function cleanAbandonedPreparations(path: string): Promise<void> {
  const parent = dirname(path);
  const prefix = `${basename(path)}.prepare-`;
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const suffix = entry.slice(basename(path).length);
    const match = PREPARATION_SUFFIX_PATTERN.exec(suffix);
    if (match === null) continue;
    const owner = match[1];
    if (owner === undefined) continue;
    const directory = join(parent, entry);
    let directoryInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      directoryInfo = await lstat(directory);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) continue;

    let children: string[];
    try {
      children = await readdir(directory);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    const ownerFilename = `owner-${owner}.json`;
    if (children.length !== 1 || children[0] !== ownerFilename) continue;
    const record = await readBoundedOwnerRecord(join(directory, ownerFilename), ownerFilename);
    if (
      record.kind !== "valid" ||
      Date.now() - record.mtimeMs <= ABANDONED_PREPARATION_RETENTION_MS ||
      record.metadata.hostname !== hostname() ||
      !isDemonstrablyDead(record.metadata.pid)
    ) {
      continue;
    }

    await unlink(join(directory, ownerFilename)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await removeEmptyLockDirectory(directory);
  }
}

async function recoverStaleLock(path: string, staleMs: number): Promise<boolean> {
  let lockInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    lockInfo = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    if (isTransientLockInspectionError(error)) return false;
    throw error;
  }
  // Legacy lock files, symlinks, and other unexpected objects fail safe. Moving
  // or unlinking an object without an owner-specific name would reintroduce the
  // replacement race this protocol is designed to avoid.
  if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink()) return false;

  let entries: string[];
  try {
    entries = await readdir(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    if (isTransientLockInspectionError(error)) return false;
    throw error;
  }
  if (entries.length === 0) return removeEmptyLockDirectory(path);
  if (entries.length !== 1) return false;

  const ownerFilename = entries[0];
  if (ownerFilename === undefined || OWNER_FILE_PATTERN.exec(ownerFilename) === null) return false;
  const ownerPath = join(path, ownerFilename);
  const record = await readBoundedOwnerRecord(ownerPath, ownerFilename);
  if (record.kind === "missing") return true;
  // Malformed, oversized, raced, or non-regular metadata has no trustworthy
  // PID or identity, so it is retained rather than guessed stale.
  if (record.kind === "invalid") return false;
  if (Date.now() - record.mtimeMs <= staleMs) return false;
  // A lock from an unknown host cannot be tied safely to a local PID. For a
  // local owner, only ESRCH proves death; EPERM and every other result protect it.
  if (record.metadata.hostname !== hostname() || !isDemonstrablyDead(record.metadata.pid)) return false;

  try {
    await unlink(ownerPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return removeEmptyLockDirectory(path);
}

type FixedLockTarget = "missing" | "directory" | "unsafe" | "contended";

async function inspectFixedLockTarget(path: string): Promise<FixedLockTarget> {
  try {
    const target = await lstat(path);
    if (target.isSymbolicLink() || !target.isDirectory()) return "unsafe";
    return "directory";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    if (isTransientLockInspectionError(error)) return "contended";
    throw error;
  }
}

function isRenameContention(error: unknown): boolean {
  if (REPLACEMENT_DIRECTORY_ERRORS.has(errorCode(error))) return true;
  // Windows commonly reports EPERM when directory publication loses a race.
  // The winner may release before we can inspect the target, so all publication
  // EPERMs are retried subject to the normal timeout. POSIX reports ENOTDIR
  // when a legacy or otherwise unsafe target races with publication.
  return errorCode(error) === "EPERM" || errorCode(error) === "ENOTDIR";
}

async function assertOwnedLock(path: string, prepared: PreparedLock): Promise<void> {
  let directory: BigIntStats;
  try {
    directory = await lstat(path, { bigint: true });
  } catch {
    throw new Error(`State lock directory identity changed: ${path}`);
  }
  if (
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    directory.dev !== prepared.directoryDev ||
    directory.ino !== prepared.directoryIno
  ) {
    throw new Error(`State lock directory identity changed: ${path}`);
  }
  const ownerPath = join(path, prepared.ownerFilename);
  let owner: BigIntStats;
  try {
    owner = await lstat(ownerPath, { bigint: true });
  } catch {
    throw new Error(`State lock owner identity changed: ${ownerPath}`);
  }
  if (owner.isSymbolicLink() || !owner.isFile() || owner.dev !== prepared.ownerDev || owner.ino !== prepared.ownerIno) {
    throw new Error(`State lock owner identity changed: ${ownerPath}`);
  }
}

async function heartbeatOwnedLock(path: string, prepared: PreparedLock): Promise<void> {
  await assertOwnedLock(path, prepared);
  const ownerPath = join(path, prepared.ownerFilename);
  let flags = constants.O_RDWR;
  if (process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number") flags |= constants.O_NOFOLLOW;
  const handle = await open(ownerPath, flags);
  try {
    const owner = await handle.stat({ bigint: true });
    if (!owner.isFile() || owner.dev !== prepared.ownerDev || owner.ino !== prepared.ownerIno) {
      throw new Error(`State lock owner identity changed: ${ownerPath}`);
    }
    const now = new Date();
    await handle.utimes(now, now);
  } finally {
    await handle.close();
  }
}

function normalizeHeartbeatError(path: string, error: unknown): Error {
  const code = errorCode(error);
  const detail = code === "" ? "" : ` (${code.slice(0, 32)})`;
  return new Error(`State lock heartbeat failed${detail}: ${path}`, { cause: error });
}

async function releaseOwnedLock(path: string, prepared: PreparedLock): Promise<void> {
  await assertOwnedLock(path, prepared);
  try {
    await unlink(join(path, prepared.ownerFilename));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  try {
    await rmdir(path);
    await syncParentDirectory(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || REPLACEMENT_DIRECTORY_ERRORS.has(errorCode(error))) return;
    if (errorCode(error) === "EPERM") {
      // On Windows, a non-empty replacement can surface as EPERM rather than
      // ENOTEMPTY. Inspect only to distinguish that safe race from a real
      // inability to remove our now-empty directory.
      try {
        if ((await readdir(path)).length > 0) return;
      } catch (inspectionError) {
        if (errorCode(inspectionError) === "ENOENT") return;
      }
    }
    throw error;
  }
}

export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const retryMs = options.retryMs ?? 10;
  const staleMs = options.staleMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(retryMs) || retryMs <= 0) throw new Error("retryMs must be greater than zero");
  if (!Number.isFinite(staleMs) || staleMs <= 0) throw new Error("staleMs must be greater than zero");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("timeoutMs must not be negative");

  const startedAt = Date.now();
  const owner = randomUUID();
  await options.guard?.();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await options.guard?.();
  await cleanAbandonedPreparations(path).catch(() => undefined);
  await options.guard?.();
  const prepared = await prepareLock(path, owner);
  const waitForRetry = async (): Promise<void> => {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for state lock: ${path}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, retryMs));
  };

  try {
    while (true) {
      await options.guard?.();
      const target = await inspectFixedLockTarget(path);
      if (target !== "missing") {
        // Never pass an existing fixed target to rename: on Windows, rename can
        // replace a legacy file. Directories are ordinary contention; every
        // other object (including symlinks) remains untouched and fails safe.
        if (target === "unsafe" && options.rejectUnsafeTarget) {
          throw new Error(`Unsafe state lock target: ${path}`);
        }
        if (target === "directory" && (await recoverStaleLock(path, staleMs))) continue;
        await waitForRetry();
        continue;
      }

      try {
        await options.guard?.();
        await rename(prepared.directory, path);
        await options.guard?.();
        await assertOwnedLock(path, prepared);
        break;
      } catch (error) {
        if (!isRenameContention(error)) throw error;
        const racedTarget = await inspectFixedLockTarget(path);
        if (racedTarget === "directory" && (await recoverStaleLock(path, staleMs))) continue;
        await waitForRetry();
      }
    }
  } catch (error) {
    await cleanPreparation(prepared).catch(() => undefined);
    throw error;
  }

  try {
    await options.guard?.();
    await assertOwnedLock(path, prepared);
    await syncParentDirectory(path);
    await options.guard?.();
    await assertOwnedLock(path, prepared);
  } catch (error) {
    await options.guard?.();
    await releaseOwnedLock(path, prepared);
    throw error;
  }

  const heartbeatScheduler = options.heartbeatScheduler ?? DEFAULT_HEARTBEAT_SCHEDULER;
  const activeHeartbeats = new Set<Promise<void>>();
  let heartbeatFailure: Error | undefined;
  const runHeartbeat = (): Promise<void> => {
    let task: Promise<void>;
    task = heartbeatOwnedLock(path, prepared)
      .catch((error: unknown) => {
        const failure = normalizeHeartbeatError(path, error);
        heartbeatFailure ??= failure;
        throw failure;
      })
      .finally(() => activeHeartbeats.delete(task));
    activeHeartbeats.add(task);
    return task;
  };
  const heartbeat = heartbeatScheduler.schedule(Math.max(10, Math.floor(staleMs / 3)), runHeartbeat);

  let result: T | undefined;
  let operationCompleted = false;
  let operationFailure: unknown;
  try {
    await options.guard?.();
    await assertOwnedLock(path, prepared);
    result = await operation();
    await options.guard?.();
    await assertOwnedLock(path, prepared);
    operationCompleted = true;
  } catch (error) {
    operationFailure = error;
  }

  heartbeatScheduler.cancel(heartbeat);
  await Promise.allSettled([...activeHeartbeats]);
  // A failed boundary guard must prevent cleanup from unlinking through a
  // replaced parent. The replacement is intentionally left untouched.
  await options.guard?.();
  await releaseOwnedLock(path, prepared);
  await options.guard?.();
  if (heartbeatFailure !== undefined) throw heartbeatFailure;
  if (!operationCompleted) throw operationFailure;
  return result as T;
}
