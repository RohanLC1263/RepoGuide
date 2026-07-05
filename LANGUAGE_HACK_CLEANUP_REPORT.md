# Language-hack cleanup: axios/yarn special-casing in the call-graph pipeline

## Starting premise was wrong

`LANGUAGE-ARCHITECTURE.md` §4 named `callGraphValueFlow.ts` as injecting synthetic axios/yarn dynamic-dispatch edges. That file **does not exist anywhere in `src/`** — it was deleted before this repo's tracked git history begins (`src/comprehension/comprehensionEngine.ts:24`'s `// removed CallGraphValueFlowPass` marker; the file survives only as a stale, gitignored `out/comprehension/callGraphValueFlow.js` build artifact). The doc had been describing dead code for this repo's entire visible history. There was no live hack to remove in the call-graph pipeline itself.

## What was actually removed

**`src/indexing/logicalUnitExtractor.ts:58`** — a live, currently-wired hack found via the exhaustive grep (not the one originally named, but the same category of problem, confirmed in-scope with you): `lowerPath.includes('eval_repos/yarn/')` hardcoded into the general file-exclusion filter. Traced its real effect: **zero logical units existed anywhere in `eval_repos/yarn/.repoguide/`** — no `logical_unit_bm25_segments/` directory at all, because `LogicalUnitBm25Store.indexUnits([])` returns early without writing to disk. `normalizeRepoPath` doesn't relativize to any workspace root, so the substring match fired for every file under any `eval_repos/yarn/` path — the entire yarn corpus was blind to logical-unit-based retrieval (facts, logical-unit BM25 search), not just a few generated files.

