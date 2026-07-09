# RepoGuide Architecture Conformance Report

Audited 2026-07-02 against `ARCHITECTURE_FREEZE.md`, treating Part 5's "Permanently Frozen Decisions" as non-negotiable. Findings are from direct code inspection (file:line cited throughout).

**Framing note:** `ARCHITECTURE_FREEZE.md` itself claims Readiness Scores of 9.5–9.8/10 across all three contracts and states "RepoGuide can proceed to implementation without another architectural redesign." That claim is not supported by the code as it stands today — most notably, the RepositoryBrain contract (Part 3) is almost entirely unimplemented despite a claimed 9.5/10 score. This gap between the freeze document's stated confidence and actual implementation state is itself a finding, consistent with the pattern of self-validating documentation noted in the separate `REPOGUIDE_AUDIT.md`.

## Summary Table

| # | Check | Verdict |
|---|---|---|
| 1 | One canonical answer path | **Violates** |
| 2 | ExecutionPlanner ownership | **Conforms** |
| 3 | EvidenceProvider contract | **Partially Conforms** |
| 4 | No provider-specific branching | **Violates** |
| 5 | RepositoryBrain API completeness | **Not Yet Implemented** |
| 6 | MCP as facade | **Fixed (2026-07-09)** — see Check 6 |
| 7 | AnswerGate mandatory | **Violates** |

---

## 1. One Canonical Answer Path

**Verdict: Violates**

RepoGuide has at least **five** distinct answer-production paths, not one:

- **Legacy vs. evidence split.** `src/query/queryDispatcher.ts:80-92` reads `repoguide.queryArchitecture` (default `'evidence'`, `package.json:106`) and branches: `'evidence'` → `runEvidenceQuery()`; anything else → `this.legacyPipeline.query()` (`HybridQueryPipeline`, constructed in `src/extension.ts:473-486` and wired into `QueryDispatcher` at `extension.ts:603-616`). Both are live in production, gated only by a setting.
- **`explainSelection`/`explainSelectionResult` always use legacy**, unconditionally, regardless of the `queryArchitecture` setting (`queryDispatcher.ts:310-321, 323-336`).
- **`InvestigationEngine`** (invoked from `extension.ts:464`) and **`src/ui/docReportPanel.ts`** never call `QueryDispatcher`, `AnswerGate`, `ExecutionPlanner`, or `HybridQueryPipeline` at all (confirmed by grep across both files returning zero matches) — two additional, fully independent answer-production paths outside canonical orchestration.
- ~~3 of 4 MCP tools bypass the canonical pipeline~~ **Fixed 2026-07-09, see Check 6** — `retrieve_raw_evidence`, `get_dependents`, and `get_facts` now route through `QueryDispatcher.retrieveRawEvidence()`. No longer a live contributor to this check's "at least five paths" count.

**Legacy-only capabilities that block deletion:**
- `explainSelection`/`explainSelectionResult` logic (`queryDispatcher.ts:310-336`) — not implemented on the evidence path at all.
- **Conversation history.** `HybridQueryPipeline.query()` records turns via `this.history.add(...)` (`hybridQueryPipeline.ts:125-126, 175-176`). `QueryDispatcher.runEvidenceQuery`'s `PlanningRequest` (`queryDispatcher.ts:109-119`) never populates `conversationContext`, even though `ExecutionPlanner`'s `PlanningRequest` type already supports that field (`executionPlanner.ts:34`) — the plumbing exists on the planner side but isn't connected upstream. Multi-turn context is legacy-only today.
- No other `QueryDispatcher`/`HybridQueryPipeline` public methods are legacy-exclusive beyond these two.

**What it would take to reach one canonical path:**
1. Wire `conversationContext` from the chat entry point into `runEvidenceQuery`'s `PlanningRequest` (the planner already accepts it).
2. Implement `explainSelection`/`explainSelectionResult` against the evidence pipeline (`ExecutionPlanner` + `RetrievalOrchestrator` + `AnswerGate`), using the `mode: 'explain_selection'` value the frozen `PlanningRequest` contract already reserves for this (`ARCHITECTURE_FREEZE.md` Part 1).
3. Delete `HybridQueryPipeline` and the `legacyPipeline` field/branch in `QueryDispatcher`.
4. Route `InvestigationEngine` and `docReportPanel.ts` through `QueryDispatcher` (or an explicitly-sanctioned `mode: 'investigation'` plan, which the frozen contract also already reserves).
5. ~~Route the 3 non-conforming MCP tools through the canonical pipeline~~ **Done, see Check 6.**

