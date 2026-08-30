# 0021 — Bounded stale-pending search fallback

## Status

Accepted for Repo Context 0.1.x. This specification extends Specs 0007 and 0020 without changing bounded flush or coherent snapshot semantics.

## Decision

A live `RepoMapRuntime.query()` still performs the bounded reconciliation defined by the runtime. If the captured result remains `stale` and has pending paths, the runtime may perform one private, read-only lexical scan of exactly that captured set. `queryCurrent()` remains snapshot-only and never invokes this scan.

The direct evidence is point-in-time source evidence. It does not advance a generation, consume pending work, update dirty hashes, or alter `workspaceRevision`; the response therefore retains the captured stale freshness, revision, generation, and pending paths. Notification, activation, close, or content-version races retire and discard scanned evidence.

## Admission and bounds

Every supplied candidate consumes the path-count and UTF-8 path-byte envelope before normalization, deduplication, exclusion, or ignore filtering. Candidate order is deterministic after normalization. Built-in and configured exclusions always apply.

Git admission uses one bounded `git ls-files --cached --others --exclude-standard` operation and intersects its output with the candidates. This preserves tracked files that are now ignored and rejects ignored untracked files. Only an explicit `not a git repository` result under the C locale permits the hardened root-`.gitignore` non-Git path; every ambiguous Git failure fails closed.

Candidate reads reuse Spec 0020's identity checks, no-follow/canonical containment, binary detection, file/source/count/concurrency/deadline/result/excerpt bounds, and cancellation. Before that scan, live indexed-source and Git-diff evidence share a 250 ms logical envelope, with at most three 4 KiB source reads and a 16 KiB Git diff; the native source path reads only the bounded prefix and Git receives both an abort signal and a 16 KiB subprocess buffer cap. The batch is published atomically, so retirement retains only coherent indexed evidence rather than partial live evidence.

The scanner's 2,000 ms deadline is independently enforced by its runtime wrapper. Successful scanner output is revalidated using Spec 0020's output limits; every result/evidence/classification path must normalize to a contained captured candidate, result/evidence must be paired, and malformed or oversized output fails closed. The logical deadline and cancellation return are hard: directory enumeration, hooks, file operations, and batches are raced against retirement. Node/OS operations may continue, but every late settlement stays observed; closure of already-owned handles is initiated immediately and late-opened handles initiate closure when they arrive. Logical return does not claim OS cancellation or closure completion, and timed-out/cancelled scans publish no evidence. Count and byte limits remain hard. Runtime close, session replacement, notification, and every snapshot activation (including semantic no-op activation) abort in-flight pending scans, and timed-out or cancelled scanner output is never merged. Windows drive-qualified relative paths and cross-drive notifications are rejected lexically on every host.

## Ranking and evidence

Case-insensitive full-query literals in pending source or path rank before indexed results. Indexed ranking is preserved next, followed by component-only pending matches. Paths are deduplicated, preferring current pending result/evidence. The requested limit is applied after merging. A pending result is returned only with same-path source or explicit path evidence; pathless Git diff evidence may follow paired evidence.

## Telemetry

The aggregate lexical fallback counters cover both warming scans and stale-pending scans: attempts, used/no-match, capped, timeout, cancelled, duration, files, bytes, and returned pending matches. Each attempt records exactly one terminal outcome in priority order: cancelled, timeout, capped, used, then no-match. Timed-out or cancelled scans contribute zero returned matches. Queries, paths, excerpts, and source content are never retained.
