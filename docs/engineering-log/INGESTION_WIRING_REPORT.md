# Ingestion Pipelines Wiring Report

Pass 2 implementation of the plan at `C:\Users\rohan\.claude\plans\jaunty-churning-sky.md`, following up on `REPOSITORYBRAIN_BUILD_REPORT.md` §3's finding that most upstream signal tables were missing in this workspace.

## 1. What was wired

**Commit history ingestion**: `CommitStore` (already accepts a shared `DatabaseSync`), `LocalGitCommitProvider`, and `CommitIngestionEngine` are now constructed in both `extension.ts` and `mcpServer.ts` alongside the existing 13 `BrainBuilders`, sharing the same `repositoryBrainDb` connection so `commits`/`commit_files` land in `.repoguide/repository_brain.sqlite` where `AuthorExpertiseBuilder`/`LogicalCouplingBuilder` already look for them. No changes needed to `commitIngestionEngine.ts`, `localGitCommitProvider.ts`, or `commitStore.ts` — reused as-is.

**ADR ingestion**: `ADRStore`'s constructor was widened from `constructor(dbPath: string = ':memory:')` to `constructor(dbPathOrDb: string | DatabaseSync = ':memory:')`, mirroring `CommitStore`'s existing signature exactly, so it shares `repositoryBrainDb` instead of opening a second physical connection to the same file. `ADRDiscoveryEngine`, `ADRParser`, and `ADRIngestionEngine` are constructed the same way as commit ingestion in both entry points. `commitIngestion.test.ts`/`adrIngestion.test.ts` (13 tests total) pass unmodified, confirming the constructor widening is backward-compatible.

**`architecture_decision` — 5th real `observe()` call site, as planned.** A `runIngestionPipelines()` function (duplicated in both entry points, matching the existing pattern of the 13 `BrainBuilders` block also being duplicated between them) runs commit sync, then ADR sync, then iterates every `ADREntity` in the store and calls `repositoryBrain.observe()` directly — no domain builder needed, since ADR data is a direct 1:1 mapping rather than an aggregation. Verified end-to-end (§3) with a synthetic 2-ADR fixture: both ADRs produced correctly-shaped `architecture_decision` records, with `ACCEPTED` mapping to confidence 90 and `SUPERSEDED` to confidence 30 exactly as designed.

**Coverage generation gap**: new `repoguide.enableCoverageIngestion` setting (boolean, default `false`) and `maybeGenerateCoverage()` in `extension.ts`. When enabled, checks `coverage/coverage-final.json`'s mtime and runs `npx jest --coverage` in the background (via the same `exec`+`promisify` pattern `LocalGitCommitProvider` already uses for `git log`) if the file is missing or >24h stale — fire-and-forget, doesn't block the brain rebuild it precedes. Off by default; verified by direct code inspection that the config check is the very first statement in the function, before any `fs`/`exec` call, so it's a true no-op when unset. Not added to `mcpServer.ts` — coverage generation is a VS Code–session-scoped background convenience, not something an MCP CLI invocation should trigger.

**Scheduling**: both ingestion pipelines and (opt-in) coverage generation now run as an explicit pre-step immediately before `RepositoryBrainOrchestrator.runFullRebuild()`, at both of `extension.ts`'s existing trigger points (~60s post-activation, and after every full reindex) and at `mcpServer.ts`'s startup-if-never-run check. The `BrainBuilders`/orchestrator 13-step contract itself is untouched — per your approved choice, ingestion is a pre-step, not 2 more orchestrator steps.

## 2. Upstream-table transparency check (real workspace, same format as the last report)

Ran the new pre-step against this repo's own `.repoguide/repository_brain.sqlite`:

```
Commit ingestion: 3 commit(s) synced.
ADR ingestion: 0 ADR(s) synced.

commits: 3
commit_files: 660
adrs: 0
```

`commits`/`commit_files` are now genuinely populated from this repo's real git history (this session's 3 commits, real SHAs, author, timestamps, 660 file changes across them — `git log --numstat --name-status` parsing confirmed correct). `adrs` stays empty because this repository has no `docs/adr`/`adrs`/`architecture/decisions` directory — the pipeline ran correctly and found nothing, exactly as flagged in Pass 1. This is a data-population fact about this specific workspace, not a wiring defect.

## 3. Do the previously-empty builders now produce real output?

Re-ran the full 13-builder orchestrator rebuild immediately after ingestion, against the same real workspace:

