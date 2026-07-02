# RepoGuide Codebase Audit vs. VISION.md

Audited 2026-07-02 against the 8 guiding principles in `VISION.md.md`. Findings are drawn from direct code inspection (file:line citations below) plus repo-state facts (git history, file inventory). No root `CLAUDE.md` exists — the only `CLAUDE.md` files in this working tree belong to vendored eval repos (`eval_repos/axios`, `eval_repos/medusa`, `tmp_repos/zod`), not RepoGuide itself.

**Repo-state fact that colors every principle below:** this repository has **zero git commits** (`git rev-list --all --count` = 0, `git log` errors with "does not have any commits yet"). All 553 entries in `git status --short` are untracked, including `.gitignore` itself. The root directory contains 300+ ad hoc markdown reports, 78+ debug/test scripts, and dozens of logs/JSON dumps — none of it version-controlled, none of it gitignored.

---

## 1. Long-term value over short-term speed

**Verdict: Not Aligned**

**Evidence:**
- Zero commit history for the entire project (`git rev-list --all --count` = 0) — no rollback capability, no blame trail, no code review record ever existed.
- `CHANGELOG.md` is 8 lines, contents only `"Initial release"`, despite the scale of work evidenced elsewhere in the repo.
- ~250+ near-duplicate self-validation docs at root (`component_26_*.md` ×~65, `component_27_*.md` ×~70, `repository_brain_*.md` ×~90) show a verdict → re-verdict → "PRODUCTION_READY" escalation pattern on the *same* components (e.g. `component_26_pre_implementation_verdict.md` lists 5 required fixes; `component_26_final_readiness_verdict.md` claims all 5 "successfully patched"; `component_26_final_production_readiness.md` declares "No further modifications... necessary"). This reads as an agent repeatedly grading its own prior output rather than durable engineering record-keeping.
- Undocumented environment-variable feature flags left live in production code paths: `ABLATION_MODE` (`src/query/evidencePacketBuilder.ts:75,138,164`, `src/query/hybridRetrievalFusion.ts:207,307,634,674,694`), `SYMBOL_RANKING_MODE` (`hybridRetrievalFusion.ts:248,250`), `LOG_TOKENIZATION` (`hybridRetrievalFusion.ts:211`) — experiment scaffolding never cleaned up.

**Gap:** No version control discipline at all, and a large fraction of the visible engineering process is self-referential validation churn on components that in several cases (see Principles 3 and 8) never shipped into the running extension.

**Fix size:** Quick fix for `git init` + initial commit + expanded `.gitignore`. The underlying process pattern (build → self-validate repeatedly → leave orphaned) is a Moderate-to-Architectural fix — it needs a workflow change (a "done" checklist including integration + cleanup), not just a cleanup pass.

**Confidence:** High — git state and file counts are directly verified.

---

## 2. Understanding over code generation

**Verdict: Partially Aligned**

**Evidence:**
- `src/query/answerGate.ts` (`AnswerGate.verify()`, line 14) validates numeric claims, quotes, file paths, and fallback-chain ordering against retrieved evidence before an answer is shown, with `pass`/`revise`/`block` outcomes.
- `src/ui/hallucinationGuard.ts` — `verifyLocations()` (5-22) and `verifyNavigationTargets()` (24-48) check cited file paths and line ranges against the real filesystem before surfacing them.
- `src/prompts/evidencePrompt.ts:12-13` explicitly instructs the model: cite `[id: 123]`, and "If a specific symbol or function is queried and it is NOT in the evidence, say 'evidence does not determine'" — a genuine anti-fabrication instruction, not just a generation prompt.
- `src/comprehension/comprehensionEngine.ts` builds and persists module/call-graph/project understanding artifacts (`loadExisting`, lines 79-105) rather than only generating one-shot text.

**Gap:** Two full, independently-maintained query architectures coexist (`legacy` vs `evidence`, gated by `repoguide.queryArchitecture`, dispatched in `src/query/queryDispatcher.ts:80-92`), and the newer "evidence" path still delegates `explainSelection`/`explainSelectionResult` back to the legacy pipeline (`queryDispatcher.ts:310-336`) — the understanding-oriented path is not fully self-sufficient yet.

