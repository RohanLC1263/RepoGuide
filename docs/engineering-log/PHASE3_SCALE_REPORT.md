# Phase 3: Scale and Durability

Fixes RepoGuide's four hard scale limits: the silent 2,000-file cap, sequential embedding, brute-force-only vector search, and full-blob BM25 rewrites on every save. Plan approved in `C:\Users\rohan\.claude\plans\jaunty-churning-sky.md` after two investigation passes (initial 3-agent codebase sweep, then two follow-up verification checks the user required before approval: LanceDB's un-indexed-delta search behavior, and confirming Ollama is the only embedding backend on the touched code path).

## 1. `fileWalker.ts` — priority-ordered walk, configurable budget, surfaced truncation

- `walkFiles()` now returns `{ filePaths, truncated, totalDiscovered }` instead of a bare array. Truncation only scores files (entry-point filename match → most-recent mtime → shallowest depth) when the discovered count actually exceeds the budget, avoiding a `stat()` per file in the common under-budget case.
- Budget is `repoguide.maxIndexedFiles` (default 2000, unchanged — the fix is that truncation is now smart and visible, not a bigger default).
- Truncation is persisted into `meta.json` (`IndexMeta.truncated`/`totalDiscovered`, written by `IndexManager`) and surfaced as a real gap string via `EvidencePacketBuilder.getTruncationGap()`, consumed by `AnswerGate` like any other evidence gap. The bare `console.warn` is gone.
- **Deviation from the plan's design note**: the plan considered using `CommitStore` for "recently changed" on rebuilds. Investigation found commit ingestion runs ~60s after activation, strictly after the first index build, and `CommitStore` has no "all files by most-recent-change" aggregate query. Implemented filesystem `mtime` uniformly instead (works identically for first-index and rebuilds, zero new coupling) — a correct superset of the old depth-only heuristic. CommitStore-based recency remains a valid future refinement, not implemented here.

## 2. `indexManager.ts` — bounded worker-pool concurrency

- `fullIndex()`'s per-file loop is now a pull-based worker pool (same pattern as the already-production `FileAnnotationEngine.annotateFiles()`), concurrency `min(os.cpus().length, 4)` by default, configurable via `repoguide.indexingConcurrency`.
- Hardened `getAdrIngester()`'s lazy-init (was a plain `if (this.adrIngester) return...` — a real race under concurrency where multiple workers could each construct their own instance) to memoize the in-flight promise instead of the resolved value.
- **Deviation from the plan**: `reindexChanged()`'s "which files changed" scan phase is now parallelized (pure read-plus-per-key-manifest-refresh, safe), but `incrementalUpdate()` itself stays sequential. It toggles a single shared `isIndexing` boolean as a reentrancy guard against file-watcher-triggered updates firing mid-sweep — running it concurrently would race that flag. Discovered during implementation, not in the original plan; parallelizing it safely would mean removing the flag-based guard entirely, which is out of scope here.

## 3. `lanceStore.ts` — real ANN index + bounded-memory scanning

- `insertChunks()` now builds a real IVF_PQ index (`table.createIndex({ type: 'ivf_pq', column: 'vector', metric_type: Cosine })`) once the table crosses 10,000 rows, and rebuilds when the un-indexed delta exceeds 20% of the indexed set. Rebuild state persists in `ann_index_state.json` next to the LanceDB directory.
- Confirmed via direct read of `vectordb`'s `dist/query.js` (`_fastSearch` defaults `false`) that un-indexed delta rows are automatically merged into every vector search — never call `.fastSearch(true)`, or that guarantee breaks.
- `getAllChunks()`/`getAllFilePaths()` now scan in 1,000-row pages via a persisted `seq` cursor column instead of one `.limit(count + N)` round trip, bounding the transient/Arrow-deserialization memory of the fetch itself.
- **Known limitation, stated plainly**: the *returned* array is still the full result set (every one of the 10+ call sites expects "all chunks" back, and changing that is a much larger refactor than this pass). Pagination bounds the fetch, not the held result. `vectordb 0.21.2` also has no `.offset()`, so pagination uses a `seq` range filter instead — tables written before this change lack that column and fall back to the old unpaginated single-load path until their next full reindex (correct, just not memory-bounded until then).

## 4. `bm25Store.ts` / `logicalUnitBm25Store.ts` — Lucene-style sealed segments

