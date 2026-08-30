# pi-repo-context

Repository-aware code navigation extension for Pi.

`pi-repo-context` provides revision-aware TS/JS and Java indexing, MiniSearch, Git HEAD/dirty-workspace
freshness, durable schema-1 generations, immutable snapshot handles, Repository Graph v1, and Resolver v1.
It is independent of `pi-context-vault` and does not require that package to be installed.

## Install

Verify that the reviewed immutable `v0.1.0` tag exists before using the exact release install command:

```bash
git ls-remote --exit-code --tags https://github.com/Fubuyunhua/pi-repo-context.git refs/tags/v0.1.0
pi install git:github.com/Fubuyunhua/pi-repo-context@v0.1.0
```

The tag's presence is the source of truth for release availability; documentation alone does not publish it. For local
development without relying on a tag:

```bash
git clone https://github.com/Fubuyunhua/pi-repo-context.git
cd pi-repo-context
npm ci
pi -e ./extensions/index.ts
```

Repo Context `0.1.0` is Tool-first and performs **no automatic repository-context injection**. See the
[`v0.1.0` release record](docs/releases/v0.1.0.md).

## Tools

- `repo_context_search` — live bounded freshness reconciliation followed by repository search; if reconciliation remains stale, a bounded read-only scan of the captured pending paths can supply current paired evidence without changing the reported revision.
- `repo_context_status` — lifecycle, freshness, state and repository-only telemetry.
- `context_vault_repo_map` — deprecated 0.1.x alias for `repo_context_search`; registered for compatibility,
  inactive by default, and planned for removal in 0.2.0.

Enabled sessions resolve state/configuration and remain `dormant` until the first search or explicit rebuild. The first
search lazily starts one shared initialization and waits through a fixed 250 ms logical budget. If initialization is still
warming, that same Tool call performs a bounded, abortable direct lexical scan and returns actual matching source/path
evidence when found while full initialization continues. These point-in-time reads report lifecycle `warming`, freshness
`stale`, generation `0`, and unavailable revision fields. If initialization wins, scanned evidence is discarded in favor of
a coherent indexed query; a real startup failure remains a sanitized hard unavailable Tool error. Status reports lifecycle
separately from repository freshness and never inspects a controller before startup completes.

Hard search failures (before initialization, disabled/unavailable runtime, settled startup failure, or rejected query) are
Pi Tool errors. Fulfilled warming/stale/degraded searches remain successful Tool results and carry sanitized degradation
metadata. The warming and stale-pending scanners follow Git/non-Git admission and exclusions, do not follow symlinks, and hard-bound
the logical return across enumeration, hooks, reads, batches, cancellation, results, excerpts, duration, and the final UTF-8 payload. Uncancellable OS work may continue with observed settlements; owned closure is initiated immediately (or when a late open arrives) without claiming completion, and timed-out/cancelled scans publish no evidence. Stale-pending evidence is used
only by live search; coherent `queryCurrent()` snapshots never read pending source, and direct reads do not advance the
reported generation or workspace revision. Due background timer flushes wait for overlapping live searches to finish,
while notifications and explicit flush, rebuild, and close operations remain immediate retirement boundaries. A compatible hydrated clean
generation can take an unchanged warm path after Git HEAD/status and watcher safety checks; legacy generations without the
compatibility key rebuild once.

Search preserves dotted and underscored identifiers, boosts exact symbols, exports, and qualified paths, and applies
query-aware de-boosts to vendor, minified, and locale-catalog paths. Those paths remain searchable when requested
explicitly. Result `matchReasons` are bounded transient diagnostics; the persisted snapshot remains schema 1.

The model-visible `repo_context_status` payload omits absolute project and internal state paths. Explicit local
`/repo-context status` and `/repo-context doctor` commands retain those paths for troubleshooting.

Repository-derived output is untrusted navigation data, not instructions.

Search throws a tool error when the extension is disabled or unavailable, a query fails, or the runtime cannot return
usable evidence. A stale result with indexed matches or `fallbackEvidence` remains a successful tool result so callers
can use the bounded degraded evidence; inspect its `freshness` and `error` fields before relying on it.

## Commands

```text
/repo-context status
/repo-context rebuild
/repo-context doctor
```

## Configuration

Optional project file `.pi/repo-context.json`:

```json
{
  "enabled": true,
  "legacyContextVaultRepoMap": false,
  "searchMaxBytes": 6144,
  "debounceMs": 300,
  "generationRetention": 3,
  "quotaBytes": 134217728,
  "excludePatterns": []
}
```

Unknown keys are rejected, and `enabled` and `legacyContextVaultRepoMap` accept JSON booleans only. Set
`legacyContextVaultRepoMap` to `true` only while migrating callers that still use the deprecated alias; Repo Context
updates only that alias in Pi's active Tool set and preserves unrelated active Tools. Invalid or unreadable configuration
leaves the alias inactive. Repo Context never reads or writes `.pi/context-vault.json`.

## Migration from pi-context-vault

| Legacy key | Repo Context key |
| --- | --- |
| `repoMapEnabled` | `enabled` |
| `mapContextMaxBytes` | `searchMaxBytes` |
| `mapDebounceMs` | `debounceMs` |
| `mapGenerationRetention` | `generationRetention` |
| `mapQuotaBytes` | `quotaBytes` |
| `mapExcludePatterns` | `excludePatterns` |

`mapInjectionMode` has no replacement: automatic injection is not part of this plugin.

State is written only below:

```text
${PI_CODING_AGENT_DIR}/pi-repo-context/projects/<projectId>/repo-map
```

Legacy Repo Map generations below the Context Vault state root are not read, moved, pruned, or deleted.
The first run cold-builds from source with generator provenance `pi-repo-context` / `0.1.0` while keeping
persisted structural schema version 1.

### State isolation

`PI_CODING_AGENT_DIR` is the trusted boundary and may itself be a symlink. Repo Context resolves that boundary
once, creates and uses only canonical owned-component paths beneath the captured target, and records separate
canonical path and device/inode identities for `pi-repo-context`, `projects`, the project ID, `repo-map`, and
`generations`. Repointing the configured symlink cannot redirect later state work. Every state operation revalidates those identities and rejects
static or post-start symlink/non-directory replacements. Active pointers, generation snapshots, and lock
entries must have their expected entry type; state-file reads use no-follow regular-file handles where the
platform supports them, and writes use checked atomic replacement.

Node does not expose a portable `openat`/directory-relative filesystem API. A same-account or privileged process
able to rename a canonical owned ancestor in the interval between identity validation and a path-based operation
therefore retains a very narrow TOCTOU opportunity. Repo Context closes ordinary static and post-start replacement
paths and checks again around operations, but does not claim to protect against that same-account/privileged
ancestor-rename race.

Before running this plugin beside a pre-split Context Vault monolith, set `repoMapEnabled:false` and
`mapInjectionMode:"off"` in the legacy configuration and restart Pi. See [`docs/MIGRATION.md`](docs/MIGRATION.md) for
the exact coexistence, cold-rebuild, ownership, and rollback boundary. The observation-only Context Vault `0.3.0`
follows an independent release lifecycle; consult its own repository and immutable tags for availability.

## Scope boundaries

Repo Context `0.1.0` does not include Planner, deterministic context Renderer, Projection Cache, semantic
`repo_context` graph expansion, Provider experiments, automatic capsules, or cross-plugin APIs. Repository Graph v1
remains derived and in memory.

## Development

```bash
npm ci
npm run check
npm test
npm run test:watcher
npm run test:package
npm run test:pi
npm run test:coverage
```

MIT