**Fix size:** Moderate for items 1–3 (a well-scoped port with an existing target shape). Architectural for items 4–5 (`InvestigationEngine` and `docReportPanel` are structurally separate subsystems that were never designed against `ExecutionPlanner`/`RetrievalOrchestrator`, and MCP's raw tools need a `raw_evidence` mode integration, not a small patch).

**Confidence:** High — every path and gap cited above was directly confirmed by reading the code, not inferred.

---

## 2. ExecutionPlanner Ownership

**Verdict: Conforms**

The actual planner is `ExecutionPlanner` (`src/query/executionPlanner.ts:157-237`), invoked from `QueryDispatcher.runEvidenceQuery` (`queryDispatcher.ts:109-119`).

- **No direct store/retrieval calls:** `executionPlanner.ts` imports only planning helpers (`buildEvidencePlan`, `scoreQueryComplexity`, `buildLLMEvidencePlan`) — no `LanceStore`/`BM25Store`/`FactStore`/`SymbolIndex`/`ProgramGraphStore` import anywhere in the file. Store access happens only inside `EvidenceProvider` implementations invoked later by `RetrievalOrchestrator.execute` (`retrievalOrchestrator.ts:88`).
- **No RepositoryBrain mutation:** the planner only sets a plan flag, `intelligencePlan.enabled = providerIds.includes('repository_brain')` (`executionPlanner.ts:205`) — never calls into RepositoryBrain itself.
- **No answer synthesis:** synthesis happens only in `QueryDispatcher.runEvidenceQuery` via `this.synthesizer.synthesize(packet, inferenceModel)` (`queryDispatcher.ts:231`), after planning and retrieval are already complete. `buildLLMEvidencePlan` does call an LLM (`planning/llmEvidencePlanner.ts:54`), but explicitly only to produce a JSON *plan* ("Do NOT answer the question. Only return a JSON plan.", `llmEvidencePlanner.ts:18`) — not the user-facing answer.
- **No AnswerGate call:** no `AnswerGate` import in `executionPlanner.ts`; gate validation happens only in `QueryDispatcher.runEvidenceQuery` (`queryDispatcher.ts:236`).
- **Clean planner/retrieval separation:** `ExecutionPlanner.plan()` (`executionPlanner.ts:160-236`) returns a plain object and does nothing else; retrieval execution is the distinct `RetrievalOrchestrator` class (`retrievalOrchestrator.ts:41-127`), which loops over injected `EvidenceProvider[]` instances. `QueryDispatcher` wires them sequentially (`queryDispatcher.ts:109` then `:147`).

**Non-blocking gaps worth noting (do not violate the ownership rule, but are incompleteness relative to the frozen "Canonical Pipeline" stage list):**
- The real `ExecutionPlan` carries a legacy `evidencePlan: EvidencePlan` field explicitly commented "Temporary compatibility surface until EvidencePacketBuilder consumes only normalized orchestration output" (`executionPlanner.ts:153-154`) — acknowledged debt, not yet resolved.
- The frozen pipeline names distinct Intent Analysis and Strategy Selection stages backed by `StrategyRouter`/`QueryIntentRouter`. Neither is imported by `executionPlanner.ts`; those two modules are only used by the legacy `hybridRetrievalFusion.ts` path and evaluation scripts. The real planner does complexity scoring plus regex/LLM query-type classification, but not a separately-named intent-analysis stage.

**Confidence:** High — ownership boundary is directly confirmed clean; the pipeline-completeness caveats are also directly confirmed, not inferred.

---

## 3. EvidenceProvider Contract

**Verdict: Partially Conforms**

The `EvidenceProvider` interface exists close to verbatim at `src/query/retrievalProvider.ts:92-103` (`id`, `kind`, `capabilities`, `initialize`, `health`, `canHandle`, `retrieve`, `shutdown`), plus one addition not in the frozen spec: `readiness(): Promise<ProviderReadinessStatus>` (`retrievalProvider.ts:99`).

**Per-subsystem verdicts:**

| Subsystem | Raw API | Conformance |
|---|---|---|
| HybridRetrievalFusion | `retrieveContext()`, `searchBm25Evidence()`, etc. (`hybridRetrievalFusion.ts:81,100,570,589...`) | **Adapter conforms** — `HybridRetrievalProvider` (`src/query/hybridRetrievalProvider.ts:21-116`) |
| RepositoryBrain (RepositoryBrainEvidenceStore) | single `execute(plan)` (`repositoryBrainEvidenceStore.ts:16,60`) | **Adapter conforms** — `RepositoryBrainProvider` (`src/query/repositoryBrainProvider.ts:17-49`) |
| FactStore | `init/upsertFacts/getFact/findBySymbol/findByType/queryFacts` (`src/store/factStore.ts:6,12,62,129,137,141,149`) | **Adapter conforms** — `FactStoreProvider` (`src/query/factStoreProvider.ts:39,60`) |
| LogicalUnitStore | `getUnit/getUnitsByFile/searchBySymbol/searchByContent` (`src/store/logicalUnitStore.ts:23,139,147,162`) | **Adapter conforms** — `LogicalUnitStoreProvider` (`src/query/logicalUnitStoreProvider.ts:17,39`) |
| ProgramGraphStore | `build/load/save/getOutbound` (`src/store/programGraphStore.ts:15,24,39,55`) | **Adapter conforms** — `ProgramGraphProvider` (`src/query/programGraphProvider.ts:17,36`) |
| SymbolIndex | `lookup/lookupFuzzy/lookupExact/lookupByConceptTokens` (`src/indexing/symbolIndex.ts:14,45,54,125`) | **Adapter conforms** — `SymbolIndexProvider` (`src/query/symbolIndexProvider.ts:17,38`) |
| LanceStore | `init/insertChunks/getChunksByFile/queryByVector/searchByKeywords` (`src/store/lanceStore.ts:20,29,50,67,81,164`) | **Ad hoc, no conformance** — no `lanceStoreProvider.ts` exists; only reachable indirectly inside `HybridRetrievalFusion`, not independently registered under the `'vector_store'` kind the taxonomy defines |
| BM25 store | `init/insertChunks/search/getChunkCount` (`src/store/bm25Store.ts:13,31,56,98`) | **Ad hoc, no conformance** — no `bm25Provider.ts` exists; only reachable via `HybridRetrievalFusion.searchBm25Evidence()`, not independently registered under the `'bm25'` kind |

All 6 conforming providers are instantiated together and registered with the orchestrator in `src/extension.ts:445-449`, `src/mcp/mcpServer.ts:192-197`, and `src/evaluation/queryPipelineHarness.ts:195-199`.

**Gap:** 6 of 8 named systems conform via the adapter pattern. LanceStore and BM25 — two of the most heavily-used retrieval sources — are not independently pluggable providers; they're subsumed as private implementation details of `HybridRetrievalFusion`, contradicting the frozen provider taxonomy that lists `vector_store` and `bm25` as distinct, independently addressable `EvidenceProviderKind` values.

**Fix size:** Moderate — write `lanceStoreProvider.ts` and `bm25Provider.ts` wrapping the existing methods, and register them as independent providers.

**Confidence:** High — every adapter file and its `implements EvidenceProvider` declaration was directly confirmed; the LanceStore/BM25 gap was confirmed by an exhaustive search finding no such files exist.

---

## 4. No Provider-Specific Branching

**Verdict: Violates**

Part 4 forbids `if provider is RepositoryBrain` / `if provider is HybridRetrieval` style branching in `EvidencePacketBuilder`, restricting branches to normalized fields (`type`, `source`, `freshness`, `confidence`, `priority`). No literal provider-identity string checks (e.g. `.provider === 'repository_brain'`) exist in either file — but **8 distinct provider/channel on-off switches exist via the `ABLATION_MODE` environment variable**, which are functionally identical to the forbidden pattern (they gate entire retrieval channels by source identity, just spelled as an env-var comparison instead of an object-identity check):

- `src/query/evidencePacketBuilder.ts:75` — `if (process.env.ABLATION_MODE !== 'bm25_only')` — gates symbol-hint retrieval (`unitStore.searchBySymbol`/`factStore.findBySymbol`).
- `evidencePacketBuilder.ts:138` — `if (process.env.ABLATION_MODE !== 'graph_only')` — gates the entire BM25 retrieval block.
- `evidencePacketBuilder.ts:164` — `if (process.env.ABLATION_MODE !== 'bm25_only')` — gates fact-expansion plus the full graph-expansion block (callees/callers/fallbacks/instantiations, impact analysis).
- `src/query/hybridRetrievalFusion.ts:207` — gates symbol-index injection into BM25 results by `ABLATION_MODE`.
- `hybridRetrievalFusion.ts:307` — gates concept-map injection by `ABLATION_MODE`.
- `hybridRetrievalFusion.ts:634` (`searchBm25()`) — `return []` when `ABLATION_MODE` is `'graph_only'` or `'vector_only'` — disables BM25 entirely.
- `hybridRetrievalFusion.ts:674` (`searchVector()`) — `return []` when `ABLATION_MODE` is `'no_vector'`, `'bm25_only'`, or `'graph_only'` — disables vector retrieval entirely.
- `hybridRetrievalFusion.ts:694` (`searchPageRank()`) — `return []` when `ABLATION_MODE` is `'bm25_only'` or `'vector_only'` — disables graph/PageRank retrieval entirely.

`SYMBOL_RANKING_MODE` (`hybridRetrievalFusion.ts:248-251`) and `LOG_TOKENIZATION` (`hybridRetrievalFusion.ts:211`) are **not** violations — they only rescale a numeric ranking weight and toggle debug logging, respectively, with no source-gating behavior.

**Fix size:** Quick fix — these are ablation-study flags for offline retrieval benchmarking, not user-facing behavior. Strip them from the production hot path (`evidencePacketBuilder.ts`, `hybridRetrievalFusion.ts`) and move ablation control into the evaluation harness, where it can gate provider selection through `ExecutionPlan.retrievalPlan.providerIds` — a mechanism the frozen contract already defines for exactly this purpose — instead of scattered `process.env` checks deep inside retrieval internals.

**Confidence:** High — all 8 sites were directly read, with code excerpts confirming the behavior described.

---

## 5. RepositoryBrain API Completeness

**Verdict: Not Yet Implemented**

None of the 10 frozen public methods (`observe`, `validate`, `promote`, `retrieve`, `query`, `explain`, `invalidate`, `refresh`, `retire`, `forget`) exist as specified, across all three RepositoryBrain-related classes:

- `RepositoryBrainEvidenceStore` (`src/query/repositoryBrainEvidenceStore.ts`) exposes exactly one public method: `execute(plan: EvidencePlan): EvidenceItem[]` (line 60).
- `RepositoryBrainProvider` (`src/query/repositoryBrainProvider.ts`) implements the *generic* `EvidenceProvider` interface from Part 2 (`initialize`, `health`, `readiness`, `canHandle`, `retrieve`, `shutdown` — lines 51, 56, 67, 75, 85, 139), not the Part 3 knowledge API. Only `retrieve` name-matches one of the 10 verbs, and its signature is the generic `EvidenceProviderRequest → EvidenceProviderResponse`, not `RepositoryKnowledgeRetrieveRequest/Response`.
- `RepositoryBrainOrchestrator` (`src/orchestrator/repositoryBrainOrchestrator.ts`) exposes `runFullRebuild()` (line 29) and `executeStep()` (line 122) — a rebuild pipeline, not a knowledge CRUD/lifecycle API.

Per-verb result: `observe` — absent. `validate` — absent (an unrelated `src/memory/ingestion/validationPipeline.ts` exists but belongs to the separate memory subsystem). `promote` — absent anywhere in `src/`. `retrieve` — present only as the generic provider method, not the typed knowledge retrieve. `query` — absent as a named method (`RepositoryBrainEvidenceStore.execute(plan)` is the closest analog, differently named and typed). `explain`, `invalidate`, `refresh`, `retire`, `forget` — all absent.

**Lifecycle:** no `RepositoryKnowledge` interface, `KnowledgeLifecycleState`, or `KnowledgeValidationState` type exists anywhere in `src/` (exhaustive grep, zero hits). What's actually persisted is `MemoryRecord` (`src/memory/memoryTypes.ts:1-16`), with a single **boolean** `stale` field (line 9) — not the frozen 8-state enum. The literal state names (`candidate`, `validated`, `promoted`, `contradicted`, `archived`) appear only in an *evaluation fixture* type (`src/evaluation/memory_ingestion_golden_types.ts:35`) with a different vocabulary (`merged`, `dormant`, `staled` instead of `active`, `stale`, `retired`) — test-only, not backing production data. `RepositoryBrainProvider` derives freshness as a two-value `item.stale ? 'stale' : 'unknown'` (`repositoryBrainProvider.ts:149`), not the frozen four-value `fresh | possibly_stale | stale | unknown`.

**Assessment:** This is the single largest gap in the audit. The freeze document assigns RepositoryBrain a 9.5/10 readiness score and states its schema, lifecycle, and API are "frozen" — but essentially none of it backs the current implementation. What exists today (`RepositoryBrainEvidenceStore.execute()`, a boolean-stale `MemoryRecord`) is a simpler, different system that happens to occupy the same conceptual space, not a subset implementation of the frozen contract.

**Fix size:** Architectural — this requires designing and building the `RepositoryKnowledge` schema, the 8-state lifecycle with transition rules, the validation/promotion policy engine, and the 10-method API from scratch. Not a porting exercise; there is no partial implementation to extend.

**Confidence:** High — exhaustive grep across `src/` for all 10 verb names and all lifecycle-state strings, plus full reads of all three RepositoryBrain-adjacent files, found no matches beyond what's cited.

---

## 6. MCP as Facade

**Verdict: Fixed (2026-07-09).** Originally violated — see "Original finding" below, preserved for
history. Fixed in commit `c261fa79` ("Consolidate onto a single canonical query path"), and
independently re-verified today by direct code inspection (not just trusting the commit message):

- **`retrieve_raw_evidence`, `get_dependents`, and `get_facts`** (`src/mcp/mcpServer.ts`) now all
  call `queryDispatcher.retrieveRawEvidence(...)`, the canonical `mode: 'raw_evidence'` path
  (`ExecutionPlanner` → `RetrievalOrchestrator`) — exactly the target shape this report's original
  "Fix size" note below anticipated. In-code comments at each call site document the migration and
  note it's a strict evidence upgrade (the orchestrator also invokes `fact_store`/`symbol_index`/
  `program_graph` providers for the same query, not just the one store each tool used to call
  directly).
