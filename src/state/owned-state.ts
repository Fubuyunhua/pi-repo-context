import { randomUUID } from "node:crypto";
import { type BigIntStats, constants, lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const STATE_BOUNDARY_ERROR = "Repo Context state boundary changed or is unsafe";

export interface DirectoryIdentity {
  path: string;
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
}

export interface RegularFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
}

function code(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "";
}

function unsafe(path: string, detail: string): Error {
  const error = new Error(`${STATE_BOUNDARY_ERROR}: ${path} (${detail})`);
  (error as NodeJS.ErrnoException).code = "ESTATEBOUNDARY";
  return error;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sameDirectory(info: BigIntStats, identity: DirectoryIdentity): boolean {
  return info.isDirectory() && !info.isSymbolicLink() && info.dev === identity.dev && info.ino === identity.ino;
}

function ownedLayout(stateRoot: string): { trustedRoot: string; componentNames: string[] } {
  const mapRoot = resolve(stateRoot);
  const projectRoot = dirname(mapRoot);
  const projectsRoot = dirname(projectRoot);
  const productRoot = dirname(projectsRoot);
  if (
    basename(mapRoot) === "repo-map" &&
    basename(projectsRoot) === "projects" &&
    basename(productRoot) === "pi-repo-context"
  ) {
    return {
      trustedRoot: dirname(productRoot),
      componentNames: ["pi-repo-context", "projects", basename(projectRoot), "repo-map", "generations"],
    };
  }
  // Runtime unit tests and embedders may supply a standalone map root. It is
  // still an owned directory; its parent is the trusted boundary.
  return { trustedRoot: dirname(mapRoot), componentNames: [basename(mapRoot), "generations"] };
}

async function captureDirectory(path: string, parent?: DirectoryIdentity): Promise<DirectoryIdentity> {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) throw unsafe(path, "expected a non-symlink directory");
  const canonicalPath = await realpath(path);
  if (parent && !samePath(dirname(canonicalPath), parent.canonicalPath)) {
    throw unsafe(path, "canonical parent escaped its owned component");
  }
  return { path, canonicalPath, dev: info.dev, ino: info.ino };
}

/**
 * Captures every Repo-owned directory separately. The configured Pi root is a
 * trusted boundary and may itself be a symlink; symlinks are forbidden below it.
 */
export class RepoStateBoundary {
  readonly stateRoot: string;
  readonly generationsRoot: string;
  readonly identities: readonly DirectoryIdentity[];

  private constructor(identities: DirectoryIdentity[]) {
    const stateIdentity = identities.at(-2);
    const generationsIdentity = identities.at(-1);
    if (!stateIdentity || !generationsIdentity) throw new Error("Repo Context state boundary is incomplete");
    this.stateRoot = stateIdentity.canonicalPath;
    this.generationsRoot = generationsIdentity.canonicalPath;
    this.identities = identities;
  }

  static async create(stateRoot: string): Promise<RepoStateBoundary> {
    const layout = ownedLayout(stateRoot);
    // The configured Pi root is explicitly trusted, including when it is a
    // symlink. Creation stops at that boundary and never validates its ancestors.
    await mkdir(layout.trustedRoot, { recursive: true, mode: 0o700 });
    const trustedCanonical = await realpath(layout.trustedRoot);
    let parent: DirectoryIdentity = {
      path: trustedCanonical,
      canonicalPath: trustedCanonical,
      dev: 0n,
      ino: 0n,
    };
    const identities: DirectoryIdentity[] = [];
    for (const componentName of layout.componentNames) {
      if (identities.length > 0) await validateDirectory(parent);
      const component = join(parent.canonicalPath, componentName);
      try {
        await mkdir(component, { mode: 0o700 });
      } catch (error) {
        if (code(error) !== "EEXIST") throw error;
      }
      const identity = await captureDirectory(component, parent);
      identities.push(identity);
      parent = identity;
    }
    const boundary = new RepoStateBoundary(identities);
    await boundary.validate();
    return boundary;
  }

  static async captureExisting(stateRoot: string): Promise<RepoStateBoundary> {
    const layout = ownedLayout(stateRoot);
    const trustedCanonical = await realpath(layout.trustedRoot);
    let parent: DirectoryIdentity = {
      path: trustedCanonical,
      canonicalPath: trustedCanonical,
      dev: 0n,
      ino: 0n,
    };
    const identities: DirectoryIdentity[] = [];
    for (const componentName of layout.componentNames) {
      const component = join(parent.canonicalPath, componentName);
      const identity = await captureDirectory(component, parent);
      identities.push(identity);
      parent = identity;
    }
    const boundary = new RepoStateBoundary(identities);
    await boundary.validate();
    return boundary;
  }

