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

### Fixed
- `hotspot_history`/`decision_outcomes`/`validity_history` column bugs in
  incident builders.
- `adrs.created_at` plus missing `DriftStore`/`KnowledgeHotspotStore` wiring
  it had been masking.

### Security
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
