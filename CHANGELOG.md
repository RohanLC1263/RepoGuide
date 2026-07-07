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
- Query decomposition for genuinely multi-facet questions (architecture
  walkthroughs, multi-step flows): the planner's decomposition now reaches
  generation instead of being flattened into one retrieval pool. When a
  question qualifies, each ordered sub-question runs the full single-question
  pipeline -- its own retrieval, evidence packet, synthesis, and MANDATORY
  AnswerGate pass -- and the gate-approved parts are merged by one final
  generation call that is itself verified against the union of the
  sub-packets (demonstrated against a real induced failure: a merge that
  invented a config value from a nonexistent file was blocked and replaced by
  the verified-sections fallback). Blocked sub-answers become explicit "Not
  covered" disclosures, never silent holes. Triggering is deliberately rare
  and requires three independent signals to agree (deterministic complexity
  score >= 5, an allowlisted walkthrough-shaped query type, and 2+ validated
  sub-questions from the planner): measured trigger rate on the 25 real
  dogfood questions is 1/25 -- only the known multi-facet walkthrough fires,
  every single-topic question stays single-shot. Small-model reality,
  measured: a 7B planner told "most questions must NOT decompose" never emits
  sub-questions directly even when it simultaneously produces a perfect
  5-task decomposition in `retrievalTasks` -- so sub-questions are derived
  deterministically from 4+ distinct retrieval-task descriptions, with
  LLM-emitted `subQuestions` preferred whenever a (larger) model does emit
  them. Derived sub-questions are anchored with the master plan's
  store-validated symbol/file hints, expanded one hop through the unit store
  (an anchor's real unit content can nominate other identifiers that
  themselves resolve to real units -- never anything unvalidated): measured
  live, a lone anchor acted as a magnet converging every facet on one file,
  while the expanded pool (execute_mission + run_mission +
  MissionOrchestratorAgent) recovered the per-agent timeout facet
  (asyncio.wait_for, audit.log_error) that had degraded to an honest
  non-answer, and restored the correct agent ordering. Progress surfaces per
  part in the sidebar ("Part 2/5: ...") through the existing typed side-band,
  with real cancellation points between parts. Costs ~2.5-3.5x single-shot
  latency when it fires; kill-switch: `repoguide.decomposition.enabled`.
  Blocked sub-tasks get ONE retry with the gate's concrete rejection reasons
  in the prompt -- the retry semantics were chosen from a measured mechanism
  probe (`subTaskFlakinessProbe.ts`), not assumption: sub-task retrieval is
  bit-stable (identical packet and prompt hashes 6/6 runs) and generation
  near-deterministic on an identical prompt, so a blind re-retrieve or
  re-sample reproduces the same block; only a feedback-changed prompt flips a
  persistent failure pattern. Measured on the deterministically-blocked
  agents-roster facet: 0/6 first-try passes, 6/6 recovered with the feedback
  retry, and the recovered answer is a real grounded agent roster, not a
  pass-by-refusal. Retry output faces the same full gate -- one extra chance,
  never a lower bar.
- `AnswerGate`'s path check now also accepts a path that appears verbatim
  inside evidence CONTENT, not just among evidence file names -- data-artifact
  filenames like `mission_report.json`/`draft.json` exist only as string
  literals in the code that writes them and can never be evidence files, yet
  an answer citing where a report is written is quoting exactly what it read.
  Measured: this false positive deterministically blocked a correct
  persistence answer 6/6 runs; with the fix it passes 6/6 first-try. Claims
  about such a file's contents are still verified by the quote/fence/numeric
  checks; only the mention itself is legitimized.
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
- `buildLLMEvidencePlan()`'s generated `symbolHints`/`fileHints` are now validated against
  the real `LogicalUnitStore` (the same `searchBySymbol`/`getUnitsByFile` lookups
  retrieval itself performs) before being merged into the plan, discarding anything with
  no match and logging a diagnostic. The planner's prompt has zero grounding in the real
  repository -- confirmed directly: it receives only the question text and a JSON schema,
  nothing about this codebase's actual files or symbols -- so it can and does invent
  plausible-sounding hints wholesale (found dogfooding: Java Spring Boot annotations and
  file paths like `@PostMapping`/`controllers/ImageUploadController.java` generated for a
  pure-Python repo). Nothing previously checked its output before feeding it into
  high-trust injection points downstream (e.g. `HybridRetrievalFusion`'s seed-file score
  boost). `ExecutionPlanner` takes an optional `LogicalUnitStore` to enable this; callers
  without one (smoke-test scripts against a mock context) degrade to the pre-validation
  behavior rather than being forced to construct a real store.

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
- The fallback-chain cursor fix above still checked every `fallback_chain` fact in a
  packet as one global chain, so two facts that merely share a generic symbol name (e.g.
  "key") but come from genuinely unrelated files/units still triggered a false "out of
  order" flag -- found dogfooding against a real project, where a frontend UI component's
  unrelated "key" facts got pulled in as noise evidence for a backend auth question and
  blocked an otherwise-correct answer. The check now groups facts by the unit (falling
  back to file) they were extracted from before checking order, and collapses duplicate
  facts for the identical (unit, symbol) pair to their first occurrence -- confirmed via
  real data that a single unit can carry several byte-identical fallback_chain records,
  which previously demanded that many separate forward mentions of the same word.