- **`ask_repoguide`** already conformed (unchanged) and now additionally surfaces the same
  `gateStatus` trust-visibility signal the chat UI renders (see the UX trust-visibility work), so
  MCP callers get gate-outcome parity with chat, not just pipeline parity.
- **Not a re-introduction of the original gap under a different name:** the 3 raw-evidence tools
  deliberately do not call `AnswerGate.verify()` (see Check 7) — this is correct, not an oversight,
  because they now return retrieval *items*, not answer-shaped text. The pre-fix version of
  `get_facts`/`get_dependents` was flagged as a real trust gap specifically because it returned
  answer-shaped output with no verification; that shape no longer exists.
- **One residual, disclosed parity gap (not a hardening hole):** raw-evidence items returned by
  these 3 tools don't carry the `stale` flag that answer-path packets do (`EvidencePacketBuilder`'s
  `checkStale`/redaction logic is packet-construction-specific and isn't in this path) — an MCP
  caller gets no index-freshness signal on raw evidence. Tracked in `LIMITATIONS.md`. Not a
  verification bypass, since no answer is being asserted from raw evidence in the first place.

**Original finding (2026-07-02, now resolved):** Of the 4 registered MCP tools in
`src/mcp/mcpServer.ts`, only one was a genuine facade over the canonical engine — `ask_repoguide`
called `queryDispatcher.query(...)`, while `retrieve_raw_evidence`, `get_dependents`, and
`get_facts` called `hybridRetrievalProvider`/`symbolIndex`/`importGraphSearcher`/`factStore`
directly, bypassing `QueryDispatcher`, `ExecutionPlanner`, `RetrievalOrchestrator`, and
`AnswerGate` entirely — 3 of 4 MCP tools (75% of the surface), directly contradicting Part 5's
frozen decision "MCP is a facade over the canonical engine" and Part 4 rule 8. Fix size was
estimated as Moderate, since the frozen `PlanningRequest.mode: 'raw_evidence'` value already
anticipated exactly this use case — that estimate held; no architectural rework was needed beyond
wiring the existing target shape.

