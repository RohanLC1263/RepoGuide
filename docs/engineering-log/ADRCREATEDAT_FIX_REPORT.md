# `adrs.created_at` Fix Report

Pass 2 implementation of the plan at `jaunty-churning-sky.md`, following up on `ADRCODELINK_WIRING_REPORT.md` §3/§4's finding that `ArchitecturalDrift` failed on `no such column: a.created_at`.

## 1. What was fixed

**`adrs.created_at` is now a real, persisted, versioned-migration column.** `ADRStore.initSchema()` adds a `migrateSchema()` step that creates (idempotent, `IF NOT EXISTS`) a `schema_meta` table shaped identically to `RepositoryBrainStore`'s — same key/value structure, same connection in production — and tracks `adrs_schema_version`. On version < 2, it runs `ALTER TABLE adrs ADD COLUMN created_at TEXT` (guarded by a `PRAGMA table_info` check, so it's safe to call on both fresh and pre-existing databases) and bumps the version. `ADRStore.mapRowToEntity()` now reads the column back into `ADREntity.createdAt`, so the interface's long-declared field is actually fulfilled end-to-end, not just persisted-and-unreadable.

**Real semantics, not a fabricated fallback**: `created_at` is populated via `runIngestionPipelines()` (both entry points), right after ADR sync — `UPDATE adrs SET created_at = (SELECT MIN(commits.timestamp) FROM commit_files JOIN commits ... WHERE commit_files.path = adrs.source_path)`. ADRs with no matching commit are left `NULL`, which `driftRuleEngine.ts`'s `julianday('now') - julianday(a.created_at) > 365` correctly treats as "can't assess staleness" (SQL `NULL > 365` is falsy) rather than crashing or reporting a fabricated date.

