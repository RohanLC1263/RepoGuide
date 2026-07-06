# Change Log

All notable changes to the "repoguide" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Discipline going forward

- Every merged change that a user or contributor would notice (a new command, a
  behavior change, a bug fix, a security fix) gets an entry here **in the same
  change**, not as a follow-up. This mirrors the per-language `*_SEMANTIC_PROVIDER_REPORT.md`
  reports and `RELEASE_ENGINEERING_REPORT.md`: real, dated, specific -- not "various fixes."
- Entries land under `[Unreleased]` as they merge. When `package.json`'s `version`
  is bumped for an actual release, the `[Unreleased]` heading is renamed to that
  version with today's date, and a fresh empty `[Unreleased]` section is added above it.
- Categories, in order, only when non-empty: `Added`, `Changed`, `Fixed`, `Security`, `Removed`.

## [Unreleased]

### Added
- Semantic/fact-extraction (`SemanticProvider`) support for seven languages --
  TypeScript, Python, Java, C#, Go, Rust, and C++ -- registered in shadow mode
  (computed on every indexed file, not yet authoritative for query answers).
  See `REPOGUIDE_AUDIT.md` §6 and each language's own `*_SEMANTIC_PROVIDER_REPORT.md`.
- Real IVF_PQ ANN index for LanceDB with paginated internal table scans.
- Lucene-style sealed segments for BM25, replacing full-blob rewrites on every update.
- Priority-ordered file walk with a configurable budget and surfaced truncation,
  so large workspaces get the most useful files indexed first instead of an
  arbitrary subset.
- A "Capabilities" launcher section in the Orientation panel, reaching every
  other real panel-opening command from one place (see `UX_CONSOLIDATION_REPORT.md`).
- `.github/workflows/ci.yml` -- compile, lint, and headless unit tests on push/PR.
- A shared `resolveWorkspaceFilePath` helper (`src/ui/workspacePathResolver.ts`)
  enforcing that citation/navigation file paths stay inside the workspace root.

### Changed
- Consolidated onto a single canonical query path (removed a competing legacy
  query pipeline split).
- `explainPanel.ts` and `docReportPanel.ts` migrated to the shared `wrapHtml()`
  design-system shell instead of bespoke/duplicated CSS.
- `docs/evaluation-harness.md`'s `provenanceAccuracy` metric is now a partial,
  disclosed heuristic (citation-presence + hedge-language detection) instead of
  an unconditional `null` requiring manual review for every question.
- Bounded worker-pool concurrency for full-index embedding, fixing a lazy-init race.
- The evidence-answer system prompt (`src/prompts/evidencePrompt.ts`) is redesigned from
  a flat, quote-forbidding "strict extraction bot" framing to one that asks the model to
  synthesize related evidence items into one coherent, cross-referenced explanation
  (every factual claim still requires a citation), and evidence chunks are now grouped by
  file in the prompt instead of listed in isolation. Verified with a full 7-language
  golden-question eval suite run before/after (axios, httpx, httpclient, cpr, reqwest,
  restsharp, resty) and a synthesis-style false-positive test batch beyond the original
  single example; landed together with three `AnswerGate` fixes (see next commit) that
  closed gaps the richer synthesis style newly exercised.

### Fixed
- `hotspot_history`/`decision_outcomes`/`validity_history` column bugs in
  incident builders.
- `adrs.created_at` plus missing `DriftStore`/`KnowledgeHotspotStore` wiring
  it had been masking.
- `LogicalUnitStore`/`FactStore` were lowercasing a file's persisted `filePath`
  at write time (originally a lookup-key normalization, mistakenly applied to
  the stored value too), silently diverging it from the same row's `id` for
  any path containing uppercase letters. Found via real-world testing against
  a repo with mixed-case directory names. Both stores now preserve real
  casing in the stored value and use a shared `normalizeFilePathForLookup()`
  helper (`src/store/pathNormalization.ts`) only for matching keys.
  **Existing on-disk indexes built before this fix still have the wrong
  casing baked into already-written rows** -- there is no schema-version
  mechanism that detects this and triggers an automatic reindex (confirmed:
  none exists for these two SQLite stores today). Run "RepoGuide: Re-sync
  Index" once after upgrading to pick up the fix; the defensive fallback
  below covers citations in the meantime.
- `EvidencePacketBuilder` now normalizes every evidence item's `.file` to one
  canonical, workspace-relative, forward-slashed form at read time -- some
  providers (symbol-index-derived items) reported absolute paths while others
  (fact/annotation-derived) reported relative ones, so the same real file
  could be cited twice under two different string forms in one answer.