| Builder | Before this build | After this build |
|---|---|---|
| `LogicalCouplingBuilder` | Failed: `no such table: commit_files` | **Succeeds now** (table exists), but produces **0 rows** in `logical_coupling_edges` — co-change coupling requires multiple files changed together across enough commits to clear the builder's own significance threshold (`co_change_count > 5` is referenced elsewhere in the coupling-consuming code), and 3 commits from one session isn't enough real signal. Wiring confirmed correct; this is the same "no data yet" story as `ownership_expertise` was already flagged for in the previous report. |
| `AuthorExpertiseBuilder` | Failed: `no such table: commits` | **Still fails**, but for a *different, deeper* reason now: `no such table: adr_code_links`. This table is populated by a separate, also-unwired pipeline (`ADRCodeLinkBuilder`, `src/intent/linking/adrCodeLinkBuilder.ts`) that links ADRs to code nodes — not part of this plan's scope (the plan covered commit history, ADR content, and coverage; ADR-to-code linking is a distinct capability). Fixing the immediate blocker (missing `commits`) surfaced the next one, consistent with this whole audit's pattern of layered dependencies. Documented here, not fixed — out of scope for this task. |
| `ArchitecturalDrift` (`DriftBuilder`) | Failed: `no such table: adrs` | **Still fails**: `no such table: adr_code_links` — same missing dependency as `AuthorExpertiseBuilder` above. Not caused by the missing `adrs` table anymore (that's resolved — 0 rows, not a missing table), but by the next layer down. |
| `KnowledgeHotspots` | Failed: `no such table: architectural_health` | Still fails, same reason — cascades from `ArchitecturalDrift` not populating `architectural_health`. |
| `TEST_COVERAGE` | Failed: `no such table: adr_file_links` | Still fails — another ADR-code-linking dependent table, same root cause as `AuthorExpertiseBuilder`. |
| `DECISION_OUTCOMES`, `CAUSAL_REASONING`, `INCIDENT_EVENTS`, `INCIDENT_INTELLIGENCE` | Failed: `no such table: architectural_health_history` / `hotspot_history` | Still fail, cascading from the same root cause. |
| `PredictionAccountabilityBuilder` | `no such column: e.timestamp` | Unchanged — this is a pre-existing bug documented (not fixed) in the previous report; unrelated to ingestion. |

**Net result**: orchestrator failures went from 11/13 to 8/13 non-fatal steps. `commits`/`commit_files` are real. `LogicalCouplingBuilder` now runs to completion (0 rows, for lack of enough commit volume — expected). The remaining 8 failures all cascade from one shared root cause not covered by this plan's scope: `adr_code_links`/`adr_file_links` (populated by `ADRCodeLinkBuilder`, a third unwired pipeline, distinct from the ADR *content* ingestion this plan wired). Surfacing this is itself useful: it's the next concrete, scoped candidate for a follow-up wiring pass, named specifically rather than left as a vague "11 things are broken."

`repository_knowledge` counts after this rebuild: still `{}` for the 3 audited domain-builder types (`causal_explanation`/`decision_outcome`/`incident_pattern`) — unchanged from the previous report, since those builders' steps still fail for the `adr_code_links`-cascade reason above, not for anything this plan could fix. `architecture_decision` remains real and verified via the synthetic fixture (§4), just empty in *this* workspace because there are no ADR files to ingest here.

## 4. `architecture_decision` end-to-end verification (synthetic fixture)

This repo has no ADRs, so a temporary fixture workspace (2 ADR markdown files, one `ACCEPTED`, one `SUPERSEDED`, matching `adrIngestion.test.ts`'s existing format) was used to verify the full path:

```
ADR sync stats: {"adrsProcessed":2,"referencesProcessed":1,"durationMs":5}
Discovered 2 ADR(s):
- 0001-use-sqlite: "1. Use SQLite for local storage" status=ACCEPTED
- 0002-legacy-store: "2. Use flat JSON files for storage" status=SUPERSEDED

repository_knowledge counts by type: { "architecture_decision": 2 }
- lifecycle=candidate conf=90 :: 1. Use SQLite for local storage: We will use node:sqlite for all local persistence.
- lifecycle=candidate conf=30 :: 2. Use flat JSON files for storage: We used flat JSON files on disk.
```

Both ADRs produced correctly-shaped, correctly-scored `RepositoryKnowledge` records (`candidate` lifecycle, since nothing called `validate()`/`promote()` in this script — matching the frozen lifecycle). The `ADRParser`'s own status-detection (`superseded by [ADR 0005]` text → `SUPERSEDED`) and the status-to-confidence mapping both worked as designed.

## 5. Confirming no ungated path (your point 4, re-confirmed after implementation)

Re-grepped after implementation: `runIngestionPipelines()` and `maybeGenerateCoverage()` (the only new code added to `extension.ts`/`mcpServer.ts` for this task) call only `commitEngine.syncIncremental()`, `adrEngine.syncIncremental()`, `adrStore.list()`, `repositoryBrain.observe()`, and (for coverage) `child_process.exec`. None of these touch `QueryDispatcher`, `ExecutionPlanner`, `RetrievalOrchestrator`, `EvidencePacketBuilder`, or `AnswerGate`. Confirmed still a non-issue.

## 6. Verification summary

- `npx tsc -p ./ --noEmit`: clean.
- `npx eslint src --quiet`: clean.
- `commitIngestion.test.ts` + `adrIngestion.test.ts` (13 tests): pass unmodified.
- `repositoryBrainProductionWiring.test.ts` (6 tests): still passes — this task didn't touch the guard test's assertions and didn't need to (it checks `RepositoryBrainOrchestrator` construction/scheduling, which is unchanged in shape).
- Full jest suite: 219 passed / 29 failed tests, 44 passed / 36 failed suites — consistent with the previous session's numbers (214-219 passed, mid-30s failed suites, same known worker-crash flakiness and pre-existing unrelated failures already documented in `REPOSITORYBRAIN_BUILD_REPORT.md`). No new regressions.
- `repoguide.enableCoverageIngestion` defaults to `false` in `package.json`; `maybeGenerateCoverage()` returns before any side-effecting call when unset (confirmed by inspection — the guard is the function's first statement).

## Definition of Done checklist

1. **Tests pass** — yes (§6).
2. **Called from a real production entry point** — yes: both ingestion engines are constructed and scheduled in `extension.ts` and `mcpServer.ts`, ahead of the already-verified `RepositoryBrainOrchestrator.runFullRebuild()` call.
3. **No orphaned imports** — yes; no files were deleted or superseded this pass, all additions are used.
4. **Scratch artifacts cleaned up** — yes; the verification scripts and synthetic ADR fixture used for this report live in the session scratchpad, not in the repository.
5. **Relevant docs updated** — this report is the doc; `REPOSITORYBRAIN_BUILD_REPORT.md` is not edited in place (it's a point-in-time snapshot of that build), but this report explicitly supersedes its §3 findings for the tables covered here.
