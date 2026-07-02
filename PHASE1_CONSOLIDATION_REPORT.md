# Phase 1 Consolidation Report

Implements the plan approved in Pass 1 (`jaunty-churning-sky.md`): consolidating onto a single canonical query path per `ARCHITECTURE_FREEZE.md` and `REPOSITORYBRAIN_REUSE_ANALYSIS.md` Part B, then a follow-up pass closing all 3 residual gaps the first pass left open. The full project compiles clean (`tsc -p ./`, 0 errors) and lints clean (`eslint src`, 0 errors — 931 pre-existing style warnings, unrelated to this change). Verified with targeted runtime smoke tests throughout, not just type-checking.

---

## What changed (initial consolidation pass)

### 1. `explainSelection`/`explainSelectionResult` — ported to the evidence path
- `ExecutionPlanner.plan()` (`executionPlanner.ts`) gained a `planExplainSelection()` branch: when `mode === 'explain_selection'` and `selection` is set, it builds a plan directly from the selection (no free-text classification), selecting `symbol_index/fact_store/logical_unit_store/program_graph/hybrid_retrieval` providers.
- `EvidencePacket` gained an optional `selection` field and a new `isAnchorItem()` helper (`evidencePacket.ts`) that replicates the exact file/line-overlap test the legacy code used.
- `EvidencePacketBuilder.buildExplainSelectionPacket()` (new method, `evidencePacketBuilder.ts`) builds a packet from orchestrator results and stamps `packet.selection` — the existing `buildPacket()` path used by every other query category is untouched.
- New `src/prompts/evidenceExplainSelectionPrompt.ts` renders anchor-vs-related context from `EvidenceItem`s via `isAnchorItem`, reusing the legacy prompt's four-section structure (WHAT IT DOES/WHERE IT FITS/HOW IT RUNS/WATCHPOINTS).
- `EvidenceAnswerSynthesizer` gained `synthesizeExplainSelection()`/`streamSynthesizeExplainSelection()`.
- `QueryDispatcher.explainSelection()`/`.explainSelectionResult()` (`queryDispatcher.ts`) now run the full plan → orchestrate → build-packet → synthesize → `AnswerGate.verify()` sequence — the same validation every other answer gets, where before this path skipped `AnswerGate` entirely.

### 2. Conversation history — threaded into `QueryDispatcher`
- `QueryDispatcher`'s constructor now takes a `ConversationHistory` directly (replacing the `legacyPipeline` parameter it used to receive one through).
- `runEvidenceQuery()` populates `conversationContext` on the `PlanningRequest`; `history.add()` fires after `AnswerGate` resolves — **not** on a `block` outcome, so refusals never pollute follow-up context.
- `buildEvidenceMessages()` (`evidencePrompt.ts`) gained an optional `history` parameter and interleaves prior turns into the prompt.
- Per the approved recommendation: no separate query-rewriting stage was added. `scoreQueryComplexity()` (`complexityScorer.ts`) gained a `hasConversationHistory` signal that routes short/anaphoric follow-ups to the LLM planner; `buildLLMEvidencePlan()` (`llmEvidencePlanner.ts`) now receives conversation context directly in its planning prompt.

