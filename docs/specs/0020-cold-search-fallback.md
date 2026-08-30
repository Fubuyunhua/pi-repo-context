# 0020 — Bounded cold-search lexical fallback

## Status

Accepted for Repo Context 0.1.x. This specification extends, and does not replace, Spec 0019.

## Decision

Enabled `session_start` remains dormant and performs no eager repository indexing. A first search starts exactly one shared
initialization and retains the existing 250 ms logical readiness grace. If initialization is still warming after that grace,
the same Tool call runs a direct, read-only lexical repository scan while full initialization continues.

If initialization finishes during the scan, the scan is aborted and discarded and the coherent indexed query wins. A
settled startup failure remains a sanitized hard unavailable error. Session replacement and shutdown abort scans before
waiting for active work; caller Tool cancellation does likewise, and epoch checks prevent evidence from a retired project from being returned.

A lexical response is intentionally conservative: lifecycle `warming`, freshness `stale`, generation `0`, unavailable Git
HEAD/workspace revision, and no pending-file claims. Each result has actual literal query-term support and is paired with
match-centered source evidence or explicit path-only evidence. No match within the work envelope is reported honestly;
relevance is never fabricated.

## Admission and safety

Git projects enumerate the equivalent of `git ls-files --cached --others --exclude-standard`, so tracked files remain
eligible even if a later ignore rule matches them. Non-Git projects use a bounded streaming iterative walk and root
`.gitignore` semantics. Both paths apply built-in and configured exclusions. Every observed Git path or non-Git directory
entry consumes the path/byte envelope before admission filtering. Only project-relative regular files are read; symlinks
are not followed, canonical paths outside the project are rejected, and the opened file identity must match the validated
entry before content is read. Binary, unreadable, disappearing, replaced, and non-regular files are skipped.

## Fixed envelope

- 2,000 ms logical scan deadline
- 100,000 observed paths/directory entries and 8 MiB enumeration data
- 256 KiB root `.gitignore`; oversized, unreadable, non-regular, replaced, or symlinked ignore files fail closed
- 256 configured exclusion patterns and 64 KiB total exclusion text, compiled once per scan
- 20,000 files and 32 MiB source data
- 512 KiB per file, four concurrent reads
- at most `min(requested limit, 20)` results
- 512 UTF-8 bytes per match-centered excerpt
- successful scanner output is revalidated at the caller boundary: at most 20 result/evidence pairs, 4 KiB UTF-8 paths, 512-byte excerpts, eight 256-byte reason fields, and no symbol payload; oversized or malformed output fails closed

The 2,000 ms deadline is independently enforced by the caller wrapper as well as the built-in scanner, so an injected scanner that ignores its signal cannot extend logical return. The logical return deadline and cancellation are hard: filesystem operations and hooks are raced against retirement, and timed-out/cancelled scans publish no evidence. Node/OS operations that cannot be cancelled may continue after logical return; every settlement remains observed, closure of every owned open handle is initiated immediately, and late-opened handles initiate closure when they arrive. Logical return does not claim that OS work or closure has completed. File/path/byte/result limits are hard work limits. Evidence is
not guaranteed when a repository has no literal match, a match lies beyond the envelope, or a path/evidence pair cannot fit
the configured payload minimum. When enumeration reaches a cap, the admitted subset can depend on filesystem directory
iteration order; ranking within the captured subset remains deterministic.

## Ranking and payload

Queries retain linked dotted, underscored, and path identifiers while also scoring their components. Ranking is stable by
term coverage, exact content/path support, and project-relative path. Payload bounding trims UTF-8 only at code-point
boundaries, trims excerpts before removing the highest-ranked pair, removes result/evidence tails together, and uses compact
JSON when needed. It never exceeds `searchMaxBytes`.

## Telemetry

Telemetry is aggregate-only. It distinguishes accepted searches, indexed returns, warming-empty returns, fallback attempts,
used/no-match/capped/timeout/cancelled scans, and aggregate duration/files/bytes/matches. Queries, paths, excerpts, and file
content are never retained.