- The retrieval-quality log line previously labeled "Coverage" (e.g. the
  alarming-looking "Coverage: 0.00" seen during real-world testing on broad
  "explain X" questions) is renamed to "Fact-type match ratio" and now says
  plainly that it's diagnostic-only. It measures whether the query planner's
  requested fact *types* were found -- normally and correctly 0.00 for
  questions that don't target a specific fact type -- and was never the number
  that drives the confidence badge (that's `packet.coverageScore`, a
  different, `requiredEvidence`-based metric). Both are now commented at their
  definition site to prevent re-conflating them.
- `AnswerGate`'s numeric-claim check now tolerates a specific in-function line-number
  reference (e.g. "at line 900", or one end of a hyphenated range like "900-927") when it
  falls within an already-cited evidence item's real line span, even though the number
  itself isn't a literal substring of the evidence blob (only the item's own start-end
  boundary text is). Previously any such claim triggered a whole-answer block under
  `exact`/`grounded` confidence modes -- found via the before/after eval regression check
  for the evidence-prompt redesign (previous commit), which encourages more granular,
  specific claims.
- `AnswerGate`'s fallback-chain ordering check compared each chain fact's symbol position
  via `answer.indexOf(f.symbol)` from the start of the answer every time, so a symbol that
  legitimately recurs across multiple chain facts (e.g. the same class name at several
  steps of a chain) was compared against its own static first occurrence repeatedly and
  flagged as "out of order" against itself -- confirmed in a real transcript where one
  symbol was flagged 4 times in a single answer. Now tracks a monotonically-advancing
  search cursor instead, so a repeated symbol is only compared against where the previous
  chain fact was actually found.

### Security
- A single retrieval channel (vector, BM25, or PageRank) that errors is no
  longer silently absorbed into an unqualified "success" just because a
  sibling channel still returned evidence -- found via real-world testing
  where a Lance vector-search failure on every query in a session never
  surfaced to the user, despite a healthy-looking confidence badge on every
  answer. `HybridRetrievalProvider`/`RetrievalOrchestrator` now track
  per-channel failures and, when the failed channel was weighted meaningfully
  by the query's routed retrieval strategy, surface a real gap on the answer
  ("evidence does not determine...") instead of hiding the failure.
- A specific, recognized failure shape (a Lance manifest referencing a data
  fragment missing from disk -- `LanceError(IO): ...Not found: ....lance`) is
  now detected directly and treated as index corruption: it surfaces an
  actionable warning ("run 'RepoGuide: Re-sync Index'") instead of silently
  returning empty vector-search results for the rest of the session. The
  underlying trigger for this corruption was investigated at length but never
  conclusively reproduced (OneDrive sync and RepoGuide's own file-watcher were
  ruled out directly; a targeted concurrent read-during-write race test at
  real corpus scale did not reproduce it either) -- this detects and mitigates
  the symptom rather than a confirmed root cause.
- `AnswerGate` now verifies quoted code against the real, freshly-read file
  it's attributed to (not just "does this text appear somewhere in the
  retrieved evidence"), catching a real quote from one cited file being
  misattributed to another. A second, independent check catches false
  "these files are identical" claims by diffing the real files. See
  `HALLUCINATION_INVESTIGATION_REPORT.md`/`HALLUCINATION_FIX_REPORT.md`.
- The quote-verification above only recognized double-quoted `"..."` strings; a fenced
  ` ```code``` ` block making the same "this is real code" claim was never checked at all.
  Found while regression-testing the evidence-prompt redesign (two commits back), which
  explicitly invites short illustrative code fragments: a fabricated method with
  fabricated calls, presented as "a simplified example," passed `AnswerGate` silently.
  The same fresh-from-disk, per-citation content check now also covers fenced code blocks.
- `resolveWorkspaceFilePath()` now falls back to a case-insensitive directory
  walk on non-Windows platforms when the direct path doesn't exist --
  defense-in-depth for citations built with the wrong casing (from the
  store-layer bug above, or any future bug of the same shape), so citation
  click-through and existence checks degrade gracefully on case-sensitive
  filesystems (Linux CI, Docker, most cloud deploy targets) instead of
  silently failing.
- `.vscodeignore` now excludes vendored eval/test corpora, this tool's own
  local self-index, and dev-only virtualenvs -- a real, severe packaging bug:
  confirmed via `vsce ls` that 87,630 files (multiple gigabytes, including
  full third-party repositories) would have shipped in the `.vsix` before this
  fix, versus 9,411 after.
- Fixed an unvalidated-path-open pattern repeated across 5 files (a citation
  or note file path could, once clicked, open an arbitrary file outside the
  workspace if it originated from hallucinated or repository-embedded content).
- Added explicit untrusted-content framing to every prompt that includes
  retrieved repository content, instructing the model to never follow
  instructions embedded in code comments, strings, or docstrings.
- `fileWalker.ts` now explicitly skips symlinks during indexing (made
  self-documenting rather than an implicit fallthrough of Node's `Dirent` API).

## [0.0.1]

- Initial scaffold.
