import { isAbsolute, relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RepoMapQueryResult } from "./repo-map/index.js";
import {
  type RepoMapFallbackEvidence,
  type RepoMapFreshness,
  type RepoMapMaintenanceResult,
  RepoMapRuntime,
  type RepoMapRuntimeQuery,
} from "./repo-map/runtime.js";
import { loadConfig, type RepoContextConfig } from "./state/config.js";
import { type RepoContextProjectState, resolveProjectState } from "./state/project-state.js";
import { RepoContextTelemetry, type RepoContextTelemetrySnapshot } from "./telemetry.js";

export const EXTENSION_ID = "repo-context" as const;
export const EXTENSION_VERSION = "0.1.0" as const;
const MAX_FAILURES = 20;
const MAX_FAILURE_BYTES = 512;
const MAX_STATUS_PATHS = 64;
const SEARCH_RESULT_TYPE = "repo_context_search_result" as const;
const SEARCH_TRUST = "untrusted-derived-navigation-data" as const;
const USAGE = "Usage: /repo-context status|rebuild|doctor" as const;
const PUBLIC_ERRORS = Object.freeze({
  initialization: "Repository context initialization failed.",
  "repo-map": "Repository map runtime failed.",
  query: "Repository search failed.",
  rebuild: "Repository rebuild failed.",
  searchResult: "Repository search returned degraded results.",
  mapStatus: "Repository map reported an error.",
  maintenance: "Repository maintenance failed.",
});

type FailureComponent = "initialization" | "repo-map" | "query" | "rebuild";
export interface BoundedFailure {
  component: FailureComponent;
  error: string;
}

export interface RepoMapController {
  start(): Promise<void>;
  close(): Promise<void>;
  rebuild(): Promise<void>;
  query(query: string, options?: { limit?: number }): Promise<RepoMapRuntimeQuery>;
  status(): Omit<RepoMapRuntimeQuery, "results" | "fallbackEvidence"> & {
    dirtyFiles: string[];
    maintenance?: RepoMapMaintenanceResult | { error: string };
  };
}

interface RuntimeState {
  initialized: boolean;
  config?: RepoContextConfig;
  state?: RepoContextProjectState;
  repoMap?: RepoMapController;
  available: boolean;
  failures: BoundedFailure[];
  telemetry: RepoContextTelemetry;
}

export interface RegisterRepoContextOptions {
  loadConfig?: typeof loadConfig;
  resolveProjectState?: typeof resolveProjectState;
  runtimeFactory?: (input: {
    projectRoot: string;
    mapRoot: string;
    config: RepoContextConfig;
    telemetry: RepoContextTelemetry;
  }) => RepoMapController;
  stdout?: (text: string) => void;
}

export interface BoundedSearchPayload {
  type: typeof SEARCH_RESULT_TYPE;
  trust: typeof SEARCH_TRUST;
  query: string;
  freshness: RepoMapFreshness;
  generation: number;
  gitHead: string;
  workspaceRevision: string;
  pendingFiles: string[];
  results: RepoMapQueryResult[];
  fallbackEvidence: RepoMapFallbackEvidence[];
  truncatedFields: string[];
  error?: string;
}

export interface RepoContextStatusPayload {
  extension: { id: typeof EXTENSION_ID; version: typeof EXTENSION_VERSION };
  initialized: boolean;
  enabled: boolean | null;
  available: boolean;
  degraded: boolean;
  components: {
    repoMap: {
      available: boolean;
      freshness?: RepoMapFreshness;
      generation?: number;
      gitHead?: string;
      workspaceRevision?: string;
      pendingCount?: number;
      pendingFiles?: string[];
      omittedPendingFiles?: number;
      dirtyCount?: number;
      dirtyFiles?: string[];
      omittedDirtyFiles?: number;
      maintenance?: RepoMapMaintenanceResult | { error: string };
      error?: string;
    };
  };
  telemetry: RepoContextTelemetrySnapshot;
  failures: readonly BoundedFailure[];
}

