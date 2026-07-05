# Wiring `CallGraphBuilderV2.build()` into production

## What got wired

`ComprehensionEngine.runFullComprehension()` was a one-line stub (`{ this.workspaceRoot = workspaceRoot; }`) since this repo's baseline commit — every real builder call had been stripped out. Implemented it for real, for the two stages this pass scoped:

- **`static_analysis`**: walks the repo, calls `analyzeFileStructure()` per file (per-file try/catch — one bad file doesn't lose the rest), persists `file-structures.json`.
- **`call_graph_v1`**: calls `CallGraphBuilderV2.build(fileStructures, workspaceRoot)`, wrapped in a single try/catch (it has no internal resilience of its own — confirmed during investigation).

Both stages are bracketed with the existing `understandingManifest.ts` stage-tracking helpers (`markStageStarted`/`Complete`/`Failed`) and skip re-running when an `inputHash` of the file set matches what's already recorded as complete — so a repeat full index doesn't redo the work every time.

**Trigger**: `IndexManager.fullIndex()` already had a deferred, non-fatal trigger for this (`setTimeout(() => this.comprehensionJobRunner!.run(...).catch(...), 5000)`) — it just never fired because `comprehensionJobRunner` was never supplied. Fixed by constructing `ComprehensionJobRunner` in `extension.ts` and passing it as `IndexManager`'s already-existing 10th constructor argument. One two-line change activates a trigger that both `fullIndex()` and `forceFullReindex()` already shared (the latter calls the former), and never fires on incremental saves — no new scheduling logic was needed.

## The v1/v2 correction (confirmed before implementing, not assumed)

`CallGraphBuilderV2` — despite the name — reads/writes **`call_graph_v1.json`**, not `call_graph_v2.json`. Confirmed this is a real two-stage architecture, not a naming accident: `understandingManifest.ts` lists `'call_graph_v1'` and `'call_graph_gap_fill'` as distinct stages, and the (now-deleted) `CallGraphGapFiller`/`CallGraphValueFlowPass` was the thing that turned v1 into v2 by layering dynamic-dispatch-inferred edges on top.

**This wiring produces `call_graph_v1.json` and makes `ComprehensionEngine.getFlowExtractor()` return real data for the first time ever in production.** It does not produce `call_graph_v2.json` — that requires rebuilding the gap-fill pass, which remains explicitly out of scope (per `LANGUAGE_HACK_CLEANUP_REPORT.md`'s own sequencing: "general dynamic-dispatch resolution... worth doing only after [this wiring]"). `flowArtifactInspector.ts` (eval scoring) reads `call_graph_v2.json` specifically — so eval flow scores were not expected to move from this change, and they didn't (measured below, not assumed).

## A real bug found and fixed during verification

Standalone testing surfaced a genuine data-loss bug: when the `static_analysis` stage was skipped (already complete, unchanged), a freshly-constructed `ComprehensionEngine` instance never reloaded `this.fileStructures` from disk — it stayed empty. The `call_graph_v1` stage then computed its `inputHash` from that empty set, which didn't match the stored hash, so it did **not** skip — it called `build()` with an empty array, silently overwriting a good `call_graph_v1.json` with an empty one. Reproduced this exactly on axios/medusa during verification (confirmed via `getStats()` reporting real counts while the on-disk file showed `nodes: {}`, `edges: []`). Fixed by reloading `file-structures.json` from disk when the `static_analysis` stage is skipped, and by calling `callGraphBuilderV2.load()` when `call_graph_v1` is skipped (so `getFlowExtractor()` stays populated even when no rebuild happens on a fresh engine instance — relevant because `loadExisting()`'s own hydration is gated on `project.json`, which the not-yet-built `project_synthesis` stage never produces). Re-verified after the fix: a second run on a fresh instance correctly skips and leaves the on-disk graph unchanged (node/edge counts identical before and after).

## Explicit non-goals, confirmed unaffected

- `call_graph_v2.json` / dynamic-dispatch gap-fill: not produced.
- `FlowContextBuilder`: stays unconstructed (confirmed still fully separable — zero references anywhere in `src/` beyond its own file).
- The other 11 `UNDERSTANDING_STAGES` (lexical map, import graph, module understanding, concept map, behavioral paths, project synthesis, etc.): stay pending. Consequence, stated plainly: since not all `RUNNABLE_COMPREHENSION_STAGES` ever reach `'complete'`, `ComprehensionJobRunner.needsRepair()` always returns `true`, so the comprehension job re-attempts on every full index — bounded cost in practice, since the `inputHash` check still skips the two implemented stages specifically when the file set hasn't changed (confirmed: 95ms–2.7s for a no-op skip run, versus 2–7.5s for a real rebuild, see below).

## Verification

**Static**: `tsc --noEmit` and `eslint src` clean.

**Real-scale build, all three corpora** (via a standalone script calling `ComprehensionEngine.runFullComprehension()` directly, then confirming the same trigger wiring is what `miniEvalRunner.ts`'s `--prepare` path already exercises via `ComprehensionJobRunner`):

| Corpus | Files analyzed | Build time | Functions | Resolved edges | `getFlowExtractor()` |
|---|---|---|---|---|---|
| axios | 352 | 2.0s | 521 | 2,193 | non-null |
| yarn | 887 | 7.5s | 2,857 | 8,392 | non-null |
| medusa (scratchpad copy, 2000-file default budget applied) | 2,000 | 6.5s | 1,226 | 1,333 | non-null |

The `resolveContainerPattern` O(files × matching-calls) hot spot flagged as a risk in planning did not materialize as a real problem at this scale — medusa's 2,000-file build completed in 6.5s, no different in character from axios/yarn. Re-running on a fresh engine instance for all three confirmed the skip-if-unchanged path works and does not corrupt the on-disk graph (node/edge counts identical before and after a second run) — this is the fix described above, verified.

**Known minor gap, not blocking**: `runFullComprehension()` walks with the default 2,000-file budget (`walkFiles(workspaceRoot)`, no `maxFiles` argument) rather than reading `repoguide.maxIndexedFiles` the way `IndexManager.fullIndex()` does — `ComprehensionEngine` doesn't currently hold a `RepositoryContext` to read VS Code config from. For repos under the default cap (axios, yarn) this made no difference; for a repo with a raised budget, comprehension's file set could differ from the main index's. Noted as a follow-up, not fixed here.

**Eval scoring, before/after** (against `LANGUAGE_HACK_CLEANUP_REPORT.md`'s baselines):

| Corpus | Before (last report) | After this wiring | `artifactAvailability.callGraphV2` |
|---|---|---|---|
| yarn | 55.26% | 55% | `false` → `false` (see note) |
| axios | 38.16% | 38.16% (exact match, including every per-question flow score) | `false` → `false` |

**No material movement, exactly as predicted, measured not assumed.** `ax-flow-2`'s scores are byte-identical before and after (`grounding: 2, flow: 0` both times) — confirms `call_graph_v2.json`'s continued absence, not a coincidence.

**Self-disclosed mistake during verification**: an early cleanup step (`rm -rf .repoguide/understanding`, meant to reset the corrupted state from the bug above) accidentally deleted yarn's `call_graph_v2.json` and `behavioral_paths.json`, which had been carried over from the previous task's dynamic-dispatch-edge filtering work. The first re-score after that (47%) reflected v2 being fully absent, not just filtered, and isn't a clean comparison. Restored both files from scratchpad backups (the filtered v2, 6,818 edges, and the original `behavioral_paths.json`) before re-scoring — the 55% figure in the table above is from that restored, comparable state. Flagged here rather than quietly using the cleaner number without explanation.

**Full jest suite**: 214/268 passed, matching the established baseline exactly (one run showed 213/268; a repeat run confirmed 214/268, consistent with this session's known jest-worker-crash flakiness, not a regression from this change).

## Follow-ups (unchanged from `LANGUAGE_HACK_CLEANUP_REPORT.md`, still out of scope)

1. Rebuild the dynamic-dispatch gap-fill pass to actually produce `call_graph_v2.json` — the only thing that would move `ax-flow-2`/`yarn-flow-3`-style eval scores.
2. Wire `FlowContextBuilder` to `ComprehensionEngine.getFlowExtractor()` so the now-real `call_graph_v1` data has a live query-time consumer.
3. (New, minor) Give `ComprehensionEngine` access to `repoguide.maxIndexedFiles` so its file walk matches the main index's budget on repos where it's been raised.
