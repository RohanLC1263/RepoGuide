# RepoGuide Roadmap

> For full project history and per-phase findings, see the maintained roadmap outside this repo
> (Cowork session) — this file tracks current focus only.

Tracks work at the level of "what's the current focus," not a full changelog — see git history and
the individual `*_REPORT.md`/`*_SEMANTIC_PROVIDER_REPORT.md` files for implementation detail.

## Where the project is now

- **Semantic/fact-extraction layer**: seven `SemanticProvider` implementations exist
  (TypeScript, Python, Java, C#, Go, Rust, C++), all shadow-mode — computed on every indexed file but
  not yet authoritative for any language's query answers. See `REPOGUIDE_AUDIT.md` §6 and each
  language's own `*_SEMANTIC_PROVIDER_REPORT.md` for tier breakdowns and real-corpus verification.
- **UX/information architecture**: Phase 5, done.
- **Release engineering**: Phase 6, done. See below.

## Phase 5 — UX Consolidation

**Goal**: reduce the "which of ~20 commands do I reach for" cognitive load flagged in
`REPOGUIDE_AUDIT.md` §5 (VISION.md principle 5, "reduce cognitive load"), without a full visual
redesign of any panel's actual content.

**Status: Done.** See `UX_CONSOLIDATION_REPORT.md` for full before/after verification (panel/command
inventory, design-system consolidation, the Orientation-panel-as-dashboard launcher, and
`tsc`/lint/jest results).

## Phase 6 — Release Engineering

**Goal**: the last phase before this can ship — CI, an automated `provenanceAccuracy` eval metric,
changelog discipline, Marketplace packaging readiness, and a security review of the real attack
surface (this tool indexes and reads arbitrary user codebases, and sends retrieved content to an LLM).

**Status: Done.** See `RELEASE_ENGINEERING_REPORT.md` for full before/after verification. Highlights:
- Fixed a severe, previously-undocumented packaging bug: `.vscodeignore` didn't exclude vendored eval
  corpora/archives/a stray dev venv -- confirmed via `vsce ls` that 87,630 files (multiple GB) would
  have shipped in the `.vsix` before the fix, 9,411 after.
- Fixed a path-traversal pattern repeated across 5 files (an LLM-echoed citation could, once clicked,
  open an arbitrary file outside the workspace) and added untrusted-content framing to every prompt
  that includes retrieved repository content.
- `.github/workflows/ci.yml` added (compile + lint + headless unit tests on push/PR).
- `provenanceAccuracy` is now a disclosed, verified heuristic (was previously hardcoded `null`).
- `CHANGELOG.md` has real content and a stated discipline going forward; `LICENSE`/`CONTRIBUTING.md`
  added; README's stale/inaccurate capability claims corrected.

**Still open, deliberately deferred (not silently dropped):**
- **AnswerGate blind spot: vague-but-wrong structural RELATION claims still pass the gate.**
  ("Agent A runs after B", "X delegates to Y" -- a claim about a symbol PAIR's relationship, not a
  claim about one symbol's value.) The VALUE half of this blind spot -- a specific, confident,
  wrong number for a named attribute/constant passing with zero diagnostics because the wrong
  number is also textually present somewhere in evidence (a stale docstring, a superseded
  comment) -- is now closed (2026-07-08): `AnswerGate` cross-checks a numeric claim named near a
  known symbol against that symbol's real `numeric_threshold` fact (AST-derived, parsed straight
  off the assignment's right-hand side -- a docstring's prose can never produce this fact type,
  since tree-sitter's assignment-node walk never descends into a string literal's own text), and
  blocks with a distinct diagnostic when they disagree, provided exactly one unambiguous real
  value is found nearby (2+ different symbols' facts matching nearby -> deliberately does not
  guess). Verified against the real case that surfaced it
  (`customization_interview_agent.py`'s live `self.confidence_threshold = 0.55` vs. the same
  file's stale docstring example of "0.70") via a real-data unit test (not synthetic -- the fact
  used is the literal row queried from CraftConnect's own `facts.db`).
  **Three real false positives found through live end-to-end testing during this same pass, two
  fixed, one disclosed as a deeper, separate problem rather than rushed:**
  1. *(fixed)* Matching on any ONE shared word let `self.confidence_threshold` collide with an
     unrelated frontend `confidence_score` state variable via the single shared word
     "confidence" -- now requires ALL of a symbol's distinctive word tokens present nearby, not
     just one.
  2. *(fixed)* A generic 4-character single-word symbol (`base`, a local variable inside an
     unrelated STT confidence-scoring heuristic in `stt_service.py`) matched an unrelated "4
     attempts... capped at 5" claim on no more than incidental proximity -- now requires a symbol
     to be either a multi-word compound or >= 8 characters standalone before it's trusted as a
     proximity anchor at all (`MIN_STANDALONE_SYMBOL_CHARS`).
  3. *(disclosed, not fixed this pass)* After both fixes, a third live rerun still mis-attributed:
     the model's own phrasing legitimately contained BOTH "confidence" and "score" near the
     claim, so `confidence_score` (a React `useState(0)` UI initializer, unrelated to the backend
     threshold) passed the tightened AND-match honestly -- and because the real
     `self.confidence_threshold` fact wasn't in this packet either (same retrieval-coverage gap
     as above), there was no second value to trip the ambiguity safety net. This is a different,
     deeper class than 1/2: not a proximity-window tuning problem, but `numeric_threshold` itself
     conflating "a real configurable threshold" with "any numeric literal in any assignment,
     including a UI framework's ephemeral state initializer" -- text-proximity matching alone
     cannot distinguish them. Stopped iterating reactively here rather than risk a fourth
     under-tested patch; concrete v2 directions, neither implemented: (a) scope candidate facts to
     files already established as relevant to the question (e.g. present in `packet.items`, not
     merely `packet.facts`), or (b) have `factExtractor.ts` tag a numeric fact as genuinely
     threshold-like only when the same variable is later used in a comparison expression, not for
     every bare assignment. Net effect even with this open: the check can now mis-attribute WHY it
     blocks, but blocking-for-a-wrong-reason still denies a wrong answer rather than silently
     passing one -- consistent with the tool's existing "disclose or refuse, don't guess" posture,
     just with a diagnostic message that isn't always trustworthy yet.
  Separately, a real, disclosed **retrieval-coverage limitation** (distinct from the above): the
  check only compares against facts already present in the built evidence packet -- if retrieval
  doesn't surface the relevant `numeric_threshold` fact for the specific symbol a claim is about
  (confirmed happening on the exact audit-03/04 questions across multiple live reruns: 32
  numeric_threshold facts in one packet, none for `confidence_threshold`), there's nothing to
  contradict against and the check silently doesn't fire. A natural v2 extension: a JIT
  `FactStore` lookup for symbols named near a number that aren't already in the packet, rather
  than being packet-bound like every other check -- not implemented here (would need threading a
  live store reference into `AnswerGate`, a bigger interface change than this pass's scope).
  The RELATION half remains open: a narrative claim like "agent A runs after B" contains no
  quote/fence/number/path, so nothing currently checks it. Found during the 2026-07-07
  decomposition hypothesis test: a single-shot answer claimed StoryGenerationAgent runs in the
  mission pipeline sequence (it does not -- `run_mission` builds its report with
  `story_text=None`) and passed the gate. Query decomposition narrows the *occurrence* side
  (focused per-facet evidence measurably reduced plausible-structure padding), but the
  *verification* side is untouched. Concrete follow-up direction: extract claimed relations
  ("A calls/uses/delegates-to/runs-after B") from answers and verify them against the program
  graph, which already stores real call/dependency edges (10k+ records on the dogfood corpus) --
  flag claims about symbol pairs that exist but have no supporting edge.
- **Fixed (2026-07-07): the reindex-atomicity generation swap silently broke the readiness/liveness
  gate for any workspace whose active generation was 1.** `repositoryReadiness.ts`'s `inspectLance`/
  `inspectBm25` pre-checked `fs.existsSync()` against a single hardcoded generation-0 path
  (`chunks.lance`, `bm25_index_segments`) *before* calling the store's own generation-aware
  `countRecords()` -- so the moment `commitRebuild()` (built earlier this session, see the
  atomicity-fix entry above) flipped a store onto its `_alt` generation, the check short-circuited
  to `FAILED`/0 records without ever asking the store itself. Found live: a routine post-rebuild
  `RepositoryLivenessGate` check on CraftConnect (real, working index, generation 1 active) reported
  `bm25: FAILED (0 records)` / `lance_chunks: FAILED (0 records)` / `LivenessGate status: corrupted`,
  while an independent `Bm25Store` instance against the same directory returned a real 2282-document
  count and working search results -- a self-inflicted regression from this session's own earlier
  atomicity work, not a query-pipeline problem. Fix: `inspectStore()` takes an optional
  `existsCheck` callback (default unchanged); `inspectLance`/`inspectBm25` pass one that checks
  *both* generation-0 and generation-1 paths (`LogicalUnitBm25Store` needed no change -- confirmed
  it never calls `beginRebuild()`/`commitRebuild()`, so it never leaves generation 0). Verified with
  a real induced-failure regression test (`repositoryLivenessGate.test.ts`): flips a temp Lance/BM25
  store onto generation 1 via the real `beginRebuild()`/`commitRebuild()` path, confirmed the test
  fails against the pre-fix code (`'FAILED' !== 'READY'`) and passes against the fix; re-verified
  live against CraftConnect's real, still-generation-1 index afterward (`READY` across all 10
  artifacts, `LivenessGate status: ok`, counts matching the independent probe exactly).
- **Fixed (2026-07-07): infra/deployment files (`Dockerfile`, `*.yaml`/`*.yml`, `.env*`, `Makefile`)
  were structurally unindexable.** `ALLOWED_EXTENSIONS` gained `.yaml`/`.yml`; new
  `ALLOWED_INFRA_BASENAMES`/`ALLOWED_INFRA_BASENAME_PREFIXES` cover the extension-less conventions;
  `detectLanguage()` gained a basename check ahead of the extension switch. Confirmed via a real
  CraftConnect reindex: manifest grew from 397 to 401 entries, including the real `Dockerfile` and
  `deployment/cloud_run_config.yaml` that previously had zero manifest entries no matter how good
  retrieval got. A follow-on fix (below) was needed before this was end-to-end verifiable.
- **Fixed (2026-07-07): `HybridRetrievalFusion` searched BM25 with the raw, full question text,
  structurally penalizing short, topically-precise files against long prose docs.** Found while
  verifying the infra-indexing fix above end-to-end: re-running the honest-negative audit question
  ("Does this codebase have Kubernetes deployment configuration...") still returned "evidence does
  not determine" even with the files indexed. Root-caused: `Bm25Store`'s tokenizer has no stopword
  handling and MiniSearch's `combineWith: 'OR'` sums a score contribution per matched token,
  including filler words ("does," "have," "way") -- confirmed directly (`Bm25Store.search()` against
  isolated queries like `"kubernetes deployment"` ranked `cloud_run_config.yaml` #1, but the same
  store searched with the real full question buried both infra files outside the top 50, because
  long prose docs like `README.md`/`PROJECT_TECHNICAL_DOCUMENTATION.md` incidentally contain more of
  the question's own filler words). **Design, deliberately additive rather than a replacement**
  (per explicit direction not to risk losing recall on already-working questions): `searchBm25()`
  keeps its existing raw-question pass completely unchanged -- every question's previously-obtained
  top-ranked BM25 hits keep the exact same identity and order -- and reuses `extractKeywords()`
  (already computed as `queryTerms` for symbol-index injection, just never threaded into BM25) for a
  second, keyword-only MiniSearch pass whose results are appended only if not already found by the
  primary pass. **Real before/after on the exact case**: the honest-negative question now returns
  "The codebase includes a Kubernetes deployment configuration in the file
  `deployment/cloud_run_config.yaml`... deploying CraftConnect backend services on Google Cloud Run
  using Knative," gate outcome `pass`, zero diagnostics -- log confirms the mechanism fired
  (`Keyword-only BM25 pass added 33 chunks the raw-question search missed`) and that the final fused
  evidence count was unchanged (5 chunks both before and after), meaning the fix genuinely displaced
  a less-relevant chunk rather than just adding noise. **Broader regression measured, not assumed**:
  re-ran the full 8-question capability-audit battery before/after (stashing the fix to get a clean
  baseline). 6 of 8 outcomes unchanged; `audit-06` improved (above); `audit-01` flipped from a
  *wrong-but-passing* answer (stale "0.70," should have been caught by this session's own numeric-
  contradiction check but wasn't, due to the already-disclosed retrieval-coverage gap) to a block on
  an unrelated fenced-code-block fabrication check -- net safer, not a regression, though not a
  direct fix of that coverage gap either. `audit-05` (a decomposed 4-part walkthrough) moved from a
  passing unified narrative to the graceful verified-sections fallback (3 parts covered, 1 correctly
  marked "Not covered") -- investigated rather than waved off: the merge step's own discarded
  generation attempt tripped `AnswerGate`'s numeric-contradiction check on a `min_words` fact
  (`app/llm_backends/mock_backend.py:155`, an unrelated mock-response padding variable). Confirmed
  via a real-data reproduction that this is a **pre-existing, separate gap** in that check's word-
  token filter, not something this fix introduced: `symbolProximityTokens()` drops tokens under 4
  characters, so `min_words` degenerates to a single surviving word ("words," `min` is filtered),
  weakening "require ALL of the symbol's words" down to "require the one generic word that
  survived" for any compound symbol whose other half is <4 characters. This retrieval fix didn't
  create that gap -- it just surfaced `min_words`'s fact into more contexts by (correctly) retrieving
  more real evidence -- and the delivered behavior even in that case stayed safe (an honest "Not
  covered" disclosure, never a wrong answer reaching the user). **Deliberately not fixed here**,
  out of scope for this retrieval-ranking pass and not requested; logged as its own follow-up below.
  4 new regression tests (`hybridRetrievalFusion.bm25Keyword.test.ts`): a chunk with zero raw-
  question vocabulary overlap is unreachable without the supplemental pass and reachable with it
  (confirmed as a real induced failure -- fails against the pre-fix code); the supplemental pass is
  provably additive-only (every raw-question hit keeps its exact identity and order); an empty
  `queryTerms` array is a no-op; a supplemental-pass failure doesn't affect the primary results.
- **New, disclosed (2026-07-07, found while regression-testing the fix above): `AnswerGate`'s
  numeric-contradiction check (see the AnswerGate blind-spot entry above) under-protects compound
  symbols whose word tokens include one shorter than 4 characters.** `symbolProximityTokens()`
  filters word tokens to `length >= 4` before requiring ALL of them present nearby; for a symbol
  like `min_words`, that drops `min` and leaves only `words` -- a single, extremely generic English
  word -- as the sole thing that must be "present nearby" to trigger a contradiction, functionally
  identical to the already-fixed "generic short symbol" false-positive class, just reached via a
  different route (a compound name degenerating to one generic surviving word, rather than a lone
  short symbol from the start). Confirmed reproducible with real data
  (`min_words`/95/`app/llm_backends/mock_backend.py:155`) against a synthetic markdown numbered-list
  answer mentioning "words" generically nearby. Not fixed this pass (out of scope; the task at hand
  was the BM25 retrieval-ranking fix, not another round on the contradiction check). Concrete
  follow-up direction: extend the existing `MIN_STANDALONE_SYMBOL_CHARS`-style specificity gate to
  also require at least 2 surviving (>= 4 char) word tokens for compound symbols, not just a
  non-empty list -- i.e. `specific` should be false, not true-via-fullPhrase-length, when a compound
  symbol's word-token filter leaves only one word standing.
- **Decomposition anchor cross-layer bug** (found 2026-07-07, capability audit): task-derived
  sub-question anchoring validates that a hint resolves to a real unit, but has no concept of
  "the same architectural layer as the rest of the question" -- on a full-stack question, the
  anchor pool locked onto frontend TypeScript symbols (`submitAnswer`, `retryAnswer`,
  `transitionState`) for a question actually about the backend Python interview flow, and every
  derived sub-question inherited that bias, producing an answer padded with React state-transition
  detail and hedged mentions of irrelevant agents. Never surfaced in prior backend-only
  decomposition testing (`mission_service.execute_mission`), since there was no frontend/backend
  ambiguity for anchoring to go wrong on. Not urgent -- fixable within the current design (a
  same-file/same-layer coherence check on the anchor candidate pool before committing to it), not
  filed as fixed here.
- **UX/cognitive load has not been touched since Phase 5.** Every fix from the retrieval-integrity
  and decomposition threads (reindex atomicity, the liveness gate, token budgeting, decomposition
  itself, the retry policy, this pass's contradiction check) is real and substantial, and
  essentially invisible in the UI: no badge or trace distinguishing a decomposed answer from
  single-shot, no visibility into retries, the `[PromptBudget]`/`[Decomposition]` telemetry that
  would make this new trust machinery legible only exists in the output channel log. Confirmed via
  `git log --oneline -- src/ui/ webviews/` since Phase 5's `UX_CONSOLIDATION_REPORT.md` commit: the
  only touch is this session's one-line decomposition progress label. Not addressed this pass --
  tracked here so it isn't silently forgotten, not because it's low-value.
- **RepositoryBrain is wired but ingestion-starved.** Confirmed live (2026-07-07): the
  `repository_brain` provider sits in the real `RetrievalOrchestrator` in both `extension.ts` and
  `mcpServer.ts`, and a real query against it executes -- but CraftConnect's actual
  `.repoguide/repository_brain.sqlite` has 0 rows in `repository_knowledge` right now. Not a query-
  pipeline problem; the upstream ingestion pipelines (git history beyond a handful of commits,
  ADRs, code review, coverage, incidents) simply haven't populated it for a real, single-developer
  test repo. This is finished, tested infrastructure sitting idle rather than compounding --
  needs ingestion sources connected or built, not query-side work.
- `package.json`'s `repository.url` and `publisher` remain explicit placeholders -- no real GitHub
  org/Marketplace publisher exists yet for this project. Replace before actual submission.
- No extension icon exists (needs a real design asset, not something generatable as part of this pass).
- The full jest suite has pre-existing, unrelated flaky failures (worker-process resource contention,
  plus several test files calling `process.exit()` directly on failure) that make it unsuitable as a
  hard CI gate today -- CI intentionally runs only `compile`/`lint`/`test:unit` until that's cleaned up.
- Ruby/PHP/Swift still have no tree-sitter grammar and fall back to fixed-window plain-text chunking.
- The `legacy` vs. `evidence` query pipeline split (`ARCHITECTURE_CONFORMANCE_REPORT.md` #1) is
  unresolved — `explainSelection` still silently falls back to legacy for some query types.
- Orphaned modules (`src/intent`, `src/evolution`, `src/drift`, `src/causal`→MCP chain,
  `src/orchestrator`, `src/incident` singular) still need a keep-or-delete decision.
