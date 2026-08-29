# 0019 — Lazy repository-map startup

## Status

Accepted for issue #10.

## Contract

Session startup resolves project state and configuration only. An enabled repository remains `dormant` until the first
search or explicit rebuild. Lifecycle (`pre-session | disabled | dormant | warming | ready | failed | stopping`) is
reported separately from persisted repository freshness (`fresh | dirty | stale | unsupported`).

The first search creates exactly one runtime initialization promise. Concurrent searches share it and wait through a
fixed 250 ms waiter. If that logical budget expires, the Tool returns a normal degraded result with `warming` lifecycle,
stale freshness, unavailable revision fields, and explicit retry/direct-filesystem fallback evidence. Initialization
continues. JavaScript synchronous parsing cannot be preempted, so the budget is not a hard CPU cancellation deadline.
A settled initialization failure is sanitized and remains a hard unavailable Tool error.

Status and doctor do not call runtime status before initialization completes. Rebuild, shutdown, and replacement sessions
serialize behind initialization; each constructed controller is closed at most once, and disposed session epochs cannot
publish readiness into a replacement session.

## Compatible clean-generation reuse

Schema-1 generations may carry an additive SHA-256 `buildCompatibilityKey` over the admission compatibility version,
schema/generator, TypeScript and Java analyzers, and normalized configured exclusions. A missing legacy key remains
readable but forces one full rebuild.

A hydrated snapshot skips full base rebuilding only when project provenance and the compatibility key match, persisted
dirty/pending evidence is empty, freshness is `fresh` or analyzer-derived `unsupported`, Git HEAD is unchanged, Git status
succeeds and is clean, and watcher attachment/reconciliation remains stable through a second HEAD/status verification.
Custom file-system semantics conservatively force a rebuild. Fast reuse publishes a live checkpoint but does not activate
a semantically unchanged generation.

Any failed check, changed HEAD, dirty worktree, watcher race, old analyzer/key, or Git-status failure uses the existing
authoritative full rebuild. Storage remains a single bounded generation; this change does not introduce index sharding.

## Performance evidence

`tests/repo-map-startup-benchmark.test.ts` creates 3,000 source files. CI asserts phase/work avoidance (zero full builds,
source reindexing, and generation writes on compatible warm reuse), not a flaky duration threshold. The documented
reference target is under 100 ms session-start overhead and under 2 seconds to ready on the unchanged warm path; the test
prints cold/warm phase telemetry for diagnostic runs.
