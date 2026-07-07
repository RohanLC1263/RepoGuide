# RepoGuide Roadmap

> For full project history and per-phase findings, see the maintained roadmap outside this repo
> (Cowork session) — this file tracks current focus only.

Tracks work at the level of "what's the current focus," not a full changelog — see git history and
the individual `*_REPORT.md`/`*_SEMANTIC_PROVIDER_REPORT.md` files for implementation detail.

## Where the project is now

- **Semantic/fact-extraction layer**: seven `SemanticProvider` implementations exist
  (TypeScript, Python, Java, C#, Go, Rust, C++), all shadow-mode — computed on every indexed file but
  not yet authoritative for any language's query answers. See `REPOGUIDE_AUDIT.md` §6 and each
  language's own `*_SEMANTIC_PROVIDER_REPORT.md` for tier breakdowns and real-corpus verification.
- **UX/information architecture**: Phase 5, done.
- **Release engineering**: Phase 6, done. See below.

## Phase 5 — UX Consolidation

**Goal**: reduce the "which of ~20 commands do I reach for" cognitive load flagged in
`REPOGUIDE_AUDIT.md` §5 (VISION.md principle 5, "reduce cognitive load"), without a full visual
redesign of any panel's actual content.

**Status: Done.** See `UX_CONSOLIDATION_REPORT.md` for full before/after verification (panel/command
inventory, design-system consolidation, the Orientation-panel-as-dashboard launcher, and
`tsc`/lint/jest results).

## Phase 6 — Release Engineering

**Goal**: the last phase before this can ship — CI, an automated `provenanceAccuracy` eval metric,
changelog discipline, Marketplace packaging readiness, and a security review of the real attack
surface (this tool indexes and reads arbitrary user codebases, and sends retrieved content to an LLM).

**Status: Done.** See `RELEASE_ENGINEERING_REPORT.md` for full before/after verification. Highlights:
- Fixed a severe, previously-undocumented packaging bug: `.vscodeignore` didn't exclude vendored eval
  corpora/archives/a stray dev venv -- confirmed via `vsce ls` that 87,630 files (multiple GB) would
  have shipped in the `.vsix` before the fix, 9,411 after.
- Fixed a path-traversal pattern repeated across 5 files (an LLM-echoed citation could, once clicked,
  open an arbitrary file outside the workspace) and added untrusted-content framing to every prompt
  that includes retrieved repository content.
- `.github/workflows/ci.yml` added (compile + lint + headless unit tests on push/PR).
- `provenanceAccuracy` is now a disclosed, verified heuristic (was previously hardcoded `null`).
- `CHANGELOG.md` has real content and a stated discipline going forward; `LICENSE`/`CONTRIBUTING.md`
  added; README's stale/inaccurate capability claims corrected.

**Still open, deliberately deferred (not silently dropped):**
- **AnswerGate blind spot: vague-but-wrong structural claims pass the gate.** Found during the
  2026-07-07 decomposition hypothesis test: a single-shot answer claimed StoryGenerationAgent runs
  in the mission pipeline sequence (it does not -- `run_mission` builds its report with
  `story_text=None`) and passed the gate, because the gate only verifies checkable artifacts
  (quotes, fenced code, numbers, file paths) and a narrative claim like "agent A runs after B" or
  "X delegates to Y" contains none of them; bare symbol names are not checked at all. Query
  decomposition narrows the *occurrence* side (focused per-facet evidence measurably reduced
  plausible-structure padding: the decomposed run got the same sequence right), and the earlier
  token-budget fix narrows it further (rules are no longer truncated away), but the *verification*
  side is untouched: a vague-wrong structural claim in any sub-answer still passes its sub-gate,
  and the merge union gate checks the same artifact classes. Concrete follow-up direction: extract
  claimed relations ("A calls/uses/delegates-to/runs-after B") from answers and verify them against
  the program graph, which already stores real call/dependency edges (10k+ records on the dogfood
  corpus) -- flag claims about symbol pairs that exist but have no supporting edge.
- `package.json`'s `repository.url` and `publisher` remain explicit placeholders -- no real GitHub
  org/Marketplace publisher exists yet for this project. Replace before actual submission.
- No extension icon exists (needs a real design asset, not something generatable as part of this pass).
- The full jest suite has pre-existing, unrelated flaky failures (worker-process resource contention,
  plus several test files calling `process.exit()` directly on failure) that make it unsuitable as a
  hard CI gate today -- CI intentionally runs only `compile`/`lint`/`test:unit` until that's cleaned up.
- Ruby/PHP/Swift still have no tree-sitter grammar and fall back to fixed-window plain-text chunking.
- The `legacy` vs. `evidence` query pipeline split (`ARCHITECTURE_CONFORMANCE_REPORT.md` #1) is
  unresolved — `explainSelection` still silently falls back to legacy for some query types.
- Orphaned modules (`src/intent`, `src/evolution`, `src/drift`, `src/causal`→MCP chain,
  `src/orchestrator`, `src/incident` singular) still need a keep-or-delete decision.