interface RepoContextDiagnosticStatusPayload extends RepoContextStatusPayload {
  project?: { id: string; root: string; stateRoot: string; mapRoot: string };
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function addFailure(runtime: RuntimeState, component: FailureComponent, _error: unknown): void {
  runtime.failures.push({ component, error: utf8Prefix(PUBLIC_ERRORS[component], MAX_FAILURE_BYTES) });
  if (runtime.failures.length > MAX_FAILURES) runtime.failures.splice(0, runtime.failures.length - MAX_FAILURES);
}

function markTruncated(payload: BoundedSearchPayload, field: string): void {
  if (!payload.truncatedFields.includes(field)) payload.truncatedFields.push(field);
}

function renderSearch(payload: BoundedSearchPayload): string {
  return JSON.stringify(payload, null, 2);
}

/** Deterministically removes complete rows/fields until the UTF-8 hard limit is met. */
export function boundSearchPayload(
  query: string,
  result: RepoMapRuntimeQuery,
  maxBytes: number,
  publicError?: string,
): { payload: BoundedSearchPayload; text: string } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512) throw new Error("searchMaxBytes must be at least 512 bytes");
  const payload: BoundedSearchPayload = {
    type: SEARCH_RESULT_TYPE,
    trust: SEARCH_TRUST,
    query,
    freshness: result.freshness,
    generation: result.generation,
    gitHead: result.gitHead,
    workspaceRevision: result.workspaceRevision,
    pendingFiles: [...result.pendingFiles],
    results: [...result.results],
    fallbackEvidence: result.fallbackEvidence.map((row) => ({ ...row })),
    truncatedFields: [],
    ...(result.error ? { error: publicError ?? PUBLIC_ERRORS.searchResult } : {}),
  };
  const bytes = () => Buffer.byteLength(renderSearch(payload), "utf8");
  while (bytes() > maxBytes && payload.fallbackEvidence.length > 0) {
    payload.fallbackEvidence.pop();
    markTruncated(payload, "fallbackEvidence");
  }
  while (bytes() > maxBytes && payload.results.length > 0) {
    payload.results.pop();
    markTruncated(payload, "results");
  }
  while (bytes() > maxBytes && payload.pendingFiles.length > 0) {
    payload.pendingFiles.pop();
    markTruncated(payload, "pendingFiles");
  }
  for (const field of ["query", "error", "workspaceRevision", "gitHead"] as const) {
    while (bytes() > maxBytes && Buffer.byteLength(payload[field] ?? "", "utf8") > 8) {
      const current = payload[field] ?? "";
      payload[field] = utf8Prefix(current, Math.max(8, Buffer.byteLength(current, "utf8") - 16)) as never;
      markTruncated(payload, field);
    }
  }
  if (bytes() > maxBytes) {
    // Fixed-shape fallback remains valid at the contract minimum of 512 bytes.
    payload.query = "";
    payload.gitHead = utf8Prefix(payload.gitHead, 8);
    payload.workspaceRevision = utf8Prefix(payload.workspaceRevision, 8);
    if (payload.error !== undefined) payload.error = utf8Prefix(payload.error, 8);
    for (const field of ["query", "gitHead", "workspaceRevision"] as const) markTruncated(payload, field);
  }
  const text = renderSearch(payload);
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("unable to render bounded repository search result");
  return { payload, text };
}

function unavailableQuery(message: string): RepoMapRuntimeQuery {
  return {
    results: [],
    freshness: "unsupported",
    generation: 0,
    gitHead: "no-head",
    workspaceRevision: "unavailable",
    pendingFiles: [],
    fallbackEvidence: [],
    error: message,
  };
}