### 3. `InvestigationEngine`, `PlanAnalyzer`, `docReportPanel`, and 3 MCP tools — routed through `QueryDispatcher`
- **`InvestigationEngine`**: `retrievePaths()` now calls a new `retrieveViaOrchestrator()` (`mode: 'investigation'`) instead of `HybridRetrievalFusion.retrieveContext()` directly — a strict evidence upgrade, since the orchestrator also invokes `fact_store`/`symbol_index`/`program_graph` for the same query. `investigate()`'s final report is now run through `AnswerGate.verify()` with a relaxed policy (numeric/quote checks off, file-path checks on) before returning. `investigateTerminal()` was initially left untouched — closed in the follow-up pass below.
- **`PlanAnalyzer`**: same treatment — per-feature-item retrieval now goes through the orchestrator (`mode: 'investigation'`, reused rather than adding a new mode, per the approved plan's reasoning), and deviation notes are gated for hallucinated file citations before the report is written.
- **`docReportPanel.ts`**: shrunk from ~80 lines of direct `LanceStore` iteration + prompt-building to a thin wrapper around the new `QueryDispatcher.runDocumentationReport()`. Required adding `'documentation'` to the frozen `PlanningRequest.mode` union (proposed and approved in Pass 1) — `QueryCategory` already had a `'documentation'` value that nothing produced before this.
- **MCP `retrieve_raw_evidence`**: now calls `QueryDispatcher.retrieveRawEvidence()`, which uses the frozen `mode: 'raw_evidence'` value — defined in the contract but unused by any code path before this change.
- **MCP `get_facts`**: routes through `retrieveRawEvidence(query, { forceProviderIds: ['fact_store'] })`.
- **MCP `get_dependents`**: routes through `retrieveRawEvidence(symbol, { targetSymbols: [symbol], forceProviderIds: ['symbol_index', 'program_graph'] })`. **Deviation from the Pass 1 plan, in a good way**: the plan proposed building a new `ImportGraphProvider`; while implementing, `ProgramGraphStore.getDependents()` (already wrapped by the existing `ProgramGraphProvider`) turned out to already cover caller/reader/importer/instantiator/fallback-consumer relationships — the same data `ImportGraphSearcher.getBlastRadius()` provided directly. No new provider was needed.

### 4. `LanceStore` and `BM25Store` (chunk-level) — wrapped as first-class `EvidenceProvider`s
- New `src/query/lanceStoreProvider.ts` (`id: 'lance_store'`, `kind: 'vector_store'`): serves standard embed-and-query vector retrieval, and — branching on the normalized `category` field, not provider identity — folder-bucketed whole-repo sampling for `'documentation'` requests (the logic `docReportPanel.ts` used to run inline).
- New `src/query/bm25Provider.ts` (`id: 'bm25_store'`, `kind: 'bm25'`): wraps the chunk-level `Bm25Store` `HybridRetrievalFusion` uses internally (distinct from `LogicalUnitBm25Store`, which was already provider-wrapped).
- Both registered in `extension.ts` and `mcp/mcpServer.ts`'s `RetrievalOrchestrator` provider lists.

### 5. `ABLATION_MODE`/`SYMBOL_RANKING_MODE` — removed from the core retrieval pipeline
- All 3 read-sites in `evidencePacketBuilder.ts` and all 5 read-sites in `hybridRetrievalFusion.ts` removed. `SYMBOL_RANKING_MODE`'s scoring override deleted. `LOG_TOKENIZATION` (a logging toggle, not a provider-gating branch) was left as-is — it was never part of the violation. **Correction from the original version of this report**: that version claimed `grep -r ABLATION_MODE src/` returned zero hits; a full-tree sweep during the follow-up pass found that claim was too broad — see "What the follow-up pass found and did not fix" below.

### 6. Dead wiring and the confidence bug — fixed
- `EvidencePacketBuilderStores.lanceStore` field removed (`evidencePacketBuilder.ts`); it was wired in `extension.ts`/`mcpServer.ts` and several eval scripts but never read by `EvidencePacketBuilder`. All call sites updated.
- `QueryDispatcher`'s hardcoded `level: 'high'` confidence (two sites) replaced with `computeEvidenceConfidence()` — a real function of `packet.coverageScore` and average item score, in the same shape/threshold spirit as the legacy `confidenceScorer.ts`.

### 7. `AnswerGate` — made policy-aware
- `VerificationPlan` (`executionPlanner.ts`) gained `checkNumericClaims`/`checkQuotedStrings`/`checkFilePaths` (default `true`, matching prior behavior exactly for `'answer'`/`'explain_selection'` modes). `'investigation'` mode sets numeric/quote checks off, file-path checks on. `'raw_evidence'` mode sets `requireAnswerGate: false` (no answer is synthesized for that mode, so there's nothing to gate — this is the frozen contract's own definition of `raw_evidence`, not a bypass).
- `AnswerGate.verify(answer, packet, policy)` (`answerGate.ts`) now takes an optional policy parameter (defaults to the original all-checks-on behavior) and gates each check accordingly. Verified via direct test: strict policy blocks an unsupported numeric claim; relaxed policy passes the same claim through but still blocks a hallucinated file path.

### 8. `HybridQueryPipeline` — deleted
- `src/query/hybridQueryPipeline.ts` deleted. The `ChatPipeline` interface it defined now lives in `queryDispatcher.ts` (the sole implementer). Fixed 5 downstream files that referenced it: `extension.ts` (removed `legacyPipeline` construction and the `queryArchitecture` status-bar/config-listener code that referenced the now-deleted setting), `mcp/mcpServer.ts`, `evaluation/queryPipelineHarness.ts`, `ui/sidebarProvider.ts`, `test/investigationUI.test.ts` (both just redirect their `ChatPipeline` import).
- `repoguide.queryArchitecture` setting removed from `package.json`.

### 9. Package commands
- Registered `repoguide.showDailyBrief`, `repoguide.addNote`, `repoguide.notesPanel`, `repoguide.verifyNoteSystem` in `package.json`'s `contributes.commands` (were implemented and wired in `extension.ts` but invisible in the Command Palette).

---

## Follow-up pass: closing the 3 residual gaps

The initial pass left 3 items open. All 3 are now closed.

### A. `investigateTerminal()` — routed through the canonical path

**Assessed first, not routed superficially.** `investigateTerminal()` is fully deterministic — `formatStructuredInvestigationReport()` builds its answer from string templates over evidence, with **no LLM call anywhere in the method** (unlike `investigate()`, which streams from an LLM via `generateDetectiveReport()`). This ruled out the plausible "it needs streaming/interactive behavior AnswerGate can't support" exemption the task asked me to check for — there was no legitimate reason this method needed to stay off the canonical path.

What changed, and what deliberately didn't:
- **The one query-shaped retrieval step now routes through the orchestrator.** `retrieveTerminalEvidence()`'s final catch-all step (`hybridQuery` built from `preprocessed.search_queries`) previously called `HybridRetrievalFusion.retrieveContext()` directly. It now calls `retrieveViaOrchestrator()` — the same method `investigate()` uses — broadening evidence beyond `hybrid_retrieval` alone to include `fact_store`/`symbol_index`/`program_graph` for the same query.
- **The anchor-specific lookups stay direct calls to `HybridRetrievalFusion`'s low-level helpers** (`lookupSymbolEvidence`, `getChunksForEvidenceFile`, `findPackageOrConfigFiles`, `searchBm25Evidence`). These resolve *exact* files/symbols/packages extracted from a parsed terminal error — not classified free-text queries — and forcing them through the generic orchestrator would have degraded precision (losing the anchor-type-specific line-range matching) for no compliance benefit. This is the same category of exception `EvidencePacketBuilder`'s own internal direct store calls already represent, and it's exactly the kind of case Pass 1's plan flagged `retrieveContext()`'s helpers as staying load-bearing for.
- **The final report is now gated.** `investigateTerminal()` builds a minimal `EvidencePacket` from its `InvestigationEvidenceItem[]` trail (new `buildTerminalGatePacket()`) and runs `formatStructuredInvestigationReport()`'s output through `AnswerGate.verify()` with the same relaxed policy `investigate()` uses (numeric/quote checks off, file-path checks on) before returning.

**One acknowledged precision trade-off**: the removed direct `retrieveContext()` call passed `preprocessed.preferred_annotation_signals` as a bias parameter; `retrieveViaOrchestrator()` doesn't expose that parameter, so this one catch-all retrieval step loses that specific annotation-signal weighting. Anchor-specific lookups (the bulk of terminal evidence) are unaffected. Verified end-to-end via `terminalInvestigationSmoke.ts` (updated with functional `ExecutionPlanner`/`RetrievalOrchestrator` stubs) — `Terminal investigation smoke PASS`, and a direct `AnswerGate` test confirms the relaxed policy still blocks a hallucinated file path in a terminal-report-shaped packet.

### B. `HybridRetrievalFusion.query()` and `.explainSelection()` — deleted

Re-confirmed via exhaustive grep that nothing calls either method (no matches for `Fusion.query(`, `Fusion.explainSelection(`, or any variable-bound equivalent, anywhere in `src/`). Removed both methods (`hybridRetrievalFusion.ts`, previously lines 771–1051) along with everything that became orphaned as a result: the `buildChatMessages`/`buildExplainSelectionMessages`/`buildAnswerMetadata`/`buildExplainSelectionMetadata`/`buildAnswerProvenance`/`buildAnswerSourceInventory`/`ArchitectureContextBuilder`/`TaggedCodeChunk`/`TaggedContextBlock`/`streamChat` imports, and the `mentionsLocalStalenessConcern()` helper function. `retrieveContext()` and its private search helpers (`searchBm25`, `searchVector`, `searchPageRank`, etc.) are untouched — confirmed by clean compile and the smoke tests above, which exercise them.

### C. Eval harness compare-mode — removed entirely, not left as a dead flag

This rippled further than just `queryPipelineHarness.ts`:
- **`queryPipelineHarness.ts`**: removed the `mode?: 'legacy'|'evidence'|'compare'` option, the `--mode` CLI-arg mirroring in the constructor, and the compare-branch in `runQuestion()`. `runHybridQuestion()` no longer takes a `mode` parameter, no longer sets the now-meaningless `__CURRENT_EVAL_MODE` global (confirmed via grep it was read nowhere else), and no longer mocks `vscode.workspace.getConfiguration('repoguide').get('queryArchitecture', ...)` — that setting doesn't exist anymore. The `explainSelection` vs. `query` branch now keys off `question.type === 'explanation' && question.snippet` alone, dropping the `mode === 'legacy'` condition it was previously gated on.
- **`types.ts`**: `EvalMode` narrowed from `'evidence' | 'legacy' | 'compare'` to a single-value `'evidence'` (kept, not deleted outright, because `evaluationMode: EvalMode` is a persisted field in eval report JSON that other tooling reads).
- **`cli.ts`**: removed the `--mode` flag, `requireMode()`, and `mode` from `CliArgs`; updated `--help` text.
- **`miniEvalRunner.ts`**: removed the `mode` branch around `validateEvidenceContracts` — contract validation now runs unconditionally on the primary output, and shadow-contract validation runs whenever `shadowOutput` exists (a `shadowEval`-driven concept, independent of the deleted compare-mode).
- **`phase3ReportWriter.ts`**: deleted `renderComparisonReport()` and its `legacy_vs_evidence_comparison_report.md` output entirely, rather than leaving it to always print "not executed in compare mode" — with compare-mode gone, `shadowOutput` is now always an exact copy of the primary output when `shadowEval` is on, so a "comparison" report would always show identical rows. Also removed the now-orphaned `formatScore()` helper, fixed 2 more `evaluationMode === 'compare'` branches (`renderContractReport`, `evidenceTelemetry`), and rewrote the stale `--mode legacy`/`--mode compare` messaging in `renderHarnessReport()`/`renderEvaluationDocumentation()`.
- **`reportWriter.ts`**: fixed 2 more `evaluationMode === 'compare'` branches (contract-failure aggregation, `evidenceTelemetry()`).
- **`hybrid_eval_harness.ts`** — deleted outright. Its entire purpose was forcing `--mode compare` (`process.argv.push('--mode', 'compare')`); with compare-mode gone, nothing about this script had a purpose left. Confirmed via grep it was never imported anywhere.
- **`package.json`**: removed the `eval:compare:craftconnect` script, which invoked the now-nonexistent `--mode compare`.

---

## What the follow-up pass found and did not fix

A full-tree grep sweep (`grep -rn ABLATION_MODE src/`) run while verifying item C above found that the original consolidation report's claim — "verified via `grep -r ABLATION_MODE src/` returning zero hits" — was **inaccurate**. That grep was effective for the two files it actually mattered for (`evidencePacketBuilder.ts`, `hybridRetrievalFusion.ts`, both still genuinely clean), but three older, unrelated one-off ablation-study scripts still **set** the env var: `run_phase_53_corrected_roi_study.ts`, `run_phase_54_fusion_study.ts`, `run_phase_55_final_vector_decision_study.ts`. Since every place that *reads* `ABLATION_MODE` is gone, these `process.env.ABLATION_MODE = ...` assignments are now inert — they have no effect on anything. This means Check 4 ("no provider-specific branching") is unaffected: there is no live branching left anywhere keyed on this variable. But it's dead code sitting in the tree, and it wasn't part of what this pass was asked to fix (3 specific residual gaps, none of which named these files). Left in place, flagged here rather than silently left out of the record — a candidate for a future small cleanup pass.

---

## Known residual gaps

Only one remains, and it was already known and explicitly out of scope by design:

- **`RepositoryBrain`'s API/lifecycle gap is unchanged.** `TARGET_ARCHITECTURE_RECOMMENDATION.md` sequences the reduced 4-method/4-state RepositoryBrain v1 as separate follow-on work, never part of this consolidation.
- **One pre-existing test failure, unrelated to this work, reconfirmed unchanged**: `src/test/evidencePacketBuilder.test.ts` fails with `this.stores.factStore.findByType is not a function`. Reconfirmed in this pass (not just cited from before) — same error, same location, before and after the follow-up changes; `git stash` against the pre-Phase-1 baseline reproduces the identical failure. Not introduced or touched by either pass.
- **Minor, newly-flagged, not fixed**: the 3 inert `ABLATION_MODE` setters in old ROI-study scripts described above.

---

## Re-running the 7 conformance checks from `ARCHITECTURE_CONFORMANCE_REPORT.md` — final state

| # | Check | Original audit | After initial pass | After follow-up pass |
|---|---|---|---|---|
| 1 | One canonical answer path | Violates (5+ paths) | Largely Conforms (2 caveats) | **Conforms** |
| 2 | ExecutionPlanner ownership | Conforms | Conforms | **Conforms** (unchanged) |
| 3 | EvidenceProvider contract | Partially Conforms (6/8) | Conforms (8/8) | **Conforms** (unchanged) |
| 4 | No provider-specific branching | Violates (8 sites) | Conforms (claimed 0, overbroad) | **Conforms** (0 live sites; 3 inert setters flagged) |
| 5 | RepositoryBrain API completeness | Not Yet Implemented | Not Yet Implemented | **Not Yet Implemented** (unchanged, out of scope) |
| 6 | MCP as facade | Violates (1/4 tools) | Conforms (4/4) | **Conforms** (unchanged) |
| 7 | AnswerGate mandatory | Violates (5 bypass routes) | Largely Conforms (1 residual) | **Conforms** |

### 1. One canonical answer path — Conforms

Every answer-producing exit point in the codebase now enters through `QueryDispatcher`/`ExecutionPlanner`/`RetrievalOrchestrator` and is gated before returning: `query()`, `explainSelection()`/`explainSelectionResult()`, `InvestigationEngine.investigate()`, `InvestigationEngine.investigateTerminal()` (closed this pass), `PlanAnalyzer.analyze()`, `runDocumentationReport()`, and all 4 MCP tools. `HybridQueryPipeline` is deleted; `HybridRetrievalFusion.query()`/`.explainSelection()` are deleted (closed this pass) — there is no more orphaned code that could later be rediscovered and called as a second answer path. The remaining direct calls to `HybridRetrievalFusion`'s low-level helpers (`retrieveContext`, `getChunksForEvidenceFile`, `lookupSymbolEvidence`, `findPackageOrConfigFiles`, `searchBm25Evidence`) are evidence-gathering primitives used by `investigateTerminal()`'s anchor resolution and by providers themselves — not separate answer paths, the same category of direct-store-access pattern `EvidencePacketBuilder` has always used internally and which Check 4 already treats as acceptable.

### 2. ExecutionPlanner ownership — Conforms (unchanged)

Untouched by the follow-up pass. Still only constructs and returns `ExecutionPlan` objects; never calls a store, never touches `RepositoryBrain`, never synthesizes an answer, never calls `AnswerGate`.

### 3. EvidenceProvider contract — Conforms (unchanged)

Untouched by the follow-up pass. `LanceStoreProvider` and `BM25Provider` remain fully conforming; all 8 originally-named systems have adapters.

### 4. No provider-specific branching — Conforms

Zero live branches on `ABLATION_MODE`/`SYMBOL_RANKING_MODE` remain anywhere they could affect retrieval behavior — `evidencePacketBuilder.ts` and `hybridRetrievalFusion.ts` (the only two files that ever *read* these variables) are both clean, confirmed again in this pass. Three old ablation-study scripts still *set* `ABLATION_MODE`, but since nothing reads it, these assignments are inert dead code, not live branching — flagged above, not a Check 4 violation. `LanceStoreProvider.retrieve()`'s `request.category === 'documentation'` branch remains a normalized-field branch within one provider's own method, not `EvidencePacketBuilder` branching on provider identity.

### 5. RepositoryBrain API completeness — Not Yet Implemented (unchanged)

Out of scope for both passes by design.

### 6. MCP as facade — Conforms (unchanged)

Untouched by the follow-up pass. All 4 tools route through `QueryDispatcher`.

### 7. AnswerGate mandatory — Conforms

The last bypass (`investigateTerminal()`) is closed. Every answer-producing path is now gated: legacy pipeline (deleted), `explainSelection` (gated), `InvestigationEngine.investigate()` (gated), `InvestigationEngine.investigateTerminal()` (gated, this pass), `docReportPanel`/`runDocumentationReport()` (gated), `PlanAnalyzer` (gated). MCP's `retrieve_raw_evidence`/`get_facts`/`get_dependents` remain intentionally ungated — not a violation, since `raw_evidence` mode is defined by the frozen contract as evidence-only with no answer synthesized to validate.

---

## Verification performed

- `npx tsc -p ./ --noEmit` — 0 errors (strict mode), re-run after every edit in both passes.
- `npm run compile` — clean build.
- `npm run lint` — 0 errors, 931 pre-existing style warnings (one fewer than the initial pass's 932, from removed dead code; all remaining warnings unrelated to this change).
- Direct module-load smoke test of all rewritten classes — all load without runtime error.
- Functional smoke test of `ExecutionPlanner.plan()` across all 4 modes (`explain_selection`, `documentation`, `investigation`, `raw_evidence`) confirming correct `category`, `providerIds`, and `verificationPlan` policy per mode.
- Functional smoke test of `AnswerGate.verify()` confirming strict policy blocks an unsupported numeric claim, relaxed policy passes the same claim, and both policies still block a hallucinated file path — repeated in this pass against a terminal-investigation-shaped packet specifically.
- `terminalInvestigationSmoke.ts` (updated with functional `ExecutionPlanner`/`RetrievalOrchestrator` stubs, since `investigateTerminal()` now depends on them) run end-to-end: `Terminal investigation smoke PASS`.
- Full-tree greps confirming: no remaining `HybridQueryPipeline`/`hybridQueryPipeline` references outside historical comments; no remaining calls to `HybridRetrievalFusion.query()`/`.explainSelection()`; no remaining `'legacy'`/`'compare'` mode references outside historical comments; the 3 inert `ABLATION_MODE` setters (documented above, not fixed).
- Reconfirmed the one pre-existing failing unit test (`evidencePacketBuilder.test.ts`) still fails identically to the pre-Phase-1 baseline.