**Confidence:** High — direct read of the current `mcpServer.ts` and `queryDispatcher.ts`
(`retrieveRawEvidence` method), not inferred from the commit message alone.

---

## 7. AnswerGate Mandatory

**Verdict: Violates**

`AnswerGate.verify()` is called in exactly one place: `QueryDispatcher.runEvidenceQuery` (`queryDispatcher.ts:236`). Every other answer-producing path bypasses it:

- **`HybridQueryPipeline`** (legacy path, reachable whenever `queryArchitecture !== 'evidence'`, and unconditionally for `explainSelection`/`explainSelectionResult`) — a repo-wide grep for `AnswerGate` across `src/` returns 12 files, and `hybridQueryPipeline.ts` is not among them.
- **`InvestigationEngine`** — no `AnswerGate` reference found.
- **`docReportPanel.ts`** — no `AnswerGate` reference found.
- ~~MCP's `retrieve_raw_evidence`, `get_dependents`, `get_facts`~~ **No longer a bypass, as of 2026-07-09 (see Check 6).** These 3 tools now route through `QueryDispatcher.retrieveRawEvidence()` and correctly still do not call `AnswerGate.verify()` — by design, not omission, since they return retrieval items, not answer-shaped text. The original finding here was specifically that the pre-fix versions returned answer-shaped output with zero verification; that shape was removed along with the direct-store-access bypass, not just the routing.

