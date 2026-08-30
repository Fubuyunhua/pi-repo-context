# 0021 — Bounded stale-pending search fallback

## Status

Accepted for Repo Context 0.1.x. This specification extends Specs 0007 and 0020 without changing bounded flush or coherent snapshot semantics.

## Decision

A live `RepoMapRuntime.query()` still performs the bounded reconciliation defined by the runtime. If the captured result remains `stale` and has pending paths, the runtime may perform one private, read-only lexical scan of exactly that captured set. `queryCurrent()` remains snapshot-only and never invokes this scan.

The direct evidence is point-in-time source evidence. It does not advance a generation, consume pending work, update dirty hashes, or alter `workspaceRevision`; the response therefore retains the captured stale freshness, revision, generation, and pending paths. Notification, activation, close, or content-version races retire and discard scanned evidence.

## Admission and bounds

Every supplied candidate consumes the path-count and UTF-8 path-byte envelope before normalization, deduplication, exclusion, or ignore filtering. Candidate order is deterministic after normalization. Built-in and configured exclusions always apply.

Git admission uses one bounded `git ls-files --cached --others --exclude-standard` operation and intersects its output with the candidates. This preserves tracked files that are now ignored and rejects ignored untracked files. Only an explicit `not a git repository` result under the C locale permits the hardened root-`.gitignore` non-Git path; every ambiguous Git failure fails closed.

Candidate reads reuse Spec 0020's identity checks, no-follow/canonical containment, binary detection, file/source/count/concurrency/deadline/result/excerpt bounds, and cancellation. The logical deadline and cancellation return are hard: directory enumeration, hooks, file operations, and batches are raced against retirement; late settlements are observed and late-opened handles are closed without publishing partial evidence. Count and byte limits remain hard. Runtime close, session replacement, notification, and snapshot activation abort in-flight pending scans, and timed-out or cancelled scanner output is never merged.

## Ranking and evidence

Case-insensitive full-query literals in pending source or path rank before indexed results. Indexed ranking is preserved next, followed by component-only pending matches. Paths are deduplicated, preferring current pending result/evidence. The requested limit is applied after merging. A pending result is returned only with same-path source or explicit path evidence; pathless Git diff evidence may follow paired evidence.

## Telemetry

The aggregate lexical fallback counters cover both warming scans and stale-pending scans: attempts, used/no-match, capped, timeout, cancelled, duration, files, bytes, and returned pending matches. Each attempt records exactly one terminal outcome in priority order: cancelled, timeout, capped, used, then no-match. Timed-out or cancelled scans contribute zero returned matches. Queries, paths, excerpts, and source content are never retained.
