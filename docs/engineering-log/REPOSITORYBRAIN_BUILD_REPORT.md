# RepositoryBrain Build Report

Pass 2 implementation of the plan at `jaunty-churning-sky.md`, itself built on `ARCHITECTURE_FREEZE.md` Part 3, `REPOSITORYBRAIN_REUSE_ANALYSIS.md` Part A, and `TARGET_ARCHITECTURE_RECOMMENDATION.md` §5.

## 1. What was built

**Schema + lifecycle (new files)**
- `src/query/repositoryKnowledgeTypes.ts` — concrete shapes for the frozen contract's prose-only nested types (`KnowledgeSubject`, `KnowledgeClaim`, `KnowledgeConfidence`, `KnowledgeProvenance`, `KnowledgeFreshness`, `KnowledgeEvidenceRef`, `KnowledgeContradiction`), the full `RepositoryKnowledge` interface, and request/response types for all 10 API methods.
- `src/query/repositoryKnowledgeLifecycle.ts` — `LIFECYCLE_TRANSITIONS` map encoding exactly the 9 frozen transition rules, plus `assertTransition()` used by every state-mutating method.
- `src/query/repositoryBrainStore.ts` — SQLite storage for the unified `repository_knowledge` table: 9 indexes (id/type/subject/file/symbol/lifecycle/freshness/confidence/updated), a `schema_meta` table carrying `schema_version` for future migrations, simple fields as real columns and structurally richer fields (`claim`, `confidence`, `provenance`, `freshness`, `supportingEvidence`, `contradictions`, `tags`, `diagnostics`) as JSON columns.
- `src/query/repositoryBrain.ts` — the 10-method `RepositoryBrain` class (`observe/validate/promote/retrieve/query/explain/invalidate/refresh/retire/forget`), enforcing the lifecycle state machine as real code (illegal transitions return `{ok: false, reason}`, never silently succeed) and the frozen "active knowledge is never silently overwritten" rule (contradiction handling, independent-provenance confidence gating).
- `src/query/repositoryKnowledgeSubject.ts` — shared `entity_type`/`entity_id` → `KnowledgeSubject` mapping used by all 3 migrated builders.
- `src/query/repositoryBrain.test.ts` — 18 unit tests against an in-memory SQLite DB covering every method and the illegal-transition paths. All pass.
- `src/test/repositoryBrainProductionWiring.test.ts` — the "real caller" guard test (see §7). All 6 checks pass.

**Storage location**: `.repoguide/repository_brain.sqlite`, resolved via `getRepositoryArtifactPaths().repositoryBrainDb` in both `extension.ts` and `mcpServer.ts` (previously `mcpServer.ts` manually re-derived this path — now DRY). The same `DatabaseSync` connection backs both `repository_knowledge` and the domain builders' own detail tables (`causal_*`, `outcome_*`, `incident_*`, etc.), per the plan's storage design.

**Lifecycle enforcement**: `promote()` performs the `validated→promoted→active` two-hop in one call (no separate "activate" method exists); `retire()` handles both `→retired` and `retired→archived` (no separate "archive" method exists), gated by a retention window. `observe()` on a matched `active`/`stale` record never overwrites in place — a materially different claim moves the existing `active` record to `contradicted` (both claims preserved) and inserts a fresh `candidate`; a reinforcing claim only raises confidence when the new observation's provenance doesn't already overlap what's recorded.

**3 domain builders migrated** (`causalReasoningBuilder.ts`, `decisionOutcomeBuilder.ts`, `incidentIntelligenceBuilder.ts`): each takes an optional 3rd constructor argument (`repositoryBrain?: RepositoryBrain`, backward-compatible with all existing test call sites) and calls `observe()` once per computed entity, using the score/claim data the builder already computed. Scoring logic (noisy-OR risk fusion, log-scaled confidence, window-function trend detection) is unchanged.

**Orchestrator rewired** (`repositoryBrainOrchestrator.ts`): every one of the 13 required steps is now non-fatal (previously only 3 were try/catch-wrapped). A step throwing degrades that one knowledge type to empty and is recorded in `state.diagnostics`/`state.failedAtStep`; the run still reports `COMPLETED`. Production trigger added: `scheduleRepositoryBrainRebuild()` in `extension.ts`, mirroring `scheduleComprehensionQAGeneration()`'s pattern — fires ~60s after activation and again after every full reindex (not incremental saves, which already refresh evidence stores separately).