**Gap:** The one frozen invariant stated most emphatically ("AnswerGate is mandatory") has at least four live bypass routes (originally five; the 3 MCP raw-evidence tools no longer count, see above). This directly compounds Check 1 and Check 6 — every unconsolidated answer path is also an unvalidated answer path.

**Fix size:** Architectural in aggregate (four separate integrations remaining, several into subsystems — `InvestigationEngine`, `docReportPanel` — that were never designed with a gate step in mind), though each individual integration is closer to Moderate once Check 1's consolidation work is done, since fixing Check 1 (routing everything through `QueryDispatcher`) resolves most of this gap as a side effect rather than requiring four independent gate integrations.

**Confidence:** High — the `AnswerGate` grep result and per-path absence checks are direct evidence, not inference.

---

## Cross-Cutting Observation

Checks 1, 6, and 7 were not independent findings — they were three symptoms of the same root cause: **there was no single enforced entry point.** `QueryDispatcher` is architecturally capable of being that entry point (Check 2 shows `ExecutionPlanner` is clean, and the evidence path that does run through `QueryDispatcher` does get `AnswerGate` validation); as of 2026-07-09, MCP's raw-evidence tools have joined it (Check 6, fixed), leaving three other code paths (`HybridQueryPipeline`, `InvestigationEngine`, `docReportPanel`) still reaching evidence/answers without going through it. Fixing Check 1 for those three remaining paths substantially fixes the rest of Check 7 as well — this should be treated as one consolidation effort, not several separate fixes.

Check 5 (RepositoryBrain) is a separate, larger gap: not a consolidation problem but a from-scratch build. The freeze document's 9.5/10 confidence score for that contract does not reflect the code as it exists today.