- New shared `SegmentedMiniSearchIndex` (`src/store/segmentedMiniSearchIndex.ts`): writes go to a small active segment (sealed at 500 docs), sealed segments are immutable, deletes are tombstones checked at query/count time. A pre-existing single-blob index file becomes the first sealed segment on first load — no forced reindex for existing users.
- A real bug was caught and fixed during verification: re-inserting a previously-deleted id (e.g. identical content reappearing at the same file/line) left it permanently invisible, because the tombstone was never cleared. Fixed by clearing the tombstone on re-insert, and search now dedupes by id (keeping the highest score) in case a stale physical copy still lives in an older sealed segment.
- **Deviation from the plan: compaction was dropped.** MiniSearch has no safe way to enumerate a loaded segment's original documents unless every indexed field is also a stored field — true for `Bm25Store` but not `LogicalUnitBm25Store` (`content` is indexed but not stored), so a generic merge routine can't be built correctly for both. Segment count and the tombstone set now grow unboundedly over a long-lived repo; a full reindex (`clearAll()`) is the reset point. This is a real, disclosed gap, not silently dropped — verified by direct check of `MiniSearch`'s `.d.ts` (`getStoredFields` exists, no document/id enumeration does) before deciding, not assumed.
- Residual cosmetic effect of the same limitation: `getChunkCount()` can overcount by 1 per id that was deleted-then-reidentically-reinserted while its stale copy still lives in a sealed segment (search results are deduped; the count isn't). Rare in practice (chunk ids are content-hash-derived, so only identical re-inserted content triggers it) and diagnostic-only.

## Settings added

- `repoguide.maxIndexedFiles` (default 2000)
- `repoguide.indexingConcurrency` (default 0 = auto)

## Verification

**Static**: `tsc --noEmit` and `eslint src` clean after every change. Full jest suite: 214/268 passed, 34 failed — matches this session's established flaky baseline (202–219 passed across identical code all session, pre-existing jest-worker-crash flakiness). The one touched-file failure (`evidencePacketBuilder.test.ts`, `factStore.findByType is not a function`) was confirmed pre-existing via `git stash` against the unmodified baseline before concluding it wasn't a regression.

**Real-scale** (`eval_repos/medusa` copied to scratchpad, 10,609 real indexable files after ignore-pattern filtering — `axios` at 355 and `yarn` at 1,033 files were both under the old cap and unusable for this test):

| Subsystem | Before | After |
|---|---|---|
| File walk (default budget) | Hard cap 2000, depth-sort only, silent | `totalDiscovered=10609`, kept 2000, prioritized (1796 entry-point-named files retained), **truncation surfaced as a gap** |
| File walk (raised budget) | Not possible — hardcoded | `repoguide.maxIndexedFiles=5000` → kept 5000 of 10609, proving the old cap is no longer a hard ceiling |
| Embedding (60 real medusa files, real Ollama calls, warmed-up model) | Sequential: 1180ms (20ms/embedding) | Pooled, concurrency=4: 354ms (6ms/embedding) — **3.33x** |
| LanceDB search after ANN index built | N/A (no index existed) | IVF_PQ index built automatically at the 10,000-row threshold; a chunk inserted *after* the index build is still returned by both `getAllChunks()` and `queryByVector()` with its own vector — confirmed no search blind spot |
| LanceDB full-table fetch (12,000 chunks, 768-dim vectors) | One unbounded `.execute()` | Paged in 1,000-row batches; fetch took 450ms, RSS delta ~187MB for the 12k-row/768-dim result (expected — vector payload size, not fetch-mechanism overhead; see limitation above) |
| BM25 single-chunk incremental save (corpus at 12,000+ docs) | Full-corpus JSON re-serialization every save (would scale with total corpus size) | 20 successive single-chunk saves: 5ms total, 0.25ms/save, each touching only a ~0.2KB active segment — independent of the 12,000-doc corpus size. 24 sealed segments created automatically at the 500-doc threshold. |

An earlier run of the concurrency benchmark showed a 35x speedup; investigated and found it was an Ollama model cold-start artifact (first HTTP call pays a one-time model-load cost), not a fair measurement — fixed by adding an explicit warm-up call before timing either loop. Reported number above (3.33x) is the corrected, fair comparison.

## Scope not touched

Full end-to-end `IndexManager.fullIndex()` was not run against all 10,609 real medusa files (would mean embedding tens of thousands of real chunks through local Ollama — multi-hour, impractical for this pass). Instead each changed subsystem was exercised directly, at real or matching scale, against real medusa file/text data where the test needed real content (file walk, embedding latency) and synthetic vectors/chunks at real row counts where only structural behavior mattered (LanceDB ANN indexing, BM25 segmenting) — the actual shipped code paths, not mocks, via the compiled `out/` modules.
