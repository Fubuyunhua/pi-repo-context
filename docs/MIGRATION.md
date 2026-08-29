# Migration from the pre-split Context Vault repository map

This document describes the Repo Context `0.1.0` migration boundary. The observation-only Context Vault `0.3.0`
follows an independent release lifecycle; this document makes no claim about the presence of its tag or publication.
Consult the Vault repository and its immutable tags for availability.

## Safe transition

A pre-split Context Vault monolith and Repo Context must not both own repository-map Tools or run repository watchers in
the same session. Before starting Repo Context beside or instead of the monolith:

1. Set `repoMapEnabled` to `false` and `mapInjectionMode` to `"off"` in `.pi/context-vault.json`.
2. Stop the old session and restart Pi into a new session.
3. Configure Repo Context independently in `.pi/repo-context.json`.

Do not treat disabling only one setting, hot-loading the split plugin, or retaining the old session as safe coexistence.
Repo Context is Tool-first and provides no automatic context injection.

## Configuration mapping

| Pre-split key | Repo Context key |
| --- | --- |
| `repoMapEnabled` | `enabled` |
| No pre-split equivalent | `legacyContextVaultRepoMap` (default `false`) |
| `mapContextMaxBytes` | `searchMaxBytes` |
| `mapDebounceMs` | `debounceMs` |
| `mapGenerationRetention` | `generationRetention` |
| `mapQuotaBytes` | `quotaBytes` |
| `mapExcludePatterns` | `excludePatterns` |

`mapInjectionMode` has no Repo Context equivalent. `legacyContextVaultRepoMap` is a strict JSON boolean and controls
only whether Repo Context activates its deprecated Tool alias. Leave it `false` for new callers. Set it to `true` only
for a bounded migration period, then move callers to `repo_context_search`. Invalid or unreadable configuration fails
closed with the alias inactive, and alias activation/deactivation preserves unrelated active Pi Tools.

## Ownership boundary

Repo Context owns `repo_context_search`, `repo_context_status`, `/repo-context status|rebuild|doctor`, and the
deprecated `context_vault_repo_map` `0.1.x` alias. The alias remains registered for compatibility but is inactive by
default; `legacyContextVaultRepoMap: true` activates it. The alias is planned for removal in Repo Context `0.2.0`.

The observation-only Context Vault `0.3.0` code line owns `/context-vault rebuild` as a non-executing migration stub
that directs users to `/repo-context rebuild`. Its `/context-vault gc` collects only Vault artifacts, metadata, and
leases; it does not collect Repo Context or legacy Repo Map state. Check the installed Vault version's own documentation
rather than assuming this boundary applies to a pre-split installation.

Neither plugin defines a cross-plugin API or runtime dependency.

## State and cold rebuild

Repo Context writes only below:

```text
${PI_CODING_AGENT_DIR}/pi-repo-context/projects/<projectId>/repo-map
```

It never reads, adopts, moves, prunes, or deletes legacy derived state below the Context Vault root. Its first startup
cold-builds from repository source. Observation artifacts and metadata remain entirely owned by Context Vault. Keep
both state roots during migration and rollback.

## Rollback

1. Stop and disable Repo Context without deleting its state.
2. Restart Pi.
3. If repository behavior must be restored, use the reviewed pre-split monolith, re-enable its repository settings,
   and restart Pi again before using its Tool or watcher.

No state conversion or deletion is required because the roots do not overlap.