**A deeper wiring gap surfaced and was fixed per your approval**: `DriftBuilder(db)`/`KnowledgeHotspotBuilder(db)` were constructed without their companion `DriftStore(db)`/`KnowledgeHotspotStore(db)` — the classes that create `architectural_health`, `architectural_health_history`, `drift_entities`, `drift_findings`, `drift_evidence`, `drift_history`, `knowledge_hotspots`, `hotspot_evidence`, `hotspot_history`. Both are now constructed (side-effect only, matching `repositorySimulation.test.ts`'s original pattern) alongside the builders in both `extension.ts` and `mcpServer.ts`.

## 2. `driftRuleEngine.ts` re-audit — confirmed clean

Read all 6 rule methods end-to-end against every table's real schema (`adr_code_links`, `file_change_stats`, `intent_evidence`, `logical_coupling_edges`, `adrs`) — `adrs.created_at` was the only mismatch, now fixed. No other column-mismatch layer exists inside this file.

## 3. Verification results — this repo

```
adrs columns: id, number, title, status, context, decision, consequences, source_path,
              source_hash, repository_id, parser_confidence, raw_content, created_at   <- migrated

ArchitecturalDrift: no longer in the failed-step list (was failing before this fix)
architectural_health: 0 rows        (table now exists; 0 ADRs here, so no findings — correct, not a bug)
architectural_health_history: 0 rows
```

`ArchitecturalDrift` is now **fully unblocked** — confirmed by its absence from `failedAtStep` (which previously always included it). With 0 ADRs in this workspace it correctly produces 0 findings rather than erroring.

**The cascade resolved further, and 3 new/re-surfaced blockers were found one layer deeper** (confirmed by direct code reads, not guessed from error text):

| Step | New failure | Root cause | Status |
|---|---|---|---|
| `KnowledgeHotspots` | `no such table: intent_aware_impacts` | `knowledgeHotspotBuilder.ts:44` joins `intent_aware_impacts`, owned by `IntentAwareBlastRadiusStore` — the store backing the **optional** `runtimeBlastRadius` builder, explicitly scoped out of the original RepositoryBrain build ("I'll only wire the required 13... skip the 3 optional runtime ones"). Not a new gap — a known, already-documented scoping decision resurfacing now that its blocker upstream is cleared. |
| `DECISION_OUTCOMES` / `CAUSAL_REASONING` | `no such table: review_outcomes` | Confirmed 2 reports ago (`INGESTION_WIRING_REPORT.md`'s predecessor investigation): review-intelligence ingestion **does not exist anywhere in the codebase** — `ReviewIntelligenceStore.saveOutcome()` has exactly 2 callers, both test fixtures. Not new — the same already-documented "doesn't exist at all" gap, now the actual blocker instead of a hypothetical one. |
| `INCIDENT_EVENTS` | `no such column: curr.entity_id` | **New, precisely located**: `incidentBuilder.ts:141` (`processHotspotIncidents()`) does `FROM hotspot_history curr` and selects `curr.entity_id` — but `hotspot_history`'s real schema (`knowledgeHotspotStore.ts`) has `hotspot_id`, not `entity_id`. `processHealthIncidents()` in the same file correctly uses `architectural_health_history.entity_id` (a real column) — only the hotspot-history query has this bug. |
| `INCIDENT_INTELLIGENCE` | `no such column: h.entity_id` | Same root cause, same file family: `incidentIntelligenceBuilder.ts:63`/`77`/`195` all join `hotspot_history h ON h.entity_id = ...` — same `hotspot_id` vs `entity_id` mismatch. |

None of these are in scope for this pass (explicitly: `adrs.created_at` + the 2 missing stores it exposed). Named precisely here rather than glossed over, per the established pattern.

## 4. Verification results — real history (fresh copy of `eval_repos/axios`)

The prior scratchpad copy of `axios` was re-copied fresh (its `repository_brain.sqlite` reflected the pre-fix schema). Same safety discipline as last time: copy only, original never touched (confirmed after the run — `git status` clean, no `repository_brain.sqlite` in the original `.repoguide`).

```
commits: 2033, commit_files: 6119

ArchitecturalDrift: no longer failing
architectural_health: 1 row
architectural_health_history: 1 row
author_expertise: 3034   (unchanged, still real)
logical_coupling_edges: 1701   (unchanged, still real)
```

`ArchitecturalDrift` succeeds identically at scale — confirms the fix is data-independent, not a coincidence of this repo's specific state. Row counts are still sparse (1 row) because axios has 0 ADRs, so `DriftBuilder` correctly finds almost nothing to flag — this is the same "correct wiring, insufficient ADR data" story as `LogicalCouplingBuilder`'s original 0-rows-here-1701-rows-at-axios contrast, just for a different upstream input (ADRs, not commits).

The same 4 downstream blockers from §3 appear identically here — `intent_aware_impacts` missing, `review_outcomes` missing, `hotspot_history.entity_id` mismatch (both incident builders) — confirming they're data-independent bugs/gaps, not artifacts of either repo's specific state.

**`repository_knowledge` is still `{}` for all 3 core audited types, even against 2033 real commits:**

```
retrieve({type:'causal_explanation'}) -> 0 item(s)
retrieve({type:'decision_outcome'}) -> 0 item(s)
retrieve({type:'incident_pattern'}) -> 0 item(s)
```

## 5. Is Phase 2 (RepositoryBrain) complete?

**No — closer, with real progress, but still blocked. The blockers are now precisely named rather than vaguely cascading.**

**Confirmed fixed and verified this pass**: `adrs.created_at` persists real, correctly-derived data; `ArchitecturalDrift` runs end-to-end without erroring, against both a near-empty repo and 2033 real commits; the `DriftStore`/`KnowledgeHotspotStore` wiring gap (which would have silently blocked verification of the `created_at` fix itself) is closed.

**What's still blocking the 3 core audited types, named exactly**:
- `causal_explanation` / `decision_outcome`: blocked by `review_outcomes` not existing at all — this is not a wiring gap this session can close by construction (nothing to construct), it requires building review-outcome ingestion from nothing, already flagged out of scope when first discovered.
- `incident_pattern`: blocked by a genuine, newly-pinpointed column-name bug in `incidentBuilder.ts`/`incidentIntelligenceBuilder.ts` (`hotspot_history.entity_id` should be `hotspot_history.hotspot_id`, requiring a join through `knowledge_hotspots` to get the real `entity_id`, or a rename at the query site) — a different file and a different kind of bug than anything fixed so far, and squarely outside this pass's approved scope.

Also still open, unchanged: `TEST_COVERAGE`'s `adr_file_links` gap, `PredictionAccountabilityBuilder`'s `e.timestamp` bug, `KnowledgeHotspots`'s `intent_aware_impacts` gap (the optional runtime builder, deliberately unwired).

**Net assessment**: this pass closed the specific bug it targeted and the wiring gap that bug's fix exposed, verified both at scale against real data, and converted what was previously a single opaque cascade into 4 distinct, named, independently-addressable blockers — 2 already-documented scoping decisions resurfacing, 1 newly-found column-mismatch bug, 1 already-documented missing capability. None of the 3 core audited types produce output yet. The next concrete, scoped candidate is the `hotspot_history` column-mismatch fix in `incidentBuilder.ts`/`incidentIntelligenceBuilder.ts` — the only item in this list that's a genuine bug (not a deliberate scoping exclusion) and the only one that could plausibly unblock `incident_pattern` in a similarly small pass.

## Verification summary

- `npx tsc -p ./ --noEmit` and `npx eslint src --quiet`: clean.
- `adrIngestion.test.ts` + `commitIngestion.test.ts` (13 tests) + `repositoryBrainProductionWiring.test.ts` (6 tests): all pass unmodified, confirming the schema migration and store additions are backward-compatible.
- Full jest suite: 219 passed / 29 failed tests (44/80 suites) — consistent with prior sessions, no new regressions.
- Confirmed `eval_repos/axios` untouched.

## Definition of Done checklist

1. **Tests pass** — yes.
2. **Called from a real production entry point** — yes, in both `extension.ts` and `mcpServer.ts`.
3. **No orphaned imports** — yes.
4. **Scratch artifacts cleaned up** — yes; verification scripts and the axios copy live in the session scratchpad.
5. **Relevant docs updated** — this report is the doc; explicitly re-answers the "is Phase 2 complete" question with the newly-precise blocker list, per your Pass 2 instructions.
