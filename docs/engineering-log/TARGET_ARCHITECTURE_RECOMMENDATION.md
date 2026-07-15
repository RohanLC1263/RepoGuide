# Target Architecture Recommendation

Read-only analysis; no code changed. Synthesizes `VISION.md`, `ARCHITECTURE_FREEZE.md`, `REPOGUIDE_AUDIT.md`, `ARCHITECTURE_CONFORMANCE_REPORT.md`, and `REPOSITORYBRAIN_REUSE_ANALYSIS.md` (Parts A/B) into a definitive recommendation. Where I disagree with `ARCHITECTURE_FREEZE.md`, I say so directly rather than deferring to it — that document's own Readiness Scores were already shown (Part A) to be disconnected from what's actually built, so it is treated here as a strong starting proposal, not as settled fact.

## Bottom line

**Parts 1, 2, and 4 of the frozen contract (ExecutionPlanner, Retrieval Provider Architecture, Cross-Contract Consistency) are the right target and are already substantially real.** Keep them frozen. The remaining work is consolidation, not redesign — and Part B shows that consolidation is cheaper than the earlier conformance audit implied.

**Part 3 (RepositoryBrain) is directionally right but wrong as a v1 build target.** The 8-state lifecycle and 10-method API are the correct end state — they solve real problems (staleness, contradiction, confidence provenance) that today's destructive-rebuild approach genuinely doesn't. But specifying that full end state as the thing to build next, before any of it has run against real usage, is over-engineering relative to what Part A found: real, valuable domain logic sitting one wiring change away from producing value, gated behind nothing but an orchestrator nobody calls. **Amend Part 3**: build a reduced-but-real v1 first (below), not the full contract in one pass.

**Neither `ARCHITECTURE_FREEZE.md` nor the current codebase adequately addresses scale (repo size) or language breadth.** This is a real gap the frozen doc doesn't speak to at all — it's not a "decision that may evolve," it's an omission. Any target architecture claiming reliability "on a project folder of any size or language" has to add this as an explicit axis.

---

## 1. The pipeline layer: keep as frozen, finish consolidating

`ExecutionPlanner` cleanly respects its ownership boundary today (`ARCHITECTURE_CONFORMANCE_REPORT.md` check 2: Conforms — no direct store access, no RepositoryBrain mutation, no synthesis, no gate bypass). `RetrievalOrchestrator` and 6 of 8 `EvidenceProvider` adapters are real and wired (check 3: Partially Conforms — only `LanceStore`/`BM25` lack standalone adapters, currently reachable only as private internals of `HybridRetrievalFusion`). This is good, working architecture. Don't touch the shape of it.

What's missing is consolidation onto this pipeline as the *only* pipeline, and Part B changes the cost estimate for that materially:

- **The retrieval layer is already unified.** `HybridRetrievalFusion.retrieveContext()` is the single real retrieval implementation; both the legacy pipeline and the evidence path call the same method (on separate instances wrapping the same underlying stores — Part B §1, §3). There is no second retrieval algorithm to reconcile. The earlier conformance report's "Architectural" fix-size estimate for retiring the legacy path was pessimistic on this point.
- **What legacy actually adds beyond the evidence path is two things**: `explainSelection`/`explainSelectionResult`, and conversation-history threading (Part B §5). Both are well-scoped, described in that document with the exact functions/files involved. This is a **Moderate** job, not an architectural rewrite.
- **Retiring `HybridQueryPipeline` closes three gaps from `ARCHITECTURE_CONFORMANCE_REPORT.md` at once**: check 1 (one canonical path), check 6 (MCP as facade — the 3 non-conforming MCP tools should route through the same consolidated pipeline instead of calling stores directly), and check 7 (AnswerGate mandatory — once there's one path, there's nowhere left for an answer to skip validation).