- `MentorInsightRenderer`'s four insight blocks (Architecture Insights, Change Impact
  Analysis, Recommended Learning Path, Refactoring Opportunities) rendered unconditionally
  whenever a narrative summary string was present, even when every underlying structured
  list (affected files, major components, etc.) was empty -- since the summary is a fixed
  template, it's never itself empty, just sometimes degenerate (e.g. "prioritizing 0 files
  as structural entry points"). Found dogfooding: this appended a nonsensical trailing
  sentence to an otherwise-good answer. All four render methods now share one
  `hasSubstantiveContent()` gate and return an empty string when nothing structured backs
  the block, rather than each carrying its own ad hoc trigger condition.
- `AnswerGate`'s quoted-string check compared raw substrings, so a real docstring
  quoted at 7-space indentation vs the file's 8 blocked a whole correct answer
  (found dogfooding, fc-09) -- and, the deeper mechanism behind the same block,
  the naive `"..."` regex paired across Python `"""` docstrings inside fenced
  code blocks, manufacturing giant pseudo-"quotes" mixing code and prose that
  could never match evidence. The prose-quote scan now runs on the answer with
  fenced regions removed (fence content is verified by its own dedicated check),
  and all quote/fence comparisons use a shared whitespace normalization
  (per-line trim + intra-line whitespace-run collapse) on both sides, so
  re-indented or respaced real code still verifies while fabricated content
  still blocks -- covered by fc-09-reproduction tests plus fabrication controls.
- The explain-selection prompt builder now runs the same shared token budgeter
  as the main answer path (`deriveEvidenceBudgetChars`/`truncateItemContent`
  exported from `evidencePrompt.ts`, not a second implementation): it
  previously relied on the synthesizer's `compactPacketForLLM()` slices, which
  bounded item count but not size, so a large selection plus a few big context
  items could exceed `num_ctx` and silently truncate its own rules/security
  framing. Section structure and priority order are unchanged; the user's
  selection is always included (capped generously); overflow context entries
  are dropped from the back and disclosed with the same omission NOTE, with an
  `explain-selection`-labeled `[PromptBudget]` telemetry line. With both paths
  budgeted, `compactPacketForLLM()` had no callers left and is deleted.
- Asking about a file that is real on disk but deliberately excluded from indexing
  (e.g. `mission_orchestrator.backup.py`, matching `fileWalker.ts`'s `*.backup.py`
  pattern) surfaced the raw internal gate diagnostic "Unsupported path: backup.py" --
  technically true, useless to a developer looking at that file in their editor.
  `AnswerGate` now recovers the full dotted filename from the answer text (its path
  regex stops at the last dot-segment, but exclusion globs only match the full name),
  checks it against the default indexing exclusion patterns, and explains that the
  file is deliberately not indexed and how to change that, instead of implying the
  path might be hallucinated. Genuinely-unsupported paths keep the original message.
- `LogicalUnitStore.searchByContent()`'s coarse SQL candidate filter used only the
  first tokenized word of the query text (`terms[0]`) to narrow rows before scoring,
  so a natural-language question's relevance depended entirely on which word
  happened to occur first in the sentence -- for "What happens when a user
  uploads..." that word was "happens," an almost meaningless filter, silently
  excluding units that matched every other, more relevant term. The filter now
  ORs across every tokenized term; `contentScore()`'s existing ranking (which
  already sums occurrences across all terms) is unchanged, so this widens recall
  without changing how matches are ranked once found.

