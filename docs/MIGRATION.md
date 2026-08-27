# Migration from the pre-split Context Vault repository map

This document describes the approved split transition. It does not claim that the separate Phase 5 cleanup
of `pi-context-vault` has already shipped.

## Safe coexistence during migration

A pre-split Context Vault monolith and Repo Context must not both run repository-map watchers or own the
legacy Tool in the same session. Before installing/enabling Repo Context beside the monolith:

1. Set `repoMapEnabled` to `false` and `mapInjectionMode` to `"off"` in `.pi/context-vault.json`.
2. Restart Pi into a new session.
3. Configure Repo Context independently in `.pi/repo-context.json`.

Repo Context never reads the old config file and provides no automatic context injection.

## Configuration mapping

| Pre-split key | Repo Context key |
| --- | --- |
| `repoMapEnabled` | `enabled` |
| `mapContextMaxBytes` | `searchMaxBytes` |
| `mapDebounceMs` | `debounceMs` |
| `mapGenerationRetention` | `generationRetention` |
| `mapQuotaBytes` | `quotaBytes` |
| `mapExcludePatterns` | `excludePatterns` |

`mapInjectionMode` has no Repo Context equivalent.

## State and cold rebuild

Repo Context writes only below:

```text
${PI_CODING_AGENT_DIR}/pi-repo-context/projects/<projectId>/repo-map
```

It never reads, adopts, moves, prunes, or deletes the legacy derived state below the Context Vault root. Its
first startup cold-builds from source. Observation artifacts and metadata remain entirely owned by Context
Vault.

## Tools and commands

Use `repo_context_search`, `repo_context_status`, and `/repo-context status|rebuild|doctor`.
`context_vault_repo_map` is a deprecated Repo Context 0.1.x alias planned for removal in 0.2.0.

The approved future post-split Context Vault compatibility release will make `/context-vault rebuild` a
non-executing migration stub with this response:

```text
Repository rebuild has moved to pi-repo-context.
Install pi-repo-context and use /repo-context rebuild.
```

That Vault-side change belongs to Phase 5 and is **not implemented by Repo Context Phase 3**. Likewise, the
approved future `/context-vault gc` will collect only Vault artifacts/metadata/leases; until Vault Phase 5 is
implemented, consult the installed Vault version rather than assuming that changed scope.

## Rollback

1. Stop, disable, or uninstall Repo Context without deleting its state.
2. Restart Pi.
3. If required, re-enable the pre-split monolith's repository settings in `.pi/context-vault.json`.
4. Restart Pi again before using the legacy Tool/watcher.

No state conversion is required because the roots never overlap. Rollback must not delete either state root
or any Observation artifact.
