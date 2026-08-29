import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface RepoContextConfig {
  enabled: boolean;
  legacyContextVaultRepoMap: boolean;
  searchMaxBytes: number;
  debounceMs: number;
  generationRetention: number;
  quotaBytes: number;
  excludePatterns: string[];
}

export const REPO_CONTEXT_CONFIG_PATH = ".pi/repo-context.json" as const;

export const DEFAULT_CONFIG: Readonly<RepoContextConfig> = Object.freeze({
  enabled: true,
  legacyContextVaultRepoMap: false,
  searchMaxBytes: 6 * 1024,
  debounceMs: 300,
  generationRetention: 3,
  quotaBytes: 128 * 1024 * 1024,
  excludePatterns: Object.freeze([]) as unknown as string[],
});

const KEYS = new Set<keyof RepoContextConfig>([
  "enabled",
  "legacyContextVaultRepoMap",
  "searchMaxBytes",
  "debounceMs",
  "generationRetention",
  "quotaBytes",
  "excludePatterns",
]);

export async function loadConfig(projectRoot: string): Promise<RepoContextConfig> {
  const configPath = join(projectRoot, ".pi", "repo-context.json");
  let override: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("configuration must be a JSON object");
    }
    override = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Unable to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const key of Object.keys(override)) {
    if (!KEYS.has(key as keyof RepoContextConfig)) throw new Error(`Unknown Repo Context option: ${key}`);
  }
  if ("enabled" in override && typeof override.enabled !== "boolean") throw new Error("enabled must be a boolean");
  if ("legacyContextVaultRepoMap" in override && typeof override.legacyContextVaultRepoMap !== "boolean") {
    throw new Error("legacyContextVaultRepoMap must be a boolean");
  }
  for (const key of ["searchMaxBytes", "debounceMs", "generationRetention", "quotaBytes"] as const) {
    const value = override[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`${key} must be a positive safe integer`);
    }
  }
  if (typeof override.searchMaxBytes === "number" && override.searchMaxBytes < 512) {
    throw new Error("searchMaxBytes must be at least 512 bytes");
  }
  if (
    "excludePatterns" in override &&
    (!Array.isArray(override.excludePatterns) ||
      override.excludePatterns.some((item) => typeof item !== "string" || item.trim().length === 0))
  ) {
    throw new Error("excludePatterns must be an array of non-empty strings");
  }

  return {
    enabled: (override.enabled as boolean | undefined) ?? DEFAULT_CONFIG.enabled,
    legacyContextVaultRepoMap:
      (override.legacyContextVaultRepoMap as boolean | undefined) ?? DEFAULT_CONFIG.legacyContextVaultRepoMap,
    searchMaxBytes: (override.searchMaxBytes as number | undefined) ?? DEFAULT_CONFIG.searchMaxBytes,
    debounceMs: (override.debounceMs as number | undefined) ?? DEFAULT_CONFIG.debounceMs,
    generationRetention: (override.generationRetention as number | undefined) ?? DEFAULT_CONFIG.generationRetention,
    quotaBytes: (override.quotaBytes as number | undefined) ?? DEFAULT_CONFIG.quotaBytes,
    excludePatterns: [...((override.excludePatterns as string[] | undefined) ?? DEFAULT_CONFIG.excludePatterns)],
  };
}
