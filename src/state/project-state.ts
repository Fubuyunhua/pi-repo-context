import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const STATE_SCHEMA_VERSION = 1 as const;

export interface RepoContextProjectState {
  projectId: string;
  projectRoot: string;
  stateRoot: string;
  mapRoot: string;
}

/** Computes product-local state paths without creating any directory. */
export async function resolveProjectState(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RepoContextProjectState> {
  const projectRoot = await realpath(resolve(cwd));
  const projectId = createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);
  const piRoot = resolve(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  const stateRoot = join(piRoot, "pi-repo-context", "projects", projectId);
  const mapRoot = join(stateRoot, "repo-map");
  return { projectId, projectRoot, stateRoot, mapRoot };
}