### Security
- The answer prompt (`buildEvidenceMessages()`) is now token-budgeted and
  question-aware. Previously it had no size discipline (top-50 facts + top-30
  items by raw retrieval score, where a single item could be a 500-line class
  body): 7 of 12 real dogfood answer prompts reached 72-100k chars (~20-27k
  tokens) against `num_ctx=16384`, and Ollama silently keeps only the TAIL of
  an over-length prompt -- so the CRITICAL RULES block (anti-hallucination,
  citation mandate, and the untrusted-repository-content security framing) was
  the first thing destroyed on a majority of real queries, confirmed
  empirically with a head/middle/tail needle test (`contextTruncationProbe.ts`:
  only the tail marker survived). Separately, the score-only final cut dropped
  the single decisive evidence item (e.g. a 0.65-score method literally
  containing the question's terms) in favor of generic score-1.0 symbol
  matches even with 75% of the window empty. The packer now (a) derives a hard
  char budget from `num_ctx` minus an output reserve, using a deliberately
  conservative chars-per-token ratio so Ollama-side truncation is unreachable,
  (b) ranks items and facts by retrieval score blended with lexical relevance
  to the actual question (snake_case terms also match their squashed CamelCase
  spelling), (c) truncates oversized single items to head + question-matching
  lines instead of dropping or fully including them, (d) appends an explicit
  omission NOTE so the model discloses rather than guesses across cut
  evidence, and (e) logs a `[PromptBudget]` telemetry line (est tokens vs
  `num_ctx`, packed/dropped/truncated counts) on every answer call, with a
  defense-in-depth over-budget warning in `streamChat()` for any other call
  path. The main answer path's old second selection layer
  (`compactPacketForLLM`'s signal-type slices) is bypassed so selection
  happens in exactly one place; the explain-selection path keeps it until it
  gets its own budgeter. Verified end-to-end: the two dogfood questions whose
  decisive evidence never reached the model (a literal `REDIS_URL` constant, a
  "Delegates to MissionCoordinator" docstring) now produce correct, cited
  answers, and the over-budget fabrication case now passes the gate with a
  grounded answer.
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
- `IndexManager.forceFullReindex()` called `clearAll()` on Lance/BM25 (the
  chunk-level "hybrid retrieval" stores) *before* `fullIndex()`'s re-embedding
  step, with no atomicity or rollback -- found via real-world investigation of a
  live index whose chunk stores were completely empty (0 documents) while
  `logical_units.db`/`facts.db` were fully populated, the exact signature of a
  reindex that cleared the old chunks and then either got interrupted before
  re-embedding finished, or completed "successfully" while every embedding call
  silently failed (`fullIndex()` only warns and skips a chunk on embed failure,
  never throws). Either way, a real user's index could be permanently emptied by
  any interrupted reindex -- a crash, force-quit, or sleep during a rebuild, not
  just a script bug. `LanceStore`/`Bm25Store` now build into a fresh, inactive
  "generation" (a second table / segment directory) via `beginRebuild()`,
  swapping it in atomically via `commitRebuild()` only after `fullIndex()`
  succeeds -- and `commitRebuild()` itself refuses the swap (keeping the
  previous generation live) if the previous generation had real chunks and the
  new one has none, catching the silent-100%-embed-failure case too. If the
  process dies at any point before `commitRebuild()`, the previously-active
  generation was never touched. Covered by a new interruption test
  (`src/test/indexing/reindexAtomicity.test.ts`) that stages a rebuild, never
  commits or aborts it (simulating a hard kill), and confirms a freshly-opened
  store instance still sees the original data. The other stores `clearAll()`'d
  by `forceFullReindex()` (logical units/facts, PageRank, annotations, symbol
  index) are not yet covered by this generation-swap and remain a smaller,
  disclosed residual risk.
- Added `RepositoryLivenessGate` (`src/preparation/repositoryLivenessGate.ts`),
  checked at query time (TTL-cached) rather than only at extension activation --
  found that `hasValidEvidenceIndex()`'s existing empty-store detection is
  correct but only ever runs at a handful of discrete lifecycle moments
  (activation, manual resync, workspace-folder-changed), so a workspace whose
  chunk stores go empty mid-session (e.g. from an external process, or the bug
  above) went undetected until the next activation. The gate distinguishes a
  genuinely fresh, never-indexed repo from the corruption signature above
  (structural data present, chunks empty) and surfaces an actionable warning
  with a "Re-sync Index" button rather than silently answering with degraded
  evidence.

## [0.0.1]

- Initial scaffold.
