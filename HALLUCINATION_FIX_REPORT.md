# Hallucination Fix Report — Per-Citation Content Verification

Implements the two-part fix designed in the Pass 1 investigation (`HALLUCINATION_INVESTIGATION_REPORT.md`) for the two confirmed fabrications found during manual CraftConnect testing.

## What changed

### 1. `src/ui/hallucinationGuard.ts` — deleted

Confirmed fully dead code (zero call sites anywhere in `src/`, before this change). Deleted outright rather than repurposed — its two functions operated on `LocationData`/`NavigationTarget` (UI navigation-click structures), a different shape from `EvidencePacket`/`EvidenceItem`, so there was no real logic worth salvaging into the new check. Updated the one remaining reference to it (a comment in `src/evaluation/scorers.ts:220`) to point at `AnswerGate` instead, since that's the real, wired mechanism.

### 2. `src/query/answerGate.ts` — per-citation content verification (extends check #3)

For quotes that already pass the existing "does this text appear somewhere in evidence" test, and are long enough to read as a real code excerpt (≥20 chars, not a short phrase), a new step:
- Finds the file path mentioned nearest the quote in the answer's prose (checks before the quote first, then after — `"file.py: \`...quote...\`"` is the common shape).
- Resolves that claimed file to an absolute path (directly if the evidence path is already absolute; via a new optional `workspaceRoot` parameter on `verify()` if not).
- Re-reads that file **fresh from disk** — not from the evidence packet's in-memory content, since that's a token-budget-trimmed subset and checking against it wouldn't catch a case where the disambiguating chunk got trimmed before generation.
- If the quote is real text (from evidence) but doesn't appear in the specific file it's attributed to, blocks with a distinct diagnostic (`"Quoted code attributed to X does not appear in that file's real content -- likely misattributed from a different cited file"`), separate from the pre-existing "unsupported quote" diagnostic so the two failure modes stay distinguishable in logs.

Reuses the existing `block` outcome — no new outcome tier, matching the severity already given to unsupported quotes, and respects the existing `skipStrictBlocking`/gap-phrase exemption so an already-hedging answer isn't punished further.

### 3. `src/query/answerGate.ts` — comparative-claim check (new check #6)

Independent of the quote logic (a different failure shape — a false equivalence claim, not a misattributed quote). Scans for equivalence phrasing (`identical`, `same code`, `no functional difference`, `no difference`, `equivalent`, `duplicate of`, `exactly the same`) in any sentence that also names 2+ files actually present in the evidence set. When found, re-reads all named files fresh from disk and normalizes line endings/trailing whitespace; if they're not equal, blocks with a diagnostic naming the files and stating their real content differs. Kept deliberately simple for v1 — exact-content comparison after normalization, not a fuzzy similarity threshold, since the case that motivated this (52 lines vs. 624 lines) was never a close call.

### 4. `src/query/queryDispatcher.ts` — threaded `workspaceRoot` through

All 4 production call sites (`this.answerGate.verify(...)`, covering the main evidence query and both `explainSelection` variants) now pass `this.context.workspaceRoot` as the new 4th argument, so the real chat path gets the full attribution/equivalence checks, not just the degraded fallback.

## Test suite