**Provider rewritten** (`repositoryBrainProvider.ts`): calls `RepositoryBrain.query()` directly with `request.intelligencePlan` fields; the `diagnosticsContext.evidencePlan` smuggling is gone.

**Registered in both production entry points**: `extension.ts`'s `RetrievalOrchestrator` previously had 7 providers with `RepositoryBrainProvider` entirely absent — RepositoryBrain-backed evidence had never reached the VS Code chat/panel surface. It's now the 8th provider there, matching `mcpServer.ts`.

**`developer_note` wired**: `repoguide.addNote`'s handler now calls `repositoryBrain.observe()` immediately after `notesManager.saveNote()`, mapping the note's title/content/tags/confidence into a `RepositoryKnowledge` record.

**`module_summary` confirmed still empty, left empty**: `ComprehensionEngine.runFullComprehension()` remains a one-line stub with the real module-summarization logic removed from source; `ComprehensionJobRunner` is never constructed anywhere. No live data source exists to wire. Unchanged from the Pass 1 plan's finding.

**Deleted**: `src/query/repositoryBrainEvidenceStore.ts` (superseded — its 8 sub-engine fan-out, mock stores, and hardcoded relevance scores are replaced by `RepositoryBrain.query()`).

## 2. Which of the 14 frozen knowledge types have real data sources

| Type | Status | Notes |
|---|---|---|
| `causal_explanation` | **Real, wired, verified** | `causalReasoningBuilder.ts` → `observe()`. See §3. |
| `decision_outcome` | **Real, wired, verified** | `decisionOutcomeBuilder.ts` → `observe()`. See §3. |
| `incident_pattern` | **Real, wired, verified** | `incidentIntelligenceBuilder.ts` → `observe()` (pattern mining only, not `incident_predictions` — see §5). See §3. |
| `developer_note` | **Real, wired** | `NotesManager` is a genuine feature; `repoguide.addNote` now calls `observe()`. This repo's own `.repoguide/notes.json` has zero notes authored so far — an empty result set once wired, not a broken pipeline. Verified via a scripted `observe()`/`forget()` round trip. |
| `module_summary` | **Confirmed empty, left empty** | No live generation exists (§1). Schema/mapping documented as a target for whenever comprehension generation is restored — not fabricated. |
| `ownership_expertise` | **Declared, not query-served** (as scoped) | `AuthorExpertiseBuilder` is real and gets constructed/wired into the orchestrator (§1), but no `observe()` call site was added — this repo's own git history has no signal yet (see §3), and deciding how "expertise" reads as a `RepositoryKnowledge` claim is a design question out of this build's scope, as agreed in Pass 1. |
| `decision_outcome`/`causal_explanation`/`incident_pattern`/`developer_note` are the only 4 types with real `observe()` call sites | — | The remaining 9 types (`architecture_decision`, `change_impact`, `runtime_mapping`, `knowledge_hotspot`, `coverage_risk`, `prediction_accountability`, `ownership_expertise`, `dependency_insight`, `repository_pattern`) stay declared-in-capabilities but empty — an honest empty `query()` result now, instead of a store that errored on missing tables. Wiring these was explicitly out of scope for this build (either no builder produces them at all, or — as decided in Pass 1 — deciding their query-serving shape is a separately-scoped design effort). |

`RepositoryBrainProvider.capabilities.evidenceTypes` stays at its existing 13 entries (unchanged) — `architecture_decision` was not added, since no builder produces it, matching the `dependency_insight`/`repository_pattern` reasoning.

## 3. Upstream signal table transparency (per your approved addition)

Two separate verification runs were done, and both matter for an honest picture:

**Run A — against this repository's own live `.repoguide/repository_brain.sqlite`.** All 13 builders were constructed exactly as `extension.ts`/`mcpServer.ts` now construct them, and `runFullRebuild()` was executed for real. Result: **11 of 13 steps failed non-fatally**, and `repository_knowledge` ended up **empty** (0 rows across all types). The upstream tables were checked directly:

