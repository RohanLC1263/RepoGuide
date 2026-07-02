# RepoGuide Canonical Repository Preparation

RepoGuide prepares repository intelligence through one canonical workflow:

1. Build logical units.
2. Extract facts from logical units.
3. Build symbols.
4. Build vector chunks in Lance.
5. Build BM25 chunk search.
6. Build logical-unit BM25 search.
7. Build the program graph.
8. Write the index manifest and repository metadata.
9. Run comprehension artifact generation when the caller requests it.
10. Write `.repoguide/repository_readiness.json`.

All runtimes must use the same artifact locations under `.repoguide`:

- Lance: `.repoguide/chunks.lance`
- BM25: `.repoguide/bm25_index.json`
- Logical-unit BM25: `.repoguide/logical_unit_bm25.json`
- Logical units: `.repoguide/logical_units.db`
- Facts: `.repoguide/facts.db`
- Symbols: `.repoguide/symbols.json`
- Program graph: `.repoguide/graph/graph.json`
- Index manifest: `.repoguide/manifest.json`
- Repository readiness: `.repoguide/repository_readiness.json`
- RepositoryBrain: `.repoguide/repository_brain.sqlite`
- Comprehension artifacts: `.repoguide/understanding/`

The canonical implementation lives in `src/preparation/repositoryPreparation.ts`.
Readiness reporting lives in `src/preparation/repositoryReadiness.ts`.

Evaluation must not run silently against empty stores. `npm run eval:mini -- --prepare`
rebuilds the canonical artifacts before evaluation. Without `--prepare`, evaluation
validates `.repoguide/repository_readiness.json` inputs and fails with artifact-level
diagnostics if required stores are missing or empty.

Provider readiness is reported as:

- `READY`: backing artifacts exist and are populated.
- `PARTIAL`: some backing artifacts are present but the provider is not fully ready.
- `EMPTY`: backing artifacts exist but contain no usable records.
- `FAILED`: backing artifacts are missing or failed to load.