`src/test/answerGate.contentVerification.test.ts` — 9 tests, all passing:
- Blocks the orchestrator misattribution shape (synthetic packet, real fixture disk reads).
- Passes a correctly-attributed quote (false-positive guard).
- Blocks the story-agent false-equivalence shape.
- Does not flag a legitimate claim of *difference* as false equivalence (false-positive guard).
- Degrades gracefully with no `workspaceRoot` (relative evidence paths, can't resolve to disk — falls back to the pre-existing weaker check rather than throwing).
- Works directly off absolute evidence paths with no `workspaceRoot` needed.
- Two tests confirming the real fixture files are genuinely different (sanity-checking the fixtures themselves, not just the gate).
- One test running the gate against **real fixture file content** (not just a synthetic string) with a quote extracted directly from the real `mission_orchestrator.py`'s actual `__init__` signature, misattributed to `orchestrator_agent.py` — confirms the mechanism against real-world code shape, not just a clean synthetic string.

`src/test/fixtures/craftconnect-hallucination-repro/` — the actual 4 files byte-copied from the real CraftConnect folder (`orchestrator_agent.py`, `mission_orchestrator.py`, `story_gen_agent.py`, `story_generation_agent.py`), not paraphrased recreations, per the requirement that synthetic fixtures alone wouldn't have caught this originally.

## Verification results

- **Compile**: clean.
- **Lint**: 0 errors; 1 new warning in `answerGate.ts` (a curly-brace style nit, consistent with ~964 pre-existing warnings of the same kind already tolerated across this codebase — not a new class of issue).
- **Targeted tests**: all 9 new tests pass. The two other tests that exercise `queryDispatcher`/`answerGate`-adjacent code (`evidencePacketBuilder.test.ts`, `investigationUI.test.ts`) still fail for their pre-existing, unrelated reasons (a stale mock missing `findByType`, and a mocha-only `suite()` global used in a file jest also picks up) — confirmed present before this change too, not introduced by it.
- **Full suite**: baseline was 288 passed / 34 failed / 20 skipped (342 total). Parallel full-suite reruns after the change are noisy (34→45→49 failed across three consecutive runs with no code changes between them) due to pre-existing native-module worker crashes (`"Jest worker encountered 4 child process exceptions"`) — this instability exists independent of this change; a `--runInBand` rerun was aborted by an unrelated pre-existing test that calls `process.exit(1)` directly (`runtimeBlastRadiusPhaseD.test.ts`). Cross-checked the full list of failing suites from a parallel run against the files this change touches (`src/query/answerGate.ts`, `src/query/queryDispatcher.ts`, `src/evaluation/scorers.ts`) — **none of the failing suites are in those files or their direct test coverage.** The reliable signal here is the targeted run, which is clean.
- **Live re-verification**: reran `hallucinationInvestigation.ts` against the real external CraftConnect folder, 3 attempts per question. All 6 answers remain correct and honest, matching the pre-fix reproduction — the fix introduces no new false-positive blocking on the two original questions. Since the original fabrication never reproduced live (confirmed in the investigation pass), this run can't show a live "catch," but that's expected and consistent — the unit tests against the real fixture files are what directly prove the mechanism catches the failure shape when it recurs.

## Scope caveat (as required)

**This fix only protects query paths that route through `AnswerGate.verify()` with a `workspaceRoot` supplied.** Concretely:

- **Protected**: `queryDispatcher.ts`'s main evidence query and both `explainSelection` code paths (the ones a real chat session and the harness both exercise) — all 4 call sites updated.
- **Not protected, confirmed by direct check**: `src/query/investigationEngine.ts` (2 `answerGate.verify()` call sites) and `src/query/planAnalyzer.ts` (1 call site) each construct their own `AnswerGate` instance and call `.verify()` without a `workspaceRoot` argument. These are real, separate features (investigation/plan-analysis), not test scaffolding. Both new checks degrade gracefully there today (no `workspaceRoot` → checks skip rather than throw), meaning those paths get zero benefit from this fix as it stands — not because they're broken, but because they were out of scope for this pass.
- As you flagged: the legacy pipeline's separately-tracked `explainSelection` gap is unaffected by this change either way — this fix only touches the evidence-based `AnswerGate` path, not whatever that legacy pipeline does instead.

If `investigationEngine.ts`/`planAnalyzer.ts` should get the same protection, that's a small, mechanical follow-up (thread `workspaceRoot` through their own `AnswerGate` construction the same way `queryDispatcher.ts` now does) — not filed as done here since it wasn't in this pass's approved scope.