**Fix size:** Moderate — retire or complete the evidence path's coverage of legacy-only features.

**Confidence:** High on the cited mechanisms; Medium on how consistently the evidence path is actually selected in practice (default is `evidence`, per `package.json:112`, but this wasn't runtime-tested).

---

## 3. Compounding value

**Verdict: Partially Aligned**

**Evidence — genuinely wired, persistent, accumulating:**
- `src/memory/lanceDbMemoryStore.ts:16-20` writes to `.repoguide/lancedb_memory` on disk; `MemoryStoreFactory.getMemoryStore` (`src/memory/memoryStoreFactory.ts:27-31`) is called from `src/query/queryDispatcher.ts:52` and `src/indexing/indexManager.ts:155` — live in both query and index paths.
- `src/comprehension/comprehensionEngine.ts` persists `.repoguide/understanding/*.json` (file-structures, files, modules, call-graph, project) and hydrates from disk at activation (`src/extension.ts:367`) instead of recomputing each session.
- `src/feedback/` (`FeedbackCaptureService`) and `src/outcomes/` (`DecisionOutcomeQueryEngine`) are both instantiated and consumed in live pipeline code (`src/query/hybridQueryPipeline.ts:7,58,83,142,246`; `src/query/repositoryBrainEvidenceStore.ts:4,33,74-106`).
- `src/watchers/gitWatcher.ts:41-95` does real store mutation on branch switches (`store.deleteChunksByFile`, `indexManager.incrementalUpdate`), not just staleness flags.

**Gap — built but orphaned (no live callers outside their own tests):**
- `src/intent/` (commit/PR/ADR → code linking) — only consumer is `src/impact/intentAwareBlastRadiusEngine.ts`, which itself has zero external callers.
- `src/evolution/` and `src/drift/` — instantiated only in `evolution.test.ts` / `drift.test.ts`.
- `src/causal/` → `src/query/repositoryBrainEvidenceStore.ts` → `src/query/repositoryBrainProvider.ts` → `src/mcp/mcpServer.ts` chain is reachable only via the standalone `npm run mcp` script or `src/evaluation/canonicalValidation.ts`, not from `extension.ts`.

**Gap summary:** Roughly half of the "accumulate knowledge over time" infrastructure (intent linking, evolution/drift tracking, causal reasoning) was built to spec but never integrated into the shipped product — sunk cost that isn't compounding for actual users.

**Fix size:** Moderate to Architectural per module — either wire each into the live query/orchestrator path or remove it; leaving it half-built is the worst of both.

**Confidence:** High — import graphs were directly traced.

---

## 4. Scale-agnostic by design

**Verdict: Not Aligned**

**Evidence:**
- `src/indexing/fileWalker.ts:129-135` hardcodes `MAX_FILES = 2000`; repos above that are silently truncated (deepest-path files dropped first) with only a `console.warn` — no configuration surface, no graceful degradation strategy.
- `src/indexing/indexManager.ts:259-330` indexes and embeds files strictly sequentially, one chunk at a time, with no batching or worker concurrency — indexing time scales linearly and serially with repo size.
- `src/store/lanceStore.ts`: `getAllChunks()` (145-162) and `getAllFilePaths()` (89-112) load the entire table into memory with no pagination; no ANN/vector index creation was found, implying brute-force vector search.
- `src/store/bm25Store.ts:48-54` re-serializes the entire MiniSearch index as one JSON blob on every save — no incremental persistence.
- No comments anywhere in `src/store/` acknowledge these as known scale limits.

**Gap:** This is a direct contradiction of "every capability should be designed for repositories of every size... avoid decisions that only work for small repos." A 2000-file hard cap excludes most real enterprise monorepos outright.

**Fix size:** Quick fix to raise/make-configurable the file cap; Architectural rework for true scale-agnosticism (paginated storage reads, ANN indexing, incremental BM25 persistence, concurrent indexing pipeline).

**Confidence:** High — limits and access patterns are directly cited from code, not inferred.

---

## 5. Reduce cognitive load

**Verdict: Not Aligned**

**Evidence:**
- 9-10 separately-invoked webview panels exist: chat sidebar (`src/ui/sidebarProvider.ts`), doc report (`docReportPanel.ts`), explain (`explainPanel.ts`), index health (`indexHealthPanel.ts`), orientation/investigation/plan tracker (`phase10Panels.ts`, 3 panels), memory explorer (`memoryExplorerPanel.ts`), daily brief (`dailyBriefPanel.ts`), notes (`notesPanel.ts`) — ~4,800 combined lines of UI code across 16 files, each its own mental model (evidence trail, plan completion %, memory search, coverage %, etc.), with no unifying dashboard.
- Design system is inconsistent across panels: a shared `wrapHtml()` shell exists (`src/ui/htmlUtils.ts`) and is used by 4 panels, but `indexHealthPanel.ts:417-490` re-declares its own duplicate `--rg-*` CSS block, `explainPanel.ts:26-60` uses entirely bespoke CSS with no shared tokens, and `webviews/docreport/report.html:15` hardcodes non-VS-Code fonts. Three competing visual languages for one extension.
- Four commands are wired to real, working panels but are **missing from `package.json`'s `contributes.commands`** (`repoguide.showDailyBrief`, `addNote`, `notesPanel`, `verifyNoteSystem`, registered at `src/extension.ts:766-834`) — undiscoverable through the Command Palette, the extension's primary discovery mechanism.
- Multiple undocumented env-var flags (`ABLATION_MODE`, `SYMBOL_RANKING_MODE`, `LOG_TOKENIZATION` — see Principle 1) add invisible internal complexity that eventually surfaces as inconsistent behavior.

**Gap:** Directly contradicts "the best feature removes complexity... rather than introducing new concepts they must learn." This is a command-driven toolbox requiring a user to learn which of ~17 commands to reach for, not a single coherent experience.

**Fix size:** Quick fix for the orphaned command registrations; Architectural rework for panel consolidation and a single design system.

**Confidence:** High for the panel/command inventory (directly counted); Medium (stated as inference by the source agent) for the qualitative "cognitive load" characterization, though the evidence strongly supports it.

---

## 6. Stack-agnostic durability

**Verdict: Partially Aligned**

**Evidence — good foundation:**
- AST chunking is centralized, not duplicated per language: one `astChunk` function and one `getTreeSitterLanguage()` lookup (`src/indexing/astChunker.ts`, `src/indexing/languageDetector.ts:25-52`) serve working grammars for TypeScript, JavaScript, Python, Java, Go, Rust, and C++ — matching the tree-sitter dependencies declared in `package.json:284-291`.
- `src/indexing/fileRoleClassifier.ts:40-66` and `src/workspaceRootDetector.ts:20-21` recognize `pyproject.toml`, `Cargo.toml`, `go.mod`, `requirements.txt` alongside `package.json` — genuine multi-stack awareness at the file-role layer.
- `src/runtime/blast_radius/` and `src/runtime/dependencies/` operate on a generic component/trace graph, not language-specific AST — durable by design. `traceIngestionService.ts:7` explicitly supports `pytest | coverage | otel | log | manual` trace formats, spanning ecosystems.

**Gap:**
- The deeper semantic/fact extraction layer — the part that actually builds structured understanding, not just chunks — has exactly one provider: `src/indexing/semantic/providers/typescript/`, registered alone in `indexManager.ts:117`. Every non-JS/TS language gets AST chunking but not semantic fact extraction.
- Kotlin (`.kt`) is mapped to the Java grammar (`languageDetector.ts:19`) — parses by approximation, not a real Kotlin grammar.
- Ruby, PHP, C#, and Swift have no tree-sitter grammar at all and always fall back to fixed-window plain-text chunking.
- Real-world eval corpora (`eval_repos/`: axios, medusa, yarn) are JS/TS-only; `test/fixtures/` has `python-fastapi` and `mixed-fullstack` unit fixtures but no equivalent large-scale, non-JS evaluation exists.

**Fix size:** Architectural — extending the semantic/fact layer to a second language is a real design effort (it must generalize whatever TypeScript-specific assumptions the current provider has), not a quick add.

**Confidence:** High on what's implemented; Medium on how much this gap has been felt in practice, since non-JS real-world evaluation is absent.

---

## 7. Trust through evidence, not confidence

**Verdict: Partially Aligned**

**Evidence — real trust mechanisms:**
- `AnswerGate.verify()` (`src/query/answerGate.ts:14`) blocks or revises answers that fail evidence checks, and yields an explicit refusal message on `block` (`queryDispatcher.ts:243-247`) rather than a confidently-wrong answer.
- `hallucinationGuard.ts` verifies every cited file path/line range against the real filesystem before it reaches the user, clamping or rejecting bad citations.
- `src/prompts/chatPrompt.ts:96,423` mandates exact `file:///<path>#L<start>-<end>` citation format and explicitly warns "Do not hallucinate file paths."
- Legacy path's `src/query/confidenceScorer.ts:score()` (line 14) computes a real `avgScore`/`level` from actual retrieval scores.

**Gap — a direct contradiction found in the newer, default-on path:**
- `onConfidence` in the evidence pipeline (the default query architecture per `package.json:112`) is **hardcoded to `level: 'high'`** at both call sites (`src/query/queryDispatcher.ts:133-141, 179-187`) — the confidence signal shown to the user is a constant, not derived from actual grounding strength. This is the opposite of "communicate uncertainty clearly instead of hiding it" — the newer, more-trusted-by-default path is the one lying about its confidence.
- The eval harness's own `provenanceAccuracy` metric — the one that would check whether citations are actually trustworthy — is hardcoded to `null` with a comment "Manual review required" (`src/evaluation/scorers.ts:53`), meaning the most safety-critical metric is unautomated.
- Uncertainty is only expressed through gate-block refusal text (`answerGate.ts:97-108,177-186`), not through the confidence signal — a partial substitute, not equivalent transparency.

**Fix size:** Quick fix — replace the two hardcoded `'high'` confidence assignments with a real score derived from `AnswerGate`/`EvidencePacket` signals that already exist in scope.

**Confidence:** High — the hardcoded values were directly read at both call sites.

---

## 8. Incremental, mission-aligned progress

**Verdict: Partially Aligned**

**Evidence — real incremental wins:** Comprehension engine, memory store, watchers, feedback/outcomes capture (Principle 3) are cleanly wired end-to-end and represent genuine forward progress that compounds session over session.

**Gap:**
- A comparable volume of engineering effort (`src/intent/`, `src/evolution/`, `src/drift/`, the `src/causal/` → MCP chain, `src/orchestrator/repositoryBrainOrchestrator.ts`, the near-duplicate `src/incident/` vs `src/incidents/`) was built, individually tested, and then never integrated into the path that ships (`extension.ts`). `repositoryBrainOrchestrator.ts` in particular has real branching/error-handling logic but is imported only by test files — an entire orchestration layer with no production caller.
- Two full parallel query architectures (legacy/evidence) persisting side-by-side, each with its own confidence scoring and provenance model, is incremental in the sense of "add more code" but not in the sense of consolidating capability — it's accreting rather than replacing.
- The component_26/27 verdict-on-verdict document pattern (Principle 1) indicates repeated rework cycles on the same subsystems rather than clean, forward-only progress.

**Fix size:** Moderate to Architectural — requires an explicit decision per orphaned module (integrate or delete) and a plan to retire the legacy query path once the evidence path reaches parity.

**Confidence:** Medium — the "why" behind the orphaning (abandoned experiments vs. deliberately paused work) is inferred from import-graph absence, not from commit history (none exists) or direct developer intent.

---

## Prioritized Punch List (impact : effort)

1. **Fix hardcoded `level: 'high'` confidence in the evidence query path** (`src/query/queryDispatcher.ts:133-141,179-187`) — directly contradicts the trust principle in the default-on pipeline; a scoped code change. *Quick fix.*
2. **Establish version control**: `git init`/first commit, and expand `.gitignore` to exclude the ~500 root-level scratch/report/log files (or delete them after confirming nothing load-bearing is buried in them). Single biggest unlock for "long-term value" and basic engineering hygiene. *Quick fix.*
3. **Register the four orphaned commands** (`showDailyBrief`, `addNote`, `notesPanel`, `verifyNoteSystem`) in `package.json`'s `contributes.commands` so they're discoverable. *Quick fix.*
4. **Raise or make configurable the `MAX_FILES = 2000` cap** in `src/indexing/fileWalker.ts:129`, and log/report truncation to the user instead of a silent console warning. *Quick fix, high impact on scale-agnostic principle.*
5. **Decide the fate of each orphaned module** (`src/intent`, `src/evolution`, `src/drift`, `src/causal`→MCP chain, `src/orchestrator`, `src/incident` singular) — wire into the live orchestrator/query path or delete. Currently pure maintenance liability with zero user-facing value. *Moderate.*
6. **Retire or complete the `legacy` query pipeline** so only one provenance/confidence/answer model is maintained; today `explainSelection` silently falls back to legacy even under the "evidence" architecture, meaning users get inconsistent behavior depending on query type. *Moderate.*
7. **Consolidate the UI design system** — make `indexHealthPanel.ts` and `explainPanel.ts` use the shared `wrapHtml()` shell instead of duplicated/bespoke CSS, and add one unified entry point that surfaces the other 8+ panels. *Architectural.*
8. **Extend semantic/fact extraction beyond the single TypeScript provider**, and add at least one real-world non-JS eval corpus (Python/Go/Rust) alongside axios/medusa/yarn to validate the stack-agnostic claim under real load. *Architectural.*

---

## What's Working Well

- **The trust mechanisms that do exist are concrete, not aspirational.** `AnswerGate` and `hallucinationGuard.ts` genuinely block/clamp unverifiable claims before they reach the user — rare in AI coding tools, and a real product differentiator once the confidence-signal bug (Punch List #1) is fixed.
- **The compounding-knowledge core actually works.** `ComprehensionEngine`, `LanceDbMemoryStore`, `FeedbackCaptureService`, and `DecisionOutcomeQueryEngine` are all live, persisted to `.repoguide/`, and reused across sessions rather than recomputed — this is the architectural spine the mission needs, and it's real, not just designed.
- **AST chunking is a clean, centralized abstraction** (`astChunker.ts` + `languageDetector.ts`) rather than seven copy-pasted per-language chunkers — a good foundation to build the missing multi-language semantic layer on top of.
- **Real test discipline exists alongside the scratch-file chaos**: 53 files under `src/test/*.test.ts`, multi-stack fixtures (`typescript-react`, `node-express`, `python-fastapi`, `mixed-fullstack`), and a non-stub eval harness (`src/evaluation/scorers.ts`) that does real pattern-matching for grounding and honest-uncertainty scoring, not placeholder constants.
- **Multi-stack instincts exist at the right layer**: recognizing `pyproject.toml`/`Cargo.toml`/`go.mod` for workspace-root and file-role detection shows the team is thinking stack-agnostically where it's cheap to do so — the gap is deeper in the stack (semantic extraction), not in this foundational layer.

---

## Architectural Risks Beyond the 8 Principles

- **No version control is an operational risk in its own right**, independent of any single principle: no rollback, no code review trail, no way to bisect a regression. Everything else in this audit — including whether the orphaned modules represent abandoned work or paused work-in-progress — is unverifiable without it.
- **Two parallel implementations of core query/provenance/confidence logic** (legacy vs. evidence) is a live drift risk: a fix applied to one (e.g., the confidence hardcoding bug) will not automatically propagate to the other, and `explainSelection` already demonstrates the seam is leaking (evidence path silently defers to legacy).
- **The storage layer has no evidence of load-testing near enterprise scale.** Brute-force vector search, full-table reads with no pagination, and single-blob BM25 persistence will degrade or fail well before "large enterprise codebase" scale — and the 2000-file hard cap means this has likely never been exercised in this repo's own eval history.
- **The MCP server (`src/mcp/mcpServer.ts`) is fully built — four real tools (`ask_repoguide`, `retrieve_raw_evidence`, `get_dependents`, `get_facts`) — but disconnected from the shipped VS Code extension**, reachable only via a standalone script. Given the mission's ambition to be "the engineering tool developers instinctively consult," and MCP's emergence as the standard interop layer for AI coding tools, this is a missed integration rather than a completed one — worth a deliberate decision either way rather than continued neglect.
- **The root-level document sprawl is a symptom of a process gap, not just a mess**: whatever workflow produced 250+ self-validation reports across three "components" evidently has no "definition of done" that requires integration + cleanup before moving on. Without addressing that workflow gap directly, cleaning up the current mess (Punch List #2) will likely recur.