**Replaced with a general heuristic**, not removed outright: added a size-based bundled-file check to `src/indexing/fileRoleClassifier.ts`'s `isGeneratedPath()` (`isBundledFile()`, threshold 500KB). Confirmed via direct measurement this is well-justified and repo-agnostic: yarn's checkout has 3 files that are 2.6–3.0MB single-file bundles (`.pnp.cjs`, `packages/berry-cli/bin/berry.js`, `packages/yarnpkg-cli/bin/yarn.js`) versus a 7.8KB largest genuine hand-written source file (`lib.ts`) in the same corpus — none of which any existing rule caught (they'd have classified `'script'`, not `'generated'`, since `bin/` matches `SCRIPT_COMPONENTS`). Verified with a standalone check against the real files: the 3 bundles now classify `'generated'` (0 logical units, as intended), `lib.ts` still classifies `'implementation'` (11 logical units, unaffected — no regression from this change).

**`LANGUAGE-ARCHITECTURE.md`** corrected: §4 now states plainly that `callGraphValueFlow.ts` is gone, its axios/yarn edge injection doesn't run, and dynamic-dispatch resolution in the call-graph pipeline is currently *unimplemented* — a disclosed gap, not a hackily-patched one. Also fixed two unrelated staleness bugs found in the same doc during this pass: §2 still described the pre-Phase-3 flat depth-sort 2000-file cap (now priority-ordered/configurable), and §7 cited `src/query/hybridQueryPipeline.ts`, which doesn't exist.

## What was deliberately *not* built

The axios (`knownAdapters` registry → adapter dispatch) and yarn (plugin-registry indirection) dynamic-dispatch problems the deleted hacks were patching are real and self-documented as such in `archive/diagnostics/KNOWN-GAPS.md`. A general, production-live TS-compiler-based resolver already exists (`relationshipResolver.ts`'s `handleCall()`, via `typeChecker.getResolvedSignature()`) but feeds the semantic/canonical-fact pipeline, not the call-graph/`FlowExtractor` pipeline these hacks patched — and `FlowContextBuilder`, the intended consumer of call-graph flow tracing, is defined but never constructed anywhere in `src/`. Building real dynamic-dispatch resolution into a not-yet-wired consumer would be a new orphaned-code case, not a cleanup. Left undone, disclosed here and in the doc.

## A more consequential bug, found while trying to get an honest "after" score

Getting a genuinely fresh `call_graph_v2.json` for the before/after comparison required calling `CallGraphBuilderV2.build()`. **Nothing in `src/` calls it.** `ComprehensionEngine` only ever calls `.load()` (read whatever's on disk); the write path has no production caller anywhere, not even in tests. Consequence, confirmed directly:
- **yarn**: `call_graph_v2.json` is frozen at a 2026-05-19 snapshot from a since-deleted pipeline version and will never refresh through any current `--prepare`/reindex workflow, however many times it's run. It still contains 334 edges tagged `resolutionRule: "dynamic_dispatch_inferred"` (not exclusively the 2 axios/yarn-hack-specific ones — this label was used more broadly by whatever older resolver produced this file, none of which exists in current `edgeResolver.ts` either).
- **axios**: `call_graph_v2.json`/`behavioral_paths.json` never existed in this workspace and still don't after a fresh `--prepare` run — `artifactAvailability.callGraphV2: false`.

This is out of scope to fix here (it's "wire up a missing regeneration trigger," a real feature gap, not a hack removal), but it's the dominant reason the "after" numbers below look the way they do, so it would be dishonest not to name it as the headline follow-up finding of this whole investigation.

## Before/after eval numbers (`eval:mini`, evidence mode, threshold 0.80)

### Yarn

| State | Overall score | Pass? |
|---|---|---|
| Original recorded baseline (logical units blind + hack-era/stale call graph, unmodified before this task) | **80.26%** | PASS |
| After removing the `logicalUnitExtractor.ts` blindness only (fresh full reindex; call graph still the same frozen 2026-05-19 snapshot) | **59%** | FAIL |
| After also stripping all 334 `dynamic_dispatch_inferred`-tagged edges from that frozen snapshot (best available approximation of "rebuilt today," since nothing currently produces that resolution category) | **55.26%** | FAIL |

Per your explicit instruction: this drop is not softened. But it needs the right attribution, confirmed by isolating the one deterministic, Ollama-independent signal available — `flowArtifactsContainExpectedPath()` (the pure JSON/static-analysis containment check `yarn-flow-3`'s score is partly built from) — run directly against both the original and the edge-filtered call graph:

```
BEFORE (335 dynamic_dispatch_inferred edges present): score 2, "Flow artifacts contained all 4 expected items."
AFTER  (334 edges filtered out):                       score 2, "Flow artifacts contained all 4 expected items."
```

**The hack's own target edges (`cli.ts:<top-level> → getPluginConfiguration`/`runExit`) were not actually load-bearing for this check.** Legitimate, unrelated edges resolved via normal `sameFile` analysis (`lib.ts:getCli → getPluginConfiguration.ts:getPluginConfiguration`, `lib.ts:runExit → runExit`/`getBaseCli`/`run`) independently satisfy the same loose containment test. The full-pipeline `yarn-flow-3` LLM-graded score did drop (grounding 2→1, flow 2→1) between the "before" and final "after" runs, but that's attributable to the LLM's generated answer text changing, not to the call-graph artifact — the artifact-containment component of that score was unchanged. **The real, large, and correctly in-scope driver of the 80%→~55-59% movement is the logical-unit-blindness fix**: exposing yarn's full corpus to LLM-graded evidence for the first time changed answer composition substantially. That fix is a genuine correctness improvement (yarn was previously invisible to logical-unit retrieval entirely), not a hack — but it's the reason the honest score is much lower than the hack-inflated one, more than the hack removal itself was.

### Axios

No prior recorded run existed in this workspace (`eval_repos/axios/.repoguide/` didn't exist before this task) — there is no "before" to diff against, only the golden-fixture evidence (`ax-flow-2` expects exactly the deleted hack's target files) tying it to the same pattern. First honest baseline, reported plainly:

| State | Overall score | Pass? |
|---|---|---|
| First-ever recorded run (fresh index + fresh eval, current codebase) | **38.16%** | FAIL |

`ax-flow-2` scored `flow: 0` (worst possible) — not because of the removed hack specifically, but because `callGraphV2`/`behavioralPaths` are entirely absent for axios (the orphaned-`build()` bug above), so there's no call-graph artifact of any kind, hack-laden or otherwise, for the flow check to inspect.

## Verification

- `npx tsc -p ./ --noEmit` clean, `npx eslint src --quiet` clean.
- Standalone classification check against real files confirmed the size-based heuristic fix works and doesn't regress real source extraction (see above).
- Full jest suite: 214/268 passed — matches this session's established baseline exactly, no regressions.
- Found and fixed one unrelated but blocking regression along the way: `src/preparation/repositoryPaths.ts`'s `bm25Index`/`logicalUnitBm25Index` paths still pointed at the pre-Phase-3 single-blob filenames (`bm25_index.json`/`logical_unit_bm25.json`); Phase 3's segmented-storage change stopped writing those files, so `repositoryReadiness.ts`'s readiness gate was unconditionally reporting `FAILED` (never even reaching its real, accurate `Bm25Store.getChunkCount()` check) for every repo indexed since that change shipped. Repointed both paths at the new `*_segments/` directories.

## Follow-ups (not done here, explicitly out of scope)

1. **Wire `CallGraphBuilderV2.build()` into a real production trigger** (a comprehension/prepare pipeline stage that calls it with fresh `FileStructure` data). This is the single most consequential fix available for improving flow-related eval scores on both corpora — bigger than anything the original hack removal could have delivered — but it's a feature-completion task, not a cleanup, and deserves its own investigate-first pass given this project's track record with orphaned wiring.
2. **General dynamic-dispatch resolution in the call-graph pipeline**, porting the pattern already proven in `relationshipResolver.ts`'s TS-compiler-based approach — worth doing only after (1), since there's currently no live consumer for the artifact it would improve.