  validateSync(): void {
    // Kept synchronous for status/captureCurrent, whose public contracts are synchronous.
    for (const identity of this.identities) {
      let info: BigIntStats;
      try {
        info = lstatSync(identity.path, { bigint: true });
      } catch (error) {
        throw unsafe(identity.path, code(error) || "unavailable");
      }
      if (!sameDirectory(info, identity)) throw unsafe(identity.path, "directory identity changed");
      let canonical: string;
      try {
        canonical = realpathSync(identity.path);
      } catch (error) {
        throw unsafe(identity.path, code(error) || "cannot canonicalize");
      }
      if (!samePath(canonical, identity.canonicalPath)) throw unsafe(identity.path, "canonical identity changed");
    }
  }

  async validate(): Promise<void> {
    for (const identity of this.identities) await validateDirectory(identity);
  }
}

async function validateDirectory(identity: DirectoryIdentity): Promise<void> {
  let info: BigIntStats;
  try {
    info = await lstat(identity.path, { bigint: true });
  } catch (error) {
    throw unsafe(identity.path, code(error) || "unavailable");
  }
  if (!sameDirectory(info, identity)) throw unsafe(identity.path, "directory identity changed");
  const canonical = await realpath(identity.path).catch((error: unknown) => {
    throw unsafe(identity.path, code(error) || "cannot canonicalize");
  });
  if (!samePath(canonical, identity.canonicalPath)) throw unsafe(identity.path, "canonical identity changed");
}

function readFlags(): number {
  let flags = constants.O_RDONLY;
  if (process.platform !== "win32") {
    flags |= constants.O_NONBLOCK;
    if (typeof constants.O_NOFOLLOW === "number") flags |= constants.O_NOFOLLOW;
  }
  return flags;
}

export async function inspectRegularFile(boundary: RepoStateBoundary, path: string): Promise<RegularFileIdentity> {
  await boundary.validate();
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw unsafe(path, "expected a non-symlink regular file");
  return { dev: info.dev, ino: info.ino, size: info.size };
}

export async function readOwnedRegularFile(boundary: RepoStateBoundary, path: string): Promise<Buffer> {
  await boundary.validate();
  const before = await inspectRegularFile(boundary, path);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, readFlags());
  } catch (error) {
    if (["ELOOP", "EISDIR", "EINVAL", "ENXIO"].includes(code(error))) throw unsafe(path, "unsafe file target");
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw unsafe(path, "file identity changed while opening");
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw unsafe(path, "file identity changed while reading");
    }
    await boundary.validate();
    return content;
  } finally {
    await handle.close();
  }
}

async function inspectWriteTarget(path: string): Promise<RegularFileIdentity | undefined> {
  try {
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile()) throw unsafe(path, "state file target is not a regular file");
    return { dev: info.dev, ino: info.ino, size: info.size };
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
}

export async function validateOwnedWriteTarget(boundary: RepoStateBoundary, path: string): Promise<void> {
  await boundary.validate();
  await inspectWriteTarget(path);
  await boundary.validate();
}

/** Atomic durable replacement that refuses final symlinks and non-files. */
export async function writeOwnedAtomicFile(
  boundary: RepoStateBoundary,
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  await boundary.validate();
  const original = await inspectWriteTarget(path);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let closed = false;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw unsafe(temporary, "temporary state entry is not regular");
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    closed = true;
    await boundary.validate();
    const current = await inspectWriteTarget(path);
    if (
      (original === undefined) !== (current === undefined) ||
      (original && current && (original.dev !== current.dev || original.ino !== current.ino))
    ) {
      throw unsafe(path, "state file target changed before replacement");
    }
    await rename(temporary, path);
    const published = await inspectRegularFile(boundary, path);
    if (published.dev !== opened.dev || published.ino !== opened.ino) {
      throw unsafe(path, "published state file identity is unexpected");
    }
    // Sync the owned parent using a handle opened only after its identity was
    // revalidated. Node has no portable openat, so a same-account or privileged
    // canonical-ancestor rename between validation and open remains the documented
    // very narrow TOCTOU residual.
    const parent = await open(dirname(path), "r");
    try {
      await parent.sync();
    } catch (error) {
      if (!new Set(["EBADF", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"]).has(code(error))) {
        throw error;
      }
    } finally {
      await parent.close();
    }
    await boundary.validate();
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function unlinkOwnedRegularFile(
  boundary: RepoStateBoundary,
  path: string,
  expected: RegularFileIdentity,
): Promise<void> {
  await boundary.validate();
  const current = await inspectRegularFile(boundary, path);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw unsafe(path, "state file changed before unlink");
  }
  await boundary.validate();
  await unlink(path);
  await boundary.validate();
}
