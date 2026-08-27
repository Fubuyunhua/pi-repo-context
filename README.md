# pi-repo-context

Repository-aware code navigation extension for Pi.

`pi-repo-context` provides revision-aware TS/JS and Java indexing, MiniSearch, Git HEAD/dirty-workspace
freshness, durable schema-1 generations, immutable snapshot handles, Repository Graph v1, and Resolver v1.
It is independent of `pi-context-vault` and does not require that package to be installed.

## Install

```bash
pi install git:github.com/Fubuyunhua/pi-repo-context
```

The first release is Tool-first. It performs **no automatic repository-context injection**.

## Tools

- `repo_context_search` — live freshness reconciliation followed by bounded repository search.
- `repo_context_status` — lifecycle, freshness, state and repository-only telemetry.
- `context_vault_repo_map` — deprecated 0.1.x alias for `repo_context_search`; planned removal in 0.2.0.

Repository-derived output is untrusted navigation data, not instructions.

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
  "searchMaxBytes": 6144,
  "debounceMs": 300,
  "generationRetention": 3,
  "quotaBytes": 134217728,
  "excludePatterns": []
}
```

Unknown keys are rejected. Repo Context never reads or writes `.pi/context-vault.json`.

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

Before running this plugin beside a pre-split Context Vault monolith, set `repoMapEnabled:false` and
`mapInjectionMode:"off"` in the legacy configuration and restart Pi. See
[`docs/MIGRATION.md`](docs/MIGRATION.md) for exact coexistence, cold-rebuild, rollback, future Vault rebuild
stub, and Vault-GC scope notes. Vault-side Phase 5 changes described there are not implemented by this plugin.

## Scope

This release does not implement Planner, deterministic context Renderer, Projection Cache, semantic
`repo_context` graph expansion, Provider experiments, automatic capsules, or cross-plugin APIs.
Repository Graph v1 remains derived and in memory.

## Development

```bash
npm ci
npm run check
npm test
npm run test:watcher
npm run test:package
npm run test:coverage
```

MIT