**Two more paths need to join the consolidation that weren't in the original legacy/evidence framing**: `InvestigationEngine` and `PlanAnalyzer` both call `HybridRetrievalFusion`'s low-level API directly (Part B §1, "additional finding"), powering `/investigate` and plan analysis, and neither calls `AnswerGate`. Same for `docReportPanel.ts` per the earlier conformance audit. These are QueryCategory-relevant (`debugging`, `investigation`, `documentation` — see §5 below) and currently sit completely outside the canonical pipeline. Fold them in using the same `PlanningRequest.mode` mechanism the frozen contract already reserves (`'investigation'`, and a `'documentation'` mode would need adding to the frozen `mode` union) rather than leaving them as permanent side-channels.

**Amendment to Part 4:** add explicit guidance that `EvidencePacketBuilderStores.lanceStore` (Part B §4 — wired but never referenced, dead code) and similar dead wiring should be caught by a lint rule or periodic audit, not just found by accident during unrelated investigations. Not a contract change, a process gap the contract doesn't cover.

## 2. RepositoryBrain: build the schema/lifecycle/API, adapt the domain logic, sequence it

Endorse the frozen `RepositoryKnowledge` schema and 8-state lifecycle as the correct **eventual** target — it's the only thing in scope that actually solves contradiction-tracking, staleness, and confidence provenance with rigor. But recommend building it in two phases instead of one:

### v1 (get real value flowing)
- Implement 4 of the 10 methods for real: `observe()`, `retrieve()`, `query()`, `invalidate()`. Skip `validate()`/`promote()` as separate gated steps initially — instead, let `observe()` write records with a confidence score computed the same way `decisionOutcomeBuilder.ts`/`incidentIntelligenceBuilder.ts` already compute it (Part A), and use a fixed threshold to set initial `lifecycleState` directly to `candidate` or `active` without a separate promotion ceremony.
- Collapse the lifecycle to 4 effectively-enforced states for v1: `candidate → active → stale → retired`. Keep `validated`/`promoted`/`contradicted`/`archived` **in the schema** (so the type is forward-compatible and nothing has to migrate later) but don't build enforcement/transition logic for them yet.
- **Rewire `RepositoryBrainOrchestrator` into production.** This is the single highest-leverage fix Part A surfaced: real analytical logic (noisy-OR incident risk fusion, log-scaled decision-outcome confidence, causal trend detection) exists and is disconnected from every user-facing path purely because nothing in `extension.ts` ever constructs the orchestrator. Trigger it the same way `ComprehensionEngine`/watchers already work (`REPOGUIDE_AUDIT.md` confirmed this pattern is real and functioning) — on a background schedule and after significant index changes, not on every query.
- **Migrate, don't rewrite**, the three builder files (`causalReasoningBuilder.ts`, `decisionOutcomeBuilder.ts`, `incidentIntelligenceBuilder.ts`) to write into the new `RepositoryKnowledge` store instead of their current flat, destructively-overwritten tables. The scoring formulas themselves don't need to change.
- Delete `archive/repository_brain.sqlite` (Part A confirmed: 8 rows of seed-script fixture data, nothing worth migrating) and the throwaway `seed_db.ts`/`test_traces.ts` scripts once their smoke-test purpose is superseded by real usage.

### v2 (once v1 has real usage data)
- Add `validate()`/`promote()` as genuine gated transitions, calibrating confidence thresholds against actual outcomes rather than the current hardcoded, uncalibrated per-factor weights (Part A flagged `incidentIntelligenceBuilder.ts`'s 80/90/70/60/95/85 contribution scores as deliberate-but-uncalibrated heuristics — don't build an elaborate promotion gate on top of numbers nobody has checked against reality yet).
- Add `contradicted`/`archived` lifecycle enforcement, `explain()`, `refresh()`, `retire()`, `forget()`.
- Only at this point does the full frozen Part 3 contract become the honest state of the system.

**Why this isn't a violation of frozen ownership/lifecycle rules:** RepositoryBrain in v1 still only owns persistent intelligence, still contributes evidence only through the `EvidenceProvider` interface, still never bypasses `AnswerGate`. This is a sequencing decision about *when* each documented capability gets built, not a change to *what RepositoryBrain is allowed to touch*. It is exactly the kind of "lighter first version that gets more value sooner without violating frozen ownership/lifecycle rules" the brief asked me to evaluate — and I think it clearly qualifies.