| Table | Row count | Notes |
|---|---|---|
| `commits`, `commit_files` | **table does not exist** | No git-history ingestion has ever populated these in this workspace. |
| `adrs` | **table does not exist** | No ADR ingestion has run here. |
| `architectural_health_history` | **table does not exist** | Depends on drift/ADR pipeline above. |
| `knowledge_validity` | 0 | Table exists (created by `KnowledgeValidityStore`'s constructor) but empty — depends on the same upstream chain. |
| `validity_history` | 0 | Same. |
| `knowledge_hotspots`, `hotspot_history` | **table does not exist** | Depend on the same upstream chain. |
| `review_outcomes` | **table does not exist** | No review-intelligence ingestion has run here. |
| `incident_events` | 0 | Table exists, empty — no incidents ingested. |
| `coverage_history` | 0 | Table exists, empty — no coverage ingestion has run here. |
| `evolution_entities` | 0 | Table exists, empty. |

**This is not a bug in this build.** It is a direct, honest consequence of what the Pass 1 plan already flagged for `ownership_expertise`: this repository's own git history is 3 commits from a single session, and none of the separate ingestion pipelines (git-history importer, ADR linker, review-intelligence importer, coverage importer) have ever been run against this workspace. `AuthorExpertiseBuilder`, `LogicalCouplingBuilder`, `DriftBuilder`, and 7 other required builders all failed for the identical reason: **their own required upstream tables don't exist yet in this workspace**, independent of anything this build changed. The orchestrator's non-fatal handling worked exactly as designed — it recorded `state.status = 'COMPLETED'` with `state.diagnostics` naming all 11 failed steps, rather than crashing or (worse) silently reporting success with fabricated data.

**Run B — with synthetic upstream data seeded directly**, to isolate and verify the actual `observe()` wiring (which Run A couldn't exercise, since it never got upstream data to work with). Minimal rows were inserted into `architectural_health_history`, `knowledge_validity`/`validity_history`, `review_outcomes`, `incident_events` (2, sharing a factor pattern), `coverage_history`/`coverage_entities`, then `decisionOutcomeBuilder`, `causalReasoningBuilder`, `incidentIntelligenceBuilder` were run directly against an in-memory DB with a real `RepositoryBrain` wired in. Result:

```
repository_knowledge counts by type: { causal_explanation: 1, decision_outcome: 1, incident_pattern: 1 }
retrieve({type:'causal_explanation'}) -> 1 item(s): lifecycle=candidate conf=100.0 :: FAILURE explanation for ADR ADR-1: ...
retrieve({type:'decision_outcome'})   -> 1 item(s): lifecycle=candidate conf=36.1  :: ADR ADR-1 outcome: FAILED (score 0/100, health DEGRADING, validity DEGRADING)
retrieve({type:'incident_pattern'})   -> 1 item(s): lifecycle=candidate conf=20.0  :: Incident pattern for BUG: factors [ARCHITECTURAL_DECAY,COVERAGE_DEGRADATION] observed in 2 incident(s).
```

All 3 audited types produce real, correctly-shaped `RepositoryKnowledge` records (as `candidate` — `validate()`/`promote()` were not called in this script, matching the frozen lifecycle: nothing observes directly into `active`). **Conclusion**: the migration code is verified correct; this repository's dogfood environment simply has no upstream signal yet for the other 10 builders to work with. That will resolve itself once this workspace accumulates real commits/reviews/incidents, or is pointed at a repository with existing history (the `eval_repos/` fixtures, for instance).

## 4. Pre-existing bugs discovered and their disposition

Running these builders for real (not through the hand-written no-op stubs `repositoryBrainE2E.test.ts` used) surfaced several pre-existing bugs, none introduced by this build. Fixed vs. left, and why:

**Fixed** (small, clearly-scoped, directly blocked verifying this build's own migration):
- `decisionOutcomeBuilder.build()`: the `executeTransaction(...)` wrapper was constructed but **never invoked** — `tx` was assigned and never called, so the entire builder was dead code that inserted nothing, ever. This is why the live `decision_outcomes` table has always been empty. Fixed by calling `tx()` and using its return value.
- `decisionOutcomeQueryEngine.getOutcomeHistory()`: called `.all()` with no arguments against a parameterized query (`WHERE entity_type = ? AND entity_id = ?`) — the bound parameters were never passed. Fixed by passing them.
- `causalReasoningBuilder.build()`: `insertExp.run(..., outcome.id, ...)` — `decision_outcomes` has no `id` column (its primary key is `entity_type`+`entity_id`), so `outcome.id` is always `undefined` and the bind throws against real (non-fixture) data. Fixed by using the composite key as the outcome reference.
- `incidentIntelligenceBuilder.build()`: `observePatterns()` was sequenced after `computePredictions()`, so a failure in prediction computation (see below) would prevent already-mined patterns from ever reaching RepositoryBrain. Reordered so pattern observation happens right after `minePatterns()`, before the unrelated, more fragile prediction step.
- Two pre-existing test fixture gaps (`decisionOutcome.test.ts` missing a `coverage_entities` table, `causalReasoning.test.ts` missing a `coverage_history` table) that had been silently masked by the `tx()` bug above — once the builder actually ran, these surfaced. Fixed by adding the missing tables to each test's schema setup.
- One incorrect pre-existing test assertion (`decisionOutcome.test.ts`'s "DEGRADING Classification" test expected `outcomeType: 'DEGRADING'` from a health score that the builder's own documented score bands (`>=70` is `STABLE`) would never classify as `DEGRADING`). Fixed by adjusting the seeded health score so the test actually exercises the DEGRADING band it claims to.

**Found, not fixed** (deeper logic bugs in code outside the 3 audited builders' `observe()`-migration scope, or genuinely separate design questions):
- `incidentIntelligenceBuilder.computePredictions()` reads `decision_outcomes.adr_id`, a column that doesn't exist in `DecisionOutcomeStore`'s real schema (`entity_type`/`entity_id`, no `adr_id`). This means `incident_predictions` (not `incident_patterns`, which this build does wire) will always fail against real data. Left unfixed — it's prediction-scoring logic, not the `observe()` plumbing this build's scope covers, and the reordering fix in this same builder (above) already ensures it can't block pattern observation.
- `authorExpertiseBuilder.build()` references `commit_files.path`, but no repo in this workspace has ever populated a `commits`/`commit_files` table to check the real column name against. Left unfixed — `AuthorExpertiseBuilder` is one of the 10 unaudited builders per the Pass 1 scoping decision.
- `predictionAccountabilityBuilder.buildOutcomes()` references a column (`e.timestamp`) that doesn't exist against this workspace's tables. Same reasoning — unaudited builder, left unfixed.
- A schema inconsistency between `causalReasoningBuilder.ts`'s and `decisionOutcomeBuilder.ts`'s expectations of `review_outcomes` columns (`is_approved`/`security_issues` vs. `reviewer_accepted`) — both builders query the same table name expecting different shapes. Neither builder's own tests caught this because neither test suite seeds the other builder's expected columns. Documented here rather than fixed, since resolving it means picking one canonical `review_outcomes` schema — a decision that affects `reviewIntelligenceEngine.ts` and other consumers outside this build's scope.

None of these "found, not fixed" issues affect the 3 audited types this build is responsible for (`causal_explanation`, `decision_outcome`, `incident_pattern` all verified working end-to-end in §3, Run B).

## 5. Explicitly out of scope (confirmed unchanged from the Pass 1 plan)

- `ownership_expertise` query-serving path — builder is wired into the orchestrator (so its own table populates harmlessly), but no `observe()` call site, per the Pass 1 reasoning (no signal yet in this repo; claim shape is a design question).
- `dependency_insight`, `repository_pattern` — zero implementation anywhere in `src/`; not a wiring job.
- `incident_predictions` (risk-scored entity predictions, distinct from `incident_patterns`) — not mapped to any `RepositoryKnowledge` type in this build; the frozen 14-type list has `incident_pattern` but no separate "incident_prediction" type, and this build kept to that literal list.
- Restoring `ComprehensionEngine`'s deleted module-summarization logic — a separate, much larger effort.
- Fixing the "found, not fixed" bugs in §4 — outside the 3 audited builders / outside `observe()`-migration scope.

## 6. Re-check against `TARGET_ARCHITECTURE_RECOMMENDATION.md` §5

The frozen `QueryCategory` table previously read:

| Category | Status (before this build) |
|---|---|
| `architectural_reasoning` | **Degraded** — RepositoryBrain contributed empty results (0 populated tables in the live DB) |
| `engineering_decision_support` | **Degraded**, same root cause |

**After this build**: RepositoryBrain is now a real, registered `EvidenceProvider` in both `extension.ts` and `mcpServer.ts` (previously absent from `extension.ts` entirely — VS Code chat never received RepositoryBrain evidence at all). `RepositoryBrainProvider.retrieve()` calls `RepositoryBrain.query()`, which returns real `RepositoryKnowledge`-backed `EvidenceItem`s whenever `causal_explanation`, `decision_outcome`, `incident_pattern`, or `developer_note` knowledge exists and has reached `active` (via `validate()`+`promote()`). The `intelligencePlan.maxItems` bug that would have silently zeroed every RepositoryBrain query regardless of store contents (`executionPlanner.ts` hardcoded it to `0`) is fixed.

Both categories move from **Degraded** to **Partially populated, honestly**: the architecture no longer silently returns nothing from a subsystem it claims to be using — RepositoryBrain-backed evidence flows through end-to-end (verified in §3, Run B) whenever upstream signal exists, and produces a clean, diagnosed empty result (not an error, not a crash, not fabricated content) when it doesn't. Full resolution of "Degraded" for *this specific workspace* depends on the separate git-history/ADR/review-intelligence ingestion pipelines actually running here — a data-population question, not an architecture question, and outside this build's scope per §5 above.

## 7. Verification summary

- `npx tsc -p ./ --noEmit`: clean.
- `npx eslint src --quiet`: clean.
- `npm run test:unit`: passes (1 passing).
- Full jest suite: 214 passed / 34 failed suites (vs. 202 passed / 39 failed suites on the pre-existing baseline, measured identically before any change in this session) — a net improvement, and the remaining failures were independently confirmed pre-existing (identical failure signatures reproduced against the unmodified baseline via `git stash`).
- All 6 suites directly touched by this build (`repositoryBrain.test.ts`, `decisionOutcome.test.ts`, `causalReasoning.test.ts`, `repositoryBrainProductionWiring.test.ts`, `runtimePhaseD.test.ts`, `runtimePhaseE.test.ts`) — 45/45 tests pass.
- `repositoryBrainProductionWiring.test.ts` (new guard test): confirms `extension.ts` and `mcpServer.ts` both construct `RepositoryBrainOrchestrator` (not just import it), `extension.ts` schedules a real rebuild, both register `RepositoryBrainProvider`, and the superseded `RepositoryBrainEvidenceStore` is gone from both files and from disk.
- No path bypasses `AnswerGate`: `RepositoryBrainProvider` is a normal `EvidenceProvider` entry in `RetrievalOrchestrator`'s provider list in both entry points — its output flows through `EvidencePacketBuilder`/`EvidenceAnswerSynthesizer`/`AnswerGate` exactly like every other provider, with no special-cased bypass added anywhere in this build.

## 8. Cleanup

- `src/query/repositoryBrainEvidenceStore.ts` deleted.
- `src/seed_db.ts`, `src/test_traces.ts`, and one previously-undiscovered orphaned scratch script (`src/test_component23.ts`, a root-level standalone script with the same "run().catch(console.error)" pattern as the other two, referencing the now-deleted evidence store) moved to `archive/` — consistent with this repo's established archive-not-delete convention (`CLAUDE.md` Definition of Done #4), rather than hard-deleted.
- `archive/repository_brain.sqlite` (the pre-existing fixture, confirmed in an earlier session as traceable to `seed_db.ts`'s hardcoded inserts) was already archived from a prior phase; left as-is, no conflict with anything in this build.
- `src/test/runtimePhaseE.test.ts` updated: its one test exercising the deleted `RepositoryBrainEvidenceStore.execute('runtime_intelligence', ...)` markdown serialization was replaced with a narrower test of router/planner classification only (the serialization behavior itself was out-of-scope legacy functionality this build intentionally did not carry forward — `runtime_mapping` stays a declared-but-empty type, same as the other 9 unaudited types).

## Definition of Done checklist

1. **Tests pass** — yes (§7).
2. **Called from a real production entry point** — yes: `extension.ts` registers `RepositoryBrainProvider` in the canonical `RetrievalOrchestrator` (previously entirely absent there) and schedules real `RepositoryBrainOrchestrator.runFullRebuild()` calls; `mcpServer.ts` does the same plus a startup rebuild-if-never-run check. Guard test enforces this going forward.
3. **No orphaned imports** — yes: `repositoryBrainEvidenceStore.ts` deleted, all its call sites migrated.
4. **Scratch artifacts cleaned up** — yes (§8); this report itself documents the build rather than being left as a stray file.
5. **Relevant docs updated** — this report is the doc; no other doc claimed RepositoryBrain's implementation status needed updating beyond what `TARGET_ARCHITECTURE_RECOMMENDATION.md` §5 already flagged (re-checked in §6, not edited in place — that document is a point-in-time audit, not a living spec).