export function isOutsideRelativePath(path: string): boolean {
  return isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`);
}

export function stateOutsideProjectTree(state: RepoContextProjectState): boolean {
  return isOutsideRelativePath(relative(state.projectRoot, state.stateRoot));
}

function boundedPaths(paths: readonly string[]): { rows: string[]; omitted: number } {
  const sorted = [...paths].sort();
  return { rows: sorted.slice(0, MAX_STATUS_PATHS), omitted: Math.max(0, sorted.length - MAX_STATUS_PATHS) };
}

function mapStatusDegraded(map: ReturnType<RepoMapController["status"]> | undefined): boolean {
  return (
    map?.freshness === "stale" ||
    map?.freshness === "unsupported" ||
    map?.error !== undefined ||
    (map?.maintenance !== undefined && "error" in map.maintenance)
  );
}

export function buildStatus(runtime: RuntimeState): RepoContextStatusPayload {
  const map = runtime.repoMap?.status();
  const pending = boundedPaths(map?.pendingFiles ?? []);
  const dirty = boundedPaths(map?.dirtyFiles ?? []);
  const mapFailure = [...runtime.failures].reverse().find((failure) => failure.component === "repo-map");
  const degraded = runtime.failures.length > 0 || mapStatusDegraded(map);
  const maintenance =
    map?.maintenance === undefined
      ? undefined
      : "error" in map.maintenance
        ? { error: PUBLIC_ERRORS.maintenance }
        : map.maintenance;
  return {
    extension: { id: EXTENSION_ID, version: EXTENSION_VERSION },
    initialized: runtime.initialized,
    enabled: runtime.config?.enabled ?? null,
    available: runtime.available,
    degraded,
    components: {
      repoMap: map
        ? {
            available: runtime.available,
            freshness: map.freshness,
            generation: map.generation,
            gitHead: map.gitHead,
            workspaceRevision: map.workspaceRevision,
            pendingCount: map.pendingFiles.length,
            pendingFiles: pending.rows,
            omittedPendingFiles: pending.omitted,
            dirtyCount: map.dirtyFiles.length,
            dirtyFiles: dirty.rows,
            omittedDirtyFiles: dirty.omitted,
            ...(maintenance ? { maintenance } : {}),
            ...(map.error !== undefined
              ? { error: PUBLIC_ERRORS.mapStatus }
              : mapFailure
                ? { error: mapFailure.error }
                : {}),
          }
        : { available: false, ...(mapFailure ? { error: mapFailure.error } : {}) },
    },
    telemetry: runtime.telemetry.snapshot(),
    failures: runtime.failures.map((failure) => ({ ...failure })),
  };
}

function buildDiagnosticStatus(runtime: RuntimeState): RepoContextDiagnosticStatusPayload {
  const status = buildStatus(runtime);
  if (!runtime.state) return status;
  return {
    ...status,
    project: {
      id: runtime.state.projectId,
      root: runtime.state.projectRoot,
      stateRoot: runtime.state.stateRoot,
      mapRoot: runtime.state.mapRoot,
    },
  };
}

function createRuntime(input: {
  projectRoot: string;
  mapRoot: string;
  config: RepoContextConfig;
  telemetry: RepoContextTelemetry;
}): RepoMapController {
  return new RepoMapRuntime({
    projectRoot: input.projectRoot,
    stateRoot: input.mapRoot,
    exclude: input.config.excludePatterns,
    mapDebounceMs: input.config.debounceMs,
    mapGenerationRetention: input.config.generationRetention,
    mapQuotaBytes: input.config.quotaBytes,
    telemetry: input.telemetry,
  });
}

function updateUi(ctx: ExtensionContext, runtime: RuntimeState): void {
  if (!ctx.hasUI) return;
  const status = buildStatus(runtime);
  const suffix = status.enabled === false ? " disabled" : status.degraded ? " degraded" : "";
  ctx.ui.setStatus(EXTENSION_ID, `repo-context v${EXTENSION_VERSION}${suffix}`);
}

export function registerRepoContext(pi: ExtensionAPI, options: RegisterRepoContextOptions = {}): void {
  const configLoader = options.loadConfig ?? loadConfig;
  const stateResolver = options.resolveProjectState ?? resolveProjectState;
  const runtimeFactory = options.runtimeFactory ?? createRuntime;
  const stdout = options.stdout ?? ((text: string) => console.log(text));
  let runtime: RuntimeState = {
    initialized: false,
    available: false,
    failures: [],
    telemetry: new RepoContextTelemetry(),
  };

  const dispose = async (): Promise<void> => {
    const map = runtime.repoMap;
    runtime.repoMap = undefined;
    runtime.available = false;
    if (map) {
      try {
        await map.close();
      } catch (error) {
        addFailure(runtime, "repo-map", error);
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await dispose();
    const next: RuntimeState = {
      initialized: false,
      available: false,
      failures: [],
      telemetry: new RepoContextTelemetry(),
    };
    try {
      next.state = await stateResolver(ctx.cwd);
      next.config = await configLoader(next.state.projectRoot);
      if (next.config.enabled) {
        const map = runtimeFactory({
          projectRoot: next.state.projectRoot,
          mapRoot: next.state.mapRoot,
          config: next.config,
          telemetry: next.telemetry,
        });
        next.repoMap = map;
        try {
          await map.start();
          next.available = true;
        } catch (error) {
          addFailure(next, "repo-map", error);
          try {
            await map.close();
          } catch (closeError) {
            addFailure(next, "repo-map", closeError);
          }
          next.repoMap = undefined;
        }
      }
    } catch (error) {
      addFailure(next, "initialization", error);
    }
    next.initialized = true;
    runtime = next;
    updateUi(ctx, runtime);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await dispose();
    runtime = {
      initialized: false,
      available: false,
      failures: [],
      telemetry: new RepoContextTelemetry(),
    };
    if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, undefined);
  });

  const executeSearch = async (params: { query: string; limit?: number }, deprecated: boolean) => {
    let result: RepoMapRuntimeQuery;
    let publicError: string | undefined;
    let isError = false;
    if (runtime.config?.enabled === false) {
      publicError = "Repository context is disabled.";
      result = unavailableQuery(publicError);
      isError = true;
    } else if (!runtime.available || !runtime.repoMap) {
      publicError = "Repository context is unavailable.";
      result = unavailableQuery(publicError);
      isError = true;
    } else {
      try {
        result = await runtime.repoMap.query(params.query, { limit: params.limit });
        isError = result.error !== undefined;
      } catch (error) {
        addFailure(runtime, "query", error);
        publicError = PUBLIC_ERRORS.query;
        result = unavailableQuery(publicError);
        isError = true;
      }
    }
    const maxBytes = runtime.config?.searchMaxBytes ?? 6 * 1024;
    const bounded = boundSearchPayload(params.query, result, maxBytes, publicError);
    return {
      content: [{ type: "text" as const, text: bounded.text }],
      details: deprecated
        ? { ...bounded.payload, deprecated: true as const, replacement: "repo_context_search" as const }
        : bounded.payload,
      ...(isError ? { isError: true } : {}),
    };
  };

  const searchParameters = Type.Object(
    {
      query: Type.String({ minLength: 1, maxLength: 512 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    },
    { additionalProperties: false },
  );
  pi.registerTool({
    name: "repo_context_search",
    label: "Repository Search",
    description: "Search the live revision-aware repository index with explicit freshness evidence.",
    parameters: searchParameters,
    execute: async (_toolCallId, params) => executeSearch(params, false),
  });
  pi.registerTool({
    name: "context_vault_repo_map",
    label: "Repository Map (deprecated)",
    description: "Deprecated alias for repo_context_search.",
    parameters: searchParameters,
    execute: async (_toolCallId, params) => executeSearch(params, true),
  });
  pi.registerTool({
    name: "repo_context_status",
    label: "Repository Context Status",
    description: "Report repository index lifecycle, freshness, state, and bounded telemetry.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const status = buildStatus(runtime);
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], details: status };
    },
  });

  const notify = (ctx: ExtensionCommandContext, value: unknown, type: "info" | "warning" | "error" = "info") => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (ctx.hasUI) ctx.ui.notify(text, type);
    else stdout(text);
  };

  pi.registerCommand("repo-context", {
    description: "Repository Context status|rebuild|doctor",
    getArgumentCompletions: (prefix) =>
      ["status", "rebuild", "doctor"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command === "status") {
        notify(ctx, buildDiagnosticStatus(runtime));
        return;
      }
      if (command === "doctor") {
        const status = buildDiagnosticStatus(runtime);
        notify(ctx, {
          status: status.enabled === false ? "disabled" : status.degraded ? "degraded" : "healthy",
          automaticInjection: false,
          configFile: ".pi/repo-context.json",
          legacyStateAccess: false,
          stateOutsideProjectTree: runtime.state ? stateOutsideProjectTree(runtime.state) : null,
          repoContext: status,
        });
        return;
      }
      if (command === "rebuild") {
        if (runtime.config?.enabled === false) {
          notify(ctx, "Repository context is disabled.", "warning");
          return;
        }
        if (!runtime.available || !runtime.repoMap) {
          notify(ctx, "Repository context is unavailable.", "error");
          return;
        }
        try {
          await runtime.repoMap.rebuild();
          const status = runtime.repoMap.status();
          if (mapStatusDegraded(status)) {
            addFailure(runtime, "rebuild", status.error ?? `rebuild completed with ${status.freshness} freshness`);
            notify(ctx, buildDiagnosticStatus(runtime), "error");
          } else {
            runtime.failures = runtime.failures.filter((failure) => failure.component !== "rebuild");
            notify(ctx, buildDiagnosticStatus(runtime));
          }
          updateUi(ctx, runtime);
        } catch (error) {
          addFailure(runtime, "rebuild", error);
          notify(ctx, buildDiagnosticStatus(runtime), "error");
          updateUi(ctx, runtime);
        }
        return;
      }
      notify(ctx, USAGE, "warning");
    },
  });
}