**Explicit disagreement with `ARCHITECTURE_FREEZE.md`:** Part 5's Readiness Scores (RepositoryBrain: 9.5/10) should be removed from any future version of this document, not corrected to a new number. A single self-assessed score implies a level of validation that no part of this project currently has a mechanism to produce (no calibration data, no ground truth). Score tables like this are exactly the pattern `REPOGUIDE_AUDIT.md` flagged as the project's recurring failure mode — confident-sounding self-validation that doesn't survive contact with the code. Replace it with a checklist of what's built vs. not, checkable by grep, the way `ARCHITECTURE_CONFORMANCE_REPORT.md` did.

## 3. Scale-agnostic: a real gap the frozen doc doesn't address at all

`ARCHITECTURE_FREEZE.md` says nothing about repository size. That's not a neutral omission — `REPOGUIDE_AUDIT.md` found concrete hard limits that will break on exactly the "large enterprise codebase" scale the mission statement calls out by name:

- `src/indexing/fileWalker.ts:129-135` hard-caps at `MAX_FILES = 2000`, silently dropping the deepest-path files beyond that with only a console warning. **Recommendation:** replace the hard cap with a priority-ordered streaming walk (entry points, recently-changed files, and high-fan-in files indexed first) with a *configurable* soft budget, and surface truncation to the user as a real diagnostic (fits the frozen contract's existing `EvidenceGap`/`coverage_insufficient` machinery) instead of a console warning nobody sees.
- `src/indexing/indexManager.ts:259-330` indexes files strictly sequentially, one chunk embedded at a time. **Recommendation:** bounded worker-pool concurrency for embedding calls, scaled to available CPU/GPU, matching the incremental-update pattern the watchers already use successfully.
- `src/store/lanceStore.ts` has no ANN index creation (LanceDB supports IVF_PQ/HNSW) and loads full tables into memory for `getAllChunks()`/`getAllFilePaths()`. **Recommendation:** create a real vector index at a repo-size threshold, and paginate the full-table reads.
- `src/store/bm25Store.ts` re-serializes the entire index as one JSON blob on every save. **Recommendation:** segment-based incremental persistence.

None of this requires touching the frozen contract — it's entirely inside "Decisions That May Evolve" (provider set, performance budgets). It should be treated as equally urgent to the RepositoryBrain work, not lower-priority, because it's the difference between the product working at all on the repositories the mission statement is written for.

## 4. Stack-agnostic: generalize the semantic layer, don't just chunk more languages

AST *chunking* already covers 7 languages through one centralized dispatcher (`astChunker.ts`/`languageDetector.ts`) — good architecture, keep it. But the deeper semantic/fact-extraction layer that RepositoryBrain's builders and `EvidencePacketBuilder`'s fact/symbol lookups ultimately depend on has exactly one provider, TypeScript (`REPOGUIDE_AUDIT.md`). **Recommendation:** define a generic `SemanticProvider` interface — the same adapter pattern that already works for `EvidenceProvider` — and add the next 1-2 highest-value languages behind it (Python is the obvious first target: a real `python-fastapi` fixture already exists in `test/fixtures/`, unlike the JS/TS-only real-world eval corpora in `eval_repos/`). Fix the Kotlin-mapped-to-Java-grammar approximation with a real `tree-sitter-kotlin` grammar rather than leaving it as silent mis-parsing. Add at least one non-JS real-world eval corpus so "stack-agnostic" is a tested claim, not an aspirational one.

## 5. QueryCategory coverage: where the frozen list is honestly served today, and where it isn't

Mapping the frozen `QueryCategory` list against what actually answers each one right now:

| Category | Frozen mapping rule | Actually served by | Status |
|---|---|---|---|
| `factual_lookup` | FactStore, BM25, symbols | `FactStoreProvider` (real adapter) | OK |
| `symbol_lookup` | SymbolIndex, LogicalUnitStore, BM25 | `SymbolIndexProvider`/`LogicalUnitStoreProvider` (real adapters) | OK |
| `dependency_analysis` | ProgramGraphStore, import graph, symbols | `ProgramGraphProvider` (real adapter) | OK |
| `architectural_reasoning` | annotations, community summaries, graph, **RepositoryBrain** | Annotations/graph work; RepositoryBrain contributes empty results in production today (Part A — live DB has 0 populated tables) | **Degraded** — answers today are missing the RepositoryBrain contribution the frozen doc assumes exists |
| `debugging` | InvestigationEngine, hybrid retrieval, runtime evidence | `InvestigationEngine`, entirely outside `QueryDispatcher`/`AnswerGate` (Part B) | **Unvalidated** — answers in this category never pass through the mandatory gate |
| `investigation` | (same engine) | same | **Unvalidated**, same reason |
| `explain_selection` | — | Legacy pipeline only, unconditionally (Part B §5) | **Fixable, scoped** — see §1 |
| `documentation` | — | `docReportPanel.ts`, outside the canonical pipeline | **Unvalidated** |
| `repository_exploration` | — | Hybrid retrieval, broad/semantic — goes through the real pipeline | OK |
| `engineering_decision_support` | RepositoryBrain **plus** source evidence | Source evidence only; RepositoryBrain half is empty in practice | **Degraded**, same root cause as `architectural_reasoning` |
| `multi_step_reasoning` | — | `ExecutionPlanner`'s LLM planning path (`buildLLMEvidencePlan`) | OK, exists |

**Reading this table plainly: 4 of 11 frozen query categories either bypass mandatory answer validation entirely or silently receive degraded evidence from a subsystem the architecture assumes is contributing.** This is the most concrete way to state why consolidation (§1) and RepositoryBrain v1 (§2) are the two highest-priority items — they're not abstract cleanliness goals, they directly determine whether roughly a third of the query surface is trustworthy.

## 6. Recommended sequencing

1. **Consolidate onto one canonical path** (§1): port `explainSelection` + conversation history into the evidence path, delete `HybridQueryPipeline`, route `InvestigationEngine`/`PlanAnalyzer`/`docReportPanel`/the 3 non-conforming MCP tools through `QueryDispatcher`. This alone fixes 3 of the 7 conformance violations and closes the validation gap on 4 of 11 query categories.
2. **RepositoryBrain v1** (§2): wire the orchestrator into production, migrate the three real builders, implement the 4-method/4-state reduced API. This closes the other 2 degraded query categories and turns real, already-written domain logic into something users actually benefit from — the highest ratio of value-to-new-code in this entire recommendation, because the hard part (the analytical logic) is already built.
3. **Scale fixes** (§3): remove the hard file cap, add indexing concurrency, add a real vector index. Do this in parallel with 1-2, not after — it's independent of the query-path work and blocks the mission's own "any size" claim.
4. **Stack generalization** (§4): one additional `SemanticProvider` language (Python) plus a non-JS real-world eval corpus. Lower urgency than 1-3 but should not be indefinitely deferred — every quarter it's deferred is another quarter the "stack-agnostic" principle in `VISION.md` is aspirational rather than true.
5. **RepositoryBrain v2** (§2): validate/promote gating, remaining lifecycle states, calibrated thresholds — once v1 has produced enough real usage to calibrate against.

## 7. What to leave alone

For completeness, since the brief asked for a definitive recommendation, not just a list of problems: the `ExecutionPlanner`/`RetrievalOrchestrator`/`EvidenceProvider` contract shape, the `AnswerGate` verification model (block/revise/pass with refusal text), the centralized AST-chunking dispatcher, and the persistent memory/comprehension engine architecture are all sound and already working as designed. None of this needs rework — it needs to be finished being applied everywhere, which is what §1-§2 above are about.
