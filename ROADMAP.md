# RepoGuide Roadmap

> For full project history and per-phase findings, see the maintained roadmap outside this repo
> (Cowork session) — this file tracks current focus only.

Tracks work at the level of "what's the current focus," not a full changelog — see git history and
the individual `docs/engineering-log/*_REPORT.md`/`docs/engineering-log/*_SEMANTIC_PROVIDER_REPORT.md` files for implementation detail.

> **Long-term direction & phasing:** the strategy and Phase 0–4 sequencing behind the current focus
> live in [`docs/engineering-log/RepoGuide_LongTerm_Vision_and_Phasing.md`](docs/engineering-log/RepoGuide_LongTerm_Vision_and_Phasing.md)
> (an elaboration of `VISION.md` Principle 7, "Trust through evidence, not confidence").

## Where the project is now

- **Semantic/fact-extraction layer**: seven `SemanticProvider` implementations exist
  (TypeScript, Python, Java, C#, Go, Rust, C++), all shadow-mode — computed on every indexed file but
  not yet authoritative for any language's query answers. See `docs/engineering-log/REPOGUIDE_AUDIT.md` §6 and each
  language's own `docs/engineering-log/*_SEMANTIC_PROVIDER_REPORT.md` for tier breakdowns and real-corpus verification.
- **UX/information architecture**: Phase 5, done.
- **Release engineering**: Phase 6, done. See below.

## Phase 5 — UX Consolidation

**Goal**: reduce the "which of ~20 commands do I reach for" cognitive load flagged in
`docs/engineering-log/REPOGUIDE_AUDIT.md` §5 (VISION.md principle 5, "reduce cognitive load"), without a full visual
redesign of any panel's actual content.

**Status: Done.** See `docs/engineering-log/UX_CONSOLIDATION_REPORT.md` for full before/after verification (panel/command
inventory, design-system consolidation, the Orientation-panel-as-dashboard launcher, and
`tsc`/lint/jest results).

## Phase 6 — Release Engineering

**Goal**: the last phase before this can ship — CI, an automated `provenanceAccuracy` eval metric,
changelog discipline, Marketplace packaging readiness, and a security review of the real attack
surface (this tool indexes and reads arbitrary user codebases, and sends retrieved content to an LLM).

**Status: Done.** See `docs/engineering-log/RELEASE_ENGINEERING_REPORT.md` for full before/after verification. Highlights:
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
  **Three real false positives found through live end-to-end testing, all now fixed (the third,
  "useState-collision v2," was deliberately disclosed rather than rushed when first found, then
  fixed properly in a dedicated follow-up pass once its root cause was fully understood):**
  1. *(fixed)* Matching on any ONE shared word let `self.confidence_threshold` collide with an
     unrelated frontend `confidence_score` state variable via the single shared word
     "confidence" -- now requires ALL of a symbol's distinctive word tokens present nearby, not
     just one.
  2. *(fixed)* A generic 4-character single-word symbol (`base`, a local variable inside an
     unrelated STT confidence-scoring heuristic in `stt_service.py`) matched an unrelated "4
     attempts... capped at 5" claim on no more than incidental proximity -- now requires a symbol
     to be either a multi-word compound or >= 8 characters standalone before it's trusted as a
     proximity anchor at all (`MIN_STANDALONE_SYMBOL_CHARS`).
  3. *(fixed 2026-07-08, "useState-collision v2")* After both fixes, a third live rerun still
     mis-attributed: the model's own phrasing legitimately contained BOTH "confidence" and "score"
     near the claim, so `confidence_score` (traced to the real source: a fallback `MissionReport`
     object built inline and passed to `setMissionReport({..., confidence_score: 0, ...})` in
     `StudioContext.tsx` -- a UI placeholder value, not a real configurable threshold) passed the
     tightened AND-match honestly -- and because the real `self.confidence_threshold` fact wasn't in
     this packet either (same retrieval-coverage gap as above), there was no second value to trip the
     ambiguity safety net. Root cause was `numeric_threshold` itself conflating "a real configurable
     threshold" with "any numeric literal in any assignment, including a UI framework's ephemeral
     state field" -- text-proximity matching alone can't distinguish them, so the fix moved to the
     source: `factExtractor.ts`'s `emitValueFacts()` now walks a numeric literal's AST ancestors
     (bounded to real containment -- object/pair/array/arguments/call_expression nesting only, never
     wandering into an unrelated statement) and skips `numeric_threshold` (only that fact type; other
     fact types like `assignment`/`constant` are unaffected) when the value sits inside an argument of
     a React-hook-shaped (`use[A-Z]...`) or React-setter-shaped (`set[A-Z]...`) call, TS/JS only.
     Verified with real induced-failure tests reproducing both the exact `setMissionReport({...,
     confidence_score: 0, ...})` shape and a direct `useState({ confidence_score: 0.5 })` object
     initializer (confirmed failing against the pre-fix code, passing after), plus a control
     confirming a real module-level constant in the *same file* is completely unaffected.
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
- **Fixed (2026-07-08): the numeric-contradiction check read markdown ordered-list markers ("1. ",
  "2. ", "3. ") as bare numeric claims, causing a severe over-blocking regression** -- found via a
  fresh 15-question real-world eval against CraftConnect (4/14 correct, 8/14 hard abstentions).
  The gap messages almost all followed the shape "Numeric claim 1 contradicts...", "Numeric claim 2
  contradicts...", "Numeric claim 3 contradicts...", each attributed to a fact in a file often
  unrelated to the question's actual topic. Root-caused live: `numberRegex`
  (`/\b\d+(\.\d+)?\b/g`) has no awareness of markdown syntax, so a merge-step answer's own numbered
  list ("1. **submitAnswer**: ...", "2. **apiFetch**: ...") was read as bare numeric claims "1",
  "2", "3", each checked against whatever `numeric_threshold` fact happened to be textually
  proximate, regardless of relevance -- confirmed with a minimal, fully deterministic reproduction
  (a 3-item numbered list with bolded method names, one unrelated fact, all three list markers
  blocked in sequence). This is the dominant driver of the over-blocking, since numbered lists are
  a very common LLM formatting convention for exactly the walkthrough/multi-step questions this
  check is most likely to see. Fix: `isListMarkerContext()` (mirrors the existing
  `isLineNumberContext()` pattern) excludes a digit occurrence from every occurrence-based check
  (line-span tolerance, template-placeholder matching, and the contradiction check) when it's
  immediately followed by `[.)]\s` (the ordered-list punctuation) AND is the first non-whitespace
  content on its line -- so `"1. **X**"` is excluded but `"reduce retries to 1. This fixes..."` is
  not, since the digit there isn't line-initial. Filtered per-occurrence, not per number value
  (the same digit can be a genuine claim elsewhere in the same answer); when *every* occurrence of a
  number is a list marker, that number is skipped entirely rather than falling through to
  `supportedByContent`'s occurrence-independent substring check, which exists for real claims, not
  formatting artifacts. Verified with a real induced-failure test (the exact minimal reproduction
  above: confirmed blocking on pre-fix code, passing after) plus two controls: a genuine claim that
  starts a line but isn't followed by `.`/`)` + whitespace is still checked normally, and a real
  wrong number *inside* a list item's text (not the marker itself) is still caught.
  **Separately confirmed, NOT a code gap**: the same eval's citations of `confidence_score`
  (`StudioContext.tsx:382`, inside `setMissionReport({...})`) and `answered`/`current`/`total`
  (`InterviewPage.tsx`, inside `useState<InterviewStateData>({...})`) as contradiction sources were
  traced to a stale `facts.db` (last rebuilt before the `1718d39f` useState-collision fix landed) --
  directly re-running `extractFacts()` against the real, current file content with current code
  produces zero `numeric_threshold` facts for any of them, including the generic-typed
  `useState<T>(...)` case. Resolved by reindexing, not a code change.
  **Also investigated, confirmed real but deliberately deferred (unchanged from the disclosed
  RELATION-half item above's sibling problem)**: `TIMEOUT_CLASSIFICATION` (60) and `TIMEOUT_RAG`
  (30), two real constants declared on adjacent lines in `mission_coordinator.py`, can still
  collide via their shared word "timeout" -- a genuinely correct claim about a `60`-second timeout,
  with "RAG retrieval" mentioned nearby (very plausible in this RAG-based codebase's own prose),
  falsely blocks against `TIMEOUT_RAG`. Verified this is **pre-existing**, not a side effect of the
  `df76289f` min_words fix (which lowered the word-token floor 4→3): reproduces identically against
  the pre-df76289f code too, since `TIMEOUT_RAG` was already "specific" via the
  `MIN_STANDALONE_SYMBOL_CHARS` fullPhrase-length escape hatch before that fix, with a match bar of
  just the single generic word "timeout" alone -- if anything, df76289f tightened it slightly (now
  requires "timeout" AND "rag" both nearby, not "timeout" alone). Same root-cause family as the
  already-disclosed, deliberately-deferred false positive #3 above (two real symbols sharing a
  generic word; proximity-based AND-matching alone can't disambiguate which one a claim refers to) --
  left untouched per explicit agreement, not patched reactively.
- **Fixed (2026-07-08): after the list-marker fix, 4 of the remaining CraftConnect eval abstentions
  all blocked with "Fenced code block does not match any evidence content -- likely fabricated
  illustrative code" (or the parallel quote-misattribution message).** The gate discards the
  pre-gate answer on block, so each of the 4 was re-run with `AnswerGate.prototype.verify`
  intercepted to capture the raw answer, then compared line-by-line against the real,
  fresh-from-disk file it was attributed to. 3 of 4 were false positives, 1 was a genuine catch:
  - *(fixed)* **Classification-timeout question**: the model's quote resolved a real f-string
    placeholder (`f"Classification timed out after {TIMEOUT_CLASSIFICATION}s"` -> "...after 60s")
    and correctly attributed it to `mission_coordinator.py`. The evidence-wide quote check already
    tolerates resolved placeholders (`matchesTemplateInContent`, from the earlier audit-04 fix), but
    the PER-FILE attribution check (verifying the claimed file's own real content) only did a
    literal substring comparison, blocking a fully correct answer. Fix: `matchesTemplateInContent`
    is now also applied in both the quote-attribution branch and the parallel fence-attribution
    branch, checked against the claimed file's own fresh-from-disk content (anchored for quotes,
    since a quote's inner string IS just the resolution; non-anchored for fences, since a fence's
    `rawCode` contains more than just the resolved literal, e.g. `raise Exception(f"...60s")` wraps
    it -- found live during test-writing, not assumed).
  - *(fixed)* **WhatsApp-prompt question**: the model quoted 3 real, verbatim lines of
    `packager_agent.py`'s multi-line f-string prompt concatenation but flattened them into one fence
    line using literal `\n` as a human-readable separator (not an actual newline), and elided two
    intervening real lines (PRICE, GUIDELINES). **Atomic-write question**: the model's fence had
    three verbatim, correctly-ordered real lines from `artifact_manager.py`, with one intervening
    structural line (`try:`) omitted. Both fully correct answers, both blocked solely because the
    whole-block contiguous check requires an unbroken literal substring match. Fix:
    `fenceLinesMatchInOrder()` is a fallback (contiguous match tried first, unchanged) requiring
    every normalized line of the fence present in the comparison content, in the same relative order
    (a monotonically-advancing search cursor), with at least one line >= `CODE_QUOTE_MIN_LENGTH`
    that isn't a bare `import`/`try`/`except`-shaped line (`GENERIC_CODE_LINE_REGEX`) -- the safety
    valve against splitting a genuinely fabricated block into fragments and hoping each matches
    somewhere unrelated. Literal `\n` escapes in the fence are unflattened into real line breaks
    before splitting, so a model that types `"A.\nB\nC.\n"` is evaluated as three lines, not one
    non-matching composite. Applied to both the evidence-wide fence check and the per-file
    attribution branch (the two real cases were fixed by the evidence-wide application alone,
    neither having a literal filename mentioned before the fence; the attribution branch's own copy
    is covered by two isolation tests that force reliance on it specifically, confirmed as real
    induced failures on pre-fix code).
  - *(confirmed correct, not touched)* **JSON-fallback question**: the model claimed the fallback
    `"title"` field is populated with `rejection_text` (a real string, but from an unrelated method,
    assigned to the wrong field) -- ground truth is
    `f"{craft_name} | Handmade Traditional Wall Art | Authentic Indian Heritage"`. This composite
    line exists nowhere in the real file, so it correctly stays blocked under both the old and new
    checks -- the gate did its job here.
  Verified with real induced-failure tests reproducing all 3 fixed cases (confirmed failing against
  pre-fix code, passing after) plus the JSON-fallback case as a control (stays blocked), the two
  attribution-branch isolation tests, and a disclosed-residual test confirming a fence made entirely
  of short generic lines in coincidentally-plausible order is still correctly refused (no distinctive
  line to anchor trust) -- not fixed, since there is nothing left to distinguish "this could be any
  file's boilerplate" from a genuine reproduction once every fragment is generic.
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
- **Fixed (2026-07-08): `AnswerGate`'s numeric-contradiction check under-protected compound symbols
  whose word tokens include one shorter than 4 characters.** `symbolProximityTokens()` filtered word
  tokens to `length >= 4` before requiring ALL of them present nearby; for a symbol like
  `min_words`, that dropped `min` and left only `words` -- a single, extremely generic English word
  -- as the sole thing that had to be "present nearby" to trigger a contradiction, functionally
  identical to the already-fixed "generic short symbol" false-positive class, just reached via a
  different route (a compound name degenerating to one generic surviving word, rather than a lone
  short symbol from the start). Fix: lowered the per-word floor from 4 to `MIN_WORD_TOKEN_CHARS = 3`
  (preserving distinctive short prefixes like "min"/"max"/"num") plus a small
  `GENERIC_SHORT_WORD_TOKENS` stoplist (the/and/for/are/...) so lowering the floor can't let two
  generic filler words substitute for one -- lowering the floor can only make the existing
  require-ALL-words AND-match stricter (more distinct words must co-occur), never looser, so this is
  safe by construction. Verified with a real induced-failure regression test using the real fact
  (`min_words`/95/`app/llm_backends/mock_backend.py:155`): confirmed failing against the pre-fix
  code (a markdown numbered-list answer mentioning "words" generically, unrelated to `min_words`,
  falsely blocked) and passing after; a control test confirms a genuine `min_words` contradiction
  (both "min" and "words" actually present nearby) is still caught.
- **Fixed (2026-07-08): decomposition anchor cross-layer bug** (found 2026-07-07, capability audit):
  task-derived sub-question anchoring validated that a hint resolves to a real unit, but had no
  concept of "the same architectural layer as the rest of the question" -- on a full-stack question,
  the anchor pool locked onto frontend TypeScript symbols (`submitAnswer`, `retryAnswer`,
  `transitionState`) for a question actually about the backend Python interview flow, and every
  derived sub-question inherited that bias, producing an answer padded with React state-transition
  detail and hedged mentions of irrelevant agents. Never surfaced in prior backend-only
  decomposition testing (`mission_service.execute_mission`), since there was no frontend/backend
  ambiguity for anchoring to go wrong on. Fix: `filterAnchorsForLayerCoherence()` in
  `llmEvidencePlanner.ts` filters the validated anchor symbol pool toward a dominant language before
  it anchors every derived sub-question, using two store-validated signals in priority order --
  (1) the languages of the master plan's own store-validated FILE hints across ALL retrieval tasks
  (a stronger "what is this question actually about" signal than any one symbol guess), falling back
  to (2) the anchor pool's own majority language when file hints give no majority. Deliberately
  conservative, matching this module's existing "never guess" posture: a genuine tie (no file-hint
  signal, evenly split pool) filters nothing, and filtering never empties the pool completely (if
  every validated anchor is the non-dominant language, the original pool is kept rather than
  anchoring sub-questions with nothing). Verified with a real induced-failure end-to-end test
  (`buildLLMEvidencePlan` with a mixed real Python/TypeScript unit store and a mocked planner
  response mirroring the live bug's shape): confirmed the frontend anchors leaked into every derived
  sub-question with the fix disabled, and are correctly filtered out with it enabled, while the
  coherent backend anchors are preserved -- plus 4 direct unit tests against
  `filterAnchorsForLayerCoherence()` covering the tie and never-empty-the-pool safety cases.
- **UX/cognitive load has not been touched since Phase 5.** Every fix from the retrieval-integrity
  and decomposition threads (reindex atomicity, the liveness gate, token budgeting, decomposition
  itself, the retry policy, this pass's contradiction check) is real and substantial, and
  essentially invisible in the UI: no badge or trace distinguishing a decomposed answer from
  single-shot, no visibility into retries, the `[PromptBudget]`/`[Decomposition]` telemetry that
  would make this new trust machinery legible only exists in the output channel log. Confirmed via
  `git log --oneline -- src/ui/ webviews/` since Phase 5's `docs/engineering-log/UX_CONSOLIDATION_REPORT.md` commit: the
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
- `package.json`'s `repository.url` and `publisher` are now set to real values (`repository.url` to
  the GitHub repo, `publisher` to `RohanLC1263` to match). Note this `publisher` is the GitHub
  username, not yet a *verified VS Code Marketplace publisher id* -- Marketplace submission would
  still require registering/verifying a publisher there first.
- No extension icon exists (needs a real design asset, not something generatable as part of this pass).
- **Fixed (2026-07-08): a fresh `npm install` on a clean clone used to reliably fail.**
  `postinstall` (`scripts/install-electron-sqlite.js`) tried to rebuild `better-sqlite3` and
  `node-tree-sitter` for VS Code's Electron ABI via `@electron/rebuild`, which failed on this
  environment's toolchain with `error C1189: "C++20 or later required"` (Electron 42's bundled V8
  headers require C++20; the local node-addon-api/node-gyp project files force `/std:c++17`) --
  fully reproducible, confirmed identical on retry, and confirmed via a genuine fresh clone (not
  just the working dev environment). Root cause: `better-sqlite3` was dead weight -- `npm ls
  better-sqlite3` reported it `extraneous` (not a declared dependency of `repoguide` or anything it
  depends on), confirmed via `grep -rn "require('better-sqlite3')" src/` finding zero hits (the
  codebase migrated to Node's built-in `node:sqlite`, used in 94 files, and never removed the old
  dependency/rebuild scripts). Fix: removed the `postinstall`/`rebuild:native` entries from
  `package.json`, deleted `scripts/install-electron-sqlite.js`/`scripts/rebuild-better-sqlite3.js`,
  and regenerated `package-lock.json` (`npm install` now reports "removed 1 package" and
  `better-sqlite3` no longer appears in the lockfile at all). Verified as a pure subtraction, no
  behavior change: `compile`/`lint`/the full real `node --test` suite (239 tests, 229 pass, 10 fail
  -- identical count to before removal, same pre-existing unrelated failures)/`vsce package` all
  produce identical results before and after, and a genuinely fresh clone of the post-fix commit
  now runs `npm install` to completion with zero errors. `@electron/rebuild`/`electron` remain as
  devDependencies (not removed -- out of the explicitly-scoped "remove better-sqlite3" ask; they're
  merely unused now, not broken, and removing them wasn't verified as risk-free in this pass).
  Separately, whether `node-tree-sitter`'s bundled `prebuilds/win32-x64/tree-sitter.node`
  (confirmed loadable under plain Node) is ALSO ABI-compatible with VS Code's actual Electron
  runtime remains **unverified** -- confirming this needs a real F5 launch or installed-`.vsix`
  smoke test in an interactive VS Code session, which no pass so far has had a way to perform.
- The full jest suite has pre-existing, unrelated flaky failures (worker-process resource contention,
  plus several test files calling `process.exit()` directly on failure) that make it unsuitable as a
  hard CI gate today -- CI intentionally runs only `compile`/`lint`/`test:unit` until that's cleaned up.
- Ruby/PHP/Swift still have no tree-sitter grammar and fall back to fixed-window plain-text chunking.
- **Per-language logical-unit extraction gap — surfaced 2026-07-23 during multi-language testing,
  logged not scheduled.** `logicalUnitExtractor.ts` does real tree-sitter-based logical-unit
  extraction (accurate class/function/method boundaries and symbols) for **Python and JS/TS only**.
  **Java, Go, Rust, C#, and C++** parse but then fall back to **regex-based chunking**, with much
  less reliable symbol and boundary detection — a whole class can be split across chunks, or a
  chunk's `symbol`/`type` can be wrong or missing. Practical implication: a "passing" multi-language
  test for those languages rests on **retrieval luck** (the right text happening to land in a
  chunk), not the architectural guarantee Python/JS-TS get from real AST boundaries. This is the
  weak foundation under several reliability efforts:
  - The deterministic **branch-bypass** work (§ branch-logic entries above) needs accurate
    condition/assignment node boundaries; outside Python/JS-TS those come from regex, so the bypass
    is correspondingly less trustworthy there (consistent with the Java regression already found
    and fixed by making the identity gate content-based rather than symbol-based).
  - The recent **Issue 1 orientation-container fix** (`evidencePacketBuilder.ts` /
    `logicalUnitStore.searchContainerUnitsByFragment` / `formatPacket`'s reserved slot) depends on
    reliable **class/interface container-unit boundaries** to pull the right class-level chunk for a
    broad "explain this feature" question. It was verified to fire across Python/Java/Go/Rust in
    testing, but on Java/Go/Rust/C#/C++ the container unit it resolves to is only as good as the
    regex chunker's class boundary — exactly the guarantee that's weaker there.
  - **Rough scope of the real fix**: add a tree-sitter grammar + node-type query per language
    (class/interface/function/method/field extraction), mirroring what Python and JS/TS already
    have in `logicalUnitExtractor.ts` — a similar effort *shape* per language, not novel work, but
    multiplied across five grammars (each with its own node-type vocabulary and edge cases). No
    timeline committed; logged here so the multi-language "passing" results are read with the right
    caveat rather than mistaken for an architectural guarantee.
- The `legacy` vs. `evidence` query pipeline split (`docs/engineering-log/ARCHITECTURE_CONFORMANCE_REPORT.md` #1) is
  unresolved — `explainSelection` still silently falls back to legacy for some query types.
- Orphaned modules (`src/intent`, `src/evolution`, `src/drift`, `src/causal`→MCP chain,
  `src/orchestrator`, `src/incident` singular) still need a keep-or-delete decision.
- **AnswerGate branch-consistency check (self-contradiction detection for §1.1's boolean/
  branch-logic ceiling) — investigated 2026-07-11, deferred by timeline, not abandoned.**
  Partially de-risked, not an unexplored idea: the validation harness ran the real design
  against real captured cases and found the naive verifier shares the generator's ceiling,
  but identifier-neutralization isolated the failure to identifier-driven plausibility plus
  a narrower negation-crossing-assignment gap, and a refined design (neutralize the rule
  side only, classify outcomes from a closed set) hand-verifies 3/3 caught / 0/5 false-flagged
  across all 8 cases. See `LIMITATIONS.md` §1.3 for the full trace, the specific failure
  modes found, and why a generalized version is estimated at 3-5 days rather than attempted
  against a shorter runway. Harness/probes/traces preserved for resumption.
- **Cross-model (different-lineage) verification pipeline for §1.1's branch-logic ceiling —
  investigated 2026-07-14, validated and declined (NO-GO), not deferred.** A three-tier design
  (primary answer -> same-model pointed re-ask -> escalate to a different-lineage reasoning model,
  DeepSeek-R1:8b, only when the primary and the re-ask disagree) passed 4/4 on the adversarial
  cases that motivated it: DeepSeek-R1's forced substitution genuinely did not share
  qwen2.5-coder's boolean/negation inversion bias. Broader validation on a 16-case
  conditional-selected real sample reversed the result and disqualified the design:
  - The same-model re-ask tier caught 0/14 real errors and manufactured false alarms from its own
    shared negation blind spot -- it deterministically flips some correct answers to wrong, so it
    cannot serve as an authority.
  - DeepSeek escalation was accurate on what it saw (2/2 correct on the disagreements) but only ever
    confirmed already-correct primaries -- pure added cost, zero real catches, on this sample.
  - The two models cannot co-reside (4.7 GB qwen + 5.6 GB DeepSeek = 10.3 GB > the 8 GB VRAM
    budget), so every escalation forces a model swap (~8.7 s cold load) on top of DeepSeek's own
    latency.
  Conclusion: do not build the 3-tier design into the live pipeline. The 4/4 adversarial result did
  not generalize -- the checking mechanisms introduced more false alarms than they resolved real
  errors, or shared the generator's blind spots. Documented rather than hidden, consistent with the
  disclosed-limitation discipline described in README's Engineering Notes; harness/probes preserved
  for resumption. Pairs with the self-verification/branch-consistency entry above: both reasoning-
  improvement attempts were built, validated against real data, and correctly not shipped.
- **Evidence-packet tightening for synthesis (targeting `evidencePrompt.ts`/`formatPacket`) —
  investigated 2026-07-14, reverted after live verification, methodology finding open.** A
  different hypothesis than the two reasoning-improvement entries above: that hedging/unreliable
  answers were caused not by a model reasoning failure but by evidence-packet over-stuffing
  drowning the model's attention. A lever test on a real packet supported it strongly — cutting a
  real packet from 10-12 items + 360-410 facts down to 6 items + 8 facts flipped 3/3 hedged
  answers to correct. Broader validation (two independent runs, Group A focused questions +
  Group B architecture/flow questions) confirmed a tightened packet (the TIGHT config) as a net
  win with no regression, on that harness. A follow-up calibration (query-type-aware budgets,
  routing focused vs. decomposed/flow questions to different packet sizes) then tested well on
  the same standalone harness — `EvidencePacketBuilder.buildPacket(q, plan)` called directly.
  - **Live verification against the real MCP server caught what the harness couldn't see.** The
    calibrated fix did not help the focused test question (still gate-blocked, same as before)
    and regressed the flow test question (anchors 5/5 -> 1/5). The fix was fully reverted
    (confirmed via a clean `git diff` on `evidencePrompt.ts`).
  - **Root cause: the validation harness never exercised the real production pipeline.** It
    called `EvidencePacketBuilder.buildPacket(q, plan)` directly, skipping both
    `RetrievalOrchestrator`'s richer real packet and the `AnswerGate` post-processing step that
    the live MCP path always runs. The harness's packet was thinner and shaped differently from
    what production actually builds and gates, so a result tuned against it doesn't transfer.
  - **This retroactively weakens the earlier "TIGHT is a validated net win" result too** — that
    conclusion came from the same harness-without-orchestrator-and-gate methodology, so it needs
    re-characterization on the real live pipeline before being trusted again, not just the
    follow-up calibration that most directly regressed.
  - **Recommended next step, explicit:** re-run the P1 validation arc (lever test, broader
    Group A/B validation) with `RetrievalOrchestrator`'s actual packet and `AnswerGate` in the
    loop end-to-end — i.e. against the real MCP server, the same way the final calibration
    attempt was (correctly) checked — before attempting any further packet-size tuning. Stopped
    and reported plainly per the standing instruction to not ship a partial fix past 2-3
    reasonable calibration attempts; this is that report.
- **First-run readiness gating — investigated 2026-07-12, deferred pre-demo, not abandoned.**
  A first-run-experience pass over `src/health/startupCheck.ts` and `extension.ts`'s activation
  path surfaced one real correctness bug and several rough edges, none touched yet because the fix
  crosses activation control flow at multiple rebuild trigger sites -- not a change to make hours
  before a live demo. Planned as one coherent change (phase one):
  - **`startupCheck` verdict refactor**: replace today's check with a real
    `ready | ollama-down | models-missing` verdict, and gate whether auto-index runs on it, wired
    into the "Setup needed" state this week's input-gating machinery already added (rather than a
    parallel ad hoc check).
  - **False-success bug**: a workspace can currently end up with a *committed* zero-chunk index
    when embedding calls fail during the first rebuild -- the rebuild reports success and nothing
    downstream distinguishes "really empty repo" from "embedding failed, nothing got chunked."
    Fix: never commit a zero-chunk index when the zero is attributable to embedding failures.
  - **Activation resilience**: wrap the startup rebuild in try/catch so a failed first index
    degrades gracefully (extension still activates, user sees a real error) instead of the current
    behavior of aborting `activate()` entirely.
  - **Chat error message**: replace the raw "fetch failed" surfaced to chat when Ollama is
    unreachable with an actionable Ollama-connection message (what's down, how to fix it).
  - **Docs/config gap**: `qwen2.5-coder:3b` is pulled and usable but undocumented -- add it to
    README and to `startupCheck`'s known-model list.
  **Phase two, explicitly deprioritized below phase one**: auto-pull-with-progress (drive Ollama's
  `/api/pull` and stream progress instead of just telling the user to run `ollama pull` themselves),
  plus an optional VS Code `contributes.walkthroughs` onboarding page.
  **Grounded estimate**: ~1 day for phase one including tests, ~1 day for phase two.
  Deferred deliberately: this touches activation control flow across multiple rebuild trigger
  sites, which is not the kind of change to make hours before a live demo.

## Codex audit — out-of-scope backlog (logged 2026-07-24, deliberately NOT fixed this cycle)

An independent adversarial audit ("Codex") was triaged this cycle. The demo-critical findings were
verified live and addressed (see below and `docs/engineering-log/REPOGUIDE_AUDIT.md`); the items in
this section were confirmed real but scoped out of the pre-demo fix window and are parked here so
they are not lost.

- **`ask_repoguide` gate does not check coverage/evidence-sufficiency.** Reproduced:
  `gateStatus: pass` co-occurs with `coverageScore: 0` on dead-code / thin-evidence questions
  (verified 3/3 on a dead-code question, low confidence + a "partial coverage" caveat but still a
  pass). This is a **design gap, not a bug** — `AnswerGate` verifies surface artifacts (numbers,
  quotes, code, file paths) only, by design; it was never a grounding check. A broader
  coverage-gated answer path (block or down-rank when coverage is near zero) is a real redesign, not
  a hotfix — deferred. In the meantime the demo guide steers around it.
- **Fabrication → refusal is real but non-deterministic.** On questions with no grounding, the model
  sometimes fabricates illustrative code, which the gate catches and turns into a bald refusal
  (reproduced 5/5 on the `community_engine.py` dead-code question); other phrasings instead pass with
  a vague, ungrounded answer (e.g. `FLAG_THRESHOLD`). The gate is doing its job (catching fabricated
  code) but the failure UX — refuse vs. hedge — is inconsistent. A graceful "insufficient evidence"
  answer state (instead of either a refusal or a vague pass) is the real fix; deferred.
- **Mini-eval score is a genuine ~64%, not a scoring artifact.** After fixing the harness so it
  strips the internal `{"__type":"gateStatus",...}` control token before scoring (it was leaking into
  scored answer text, mirroring the fix already in `askRepoguideTokenProcessor.ts`), the corrected
  score was ~64% across two runs — still below the 0.8 threshold. So the low score is a real
  answer-quality signal, not purely an artifact of the leaked token. Raising it is answer-quality
  work, out of scope for this triage.
- **RepositoryBrain empty**, packaging/bundle cleanliness beyond the Phase 6 fixes, unconditional
  debug-log noise, and the eval script's hardcoded repo path — all real, all logged, all deferred.
- **`get_dependents`/`get_dependencies` mis-target nonexistent symbols that share a token with a real
  graph node** (found 2026-07-24) — **RESOLVED 2026-07-24.** `programGraphProvider` tokenizes the query
  symbol (`programGraphProvider.ts:168`) and matches nodes by token, so a symbol that does not exist
  but shares a token — e.g. any misspelled `...Agent` name matching the `agent` node — resolved to that
  unrelated node at `confidence: 0.9` with no "not found" signal. Fix: a post-retrieval identity check
  (`src/mcp/graphIdentityMatch.ts`, `identifierCorresponds`) now validates that the matched
  `graph_symbol_node` genuinely corresponds to the requested identifier (exact case-insensitive symbol
  match, or real file/path match) before both `buildDependentsResponse`/`buildDependenciesResponse`
  return it; a non-correspondence yields `found: false` with closest-match `suggestions` instead of a
  mis-target. The MCP handlers pass the requested `symbol` through. Verified live on CraftConnect
  (PaymentReconciliationAgent/InventorySyncAgent → `found:false`; BaseAgent/ConversationAgent/
  PackagerAgent unaffected) and with 10 new unit tests across the two builder suites; full regression
  shows no new failures. The branch-bypass ambiguity fix covered *ambiguous existing* symbols, not
  these *nonexistent* ones.
- **The import graph under-captures reachability — blocks a whole class of "is this dead/live" trust
  checks** (found 2026-07-24). Investigated whether the rc-11 gap (an answer grounding a "uses
  Firestore" claim in dead code) could be closed by a deterministic "answer cites evidence from a
  dead-code source file" check, reusing the shipped file-usage verifier's `getDependents` importer
  lookup. **It does not work, and the reason is important:** on the real rc-01..rc-12 batch the check
  flagged 9 of 10 cases (nearly every *good* answer), because the import graph reports `0 importers`
  for genuinely-live files that are framework/dynamically wired — `app/routers/auth.py`
  (`include_router`), `app/middleware/observability.py` (`add_middleware`), `app/api/mentor_agent.py`,
  agent-registry files, even `app/main.py` (entry point). `include_router`/`add_middleware`/DI-registry
  wiring are not import edges, so "0 importers" ≠ "dead" for most of the codebase. It was only correct
  for `community_engine.py` (genuinely never imported *and* not framework-registered). Consequences:
  (1) the **shipped file-usage verifier** (`answerGate.ts`, 2026-07-24) has a latent false-positive on
  framework-wired files: an answer explicitly asserting e.g. "`auth.py` is used" would get a wrong
  "may be dead code" caveat. Trigger is narrow (explicit affirmative file-usage claims are rare) and
  the effect is soft (a `revise` caveat, not a block), but it is real — consider extending the
  entry-point exclusion to detect framework-registration patterns (`include_router`/`add_middleware`/
  decorator/registry) if it surfaces. (2) **rc-11 is not cleanly closable today** by either a
  deterministic check or an evidence-anchored critique loop (ADR-001 V2): the critic would need a
  reliable *reachability* oracle to know the Firestore reference is in unreachable code, and per the
  critique-loop's own hard constraint ("must check against a concrete, reliable external reference,
  not self-reflection") no such anchor exists — the retrieved evidence literally contains `firestore`,
  so a critic re-reading it confirms the claim, and the graph is too incomplete to trust. **The real
  prerequisite is framework-aware graph edges** (`include_router`/`add_middleware`/DI/registry
  reachability) — the "richer graph edges" item the long-term vision already names. Building the
  critique loop before that anchor exists would violate its own constraint 1; deferred deliberately.

## Richer graph edges — scoped initiative (scoping done 2026-07-24, NOT started)

The program graph models only literal `import`/`call`/`instantiate`/`read`/`fallback` edges. Three
separate findings this session trace to that one gap. Scoped against real CraftConnect (100 backend
`.py` files) plus cross-repo checks (gin/Go, junit5+guava/Java, Newtonsoft/C#). Verdict: **a
multi-round initiative, not a piecemeal fix — do not start under current time constraints.** Detail:

- **Framework-registration edges** (routers/middleware mounted via `include_router`/`add_middleware`).
  CraftConnect impact: ~8 of 100 files (7 `APIRouter` files + 1 middleware class), all mounted in one
  wiring file; 47 route decorators. **Not generically detectable.** Cross-repo confirms two disjoint
  mechanisms: call-argument registration (FastAPI `include_router`, Flask `register_blueprint`, Go gin
  `.GET/.Use` — ~1385 in gin) vs annotation/attribute registration (Spring/JUnit `@Test`/`@ExtendWith`
  — 17k in junit5, C# `[JsonProperty]`). A generic "symbol passed to a registration-named call" catches
  only the call-argument family, and only with a **maintained per-framework list of registration
  function names**; the annotation family needs a separate mechanism per language. Effort: ~1-2 days
  for Python FastAPI/Flask call-argument edges incl. tests; +0.5-1 day per additional call-arg
  framework; +2-3 days per annotation-based language. **The gate-level workaround already shipped
  handles the immediate false-positive**, so the graph edges here have no urgent consumer.
- **DI-container-mediated edges** (CraftConnect `AgentContainer`: constructor-injects 11 of 20 agents,
  stored as `self.classifier` etc., later used as `self.container.story.generate(...)`). Impact: ~11
  real dependency relationships invisible per orchestrator. **Not generalizable — this is the trap.**
  Resolving `self.container.story` → `StoryGenerationAgent` requires local dataflow/points-to analysis
  (param→attribute binding + what was passed at construction), which is project-specific to each
  codebase's DI style. A CraftConnect-shaped heuristic (~3-5 days) would be exactly the
  synthetic-edge anti-pattern `LANGUAGE_HACK_CLEANUP_REPORT.md` documents; a general DI resolver is
  weeks. **Recommend NOT building** absent a real type/dataflow layer.
- **External-service facts, NOT edges** (Bedrock/boto3/firestore/httpx/OpenAI). CraftConnect impact:
  ~60 call sites (firestore 29, httpx 23, Bedrock 18, boto3 8). The prompt's reframing is right: no
  internal node to connect to — the fix is a new **fact** ("symbol calls external service X") from a
  maintained SDK-entrypoint pattern table, parallel to existing fact extraction. **Smallest and most
  generalizable of the three** (pattern→fact, no graph resolution, no dataflow): ~1-2 days Python-first
  + wiring into retrieval/answers. Still not trivial, and a fact extracted but unconsumed is orphaned
  (Definition-of-Done #2), so it needs an answer-side consumer designed alongside it — not a drop-in.
- **Cross-language** compounds all three: framework-registration and DI detection must be re-built per
  language extractor, and only Python/JS-TS have real extraction today, so the other 5 languages get
  nothing regardless.

**Recommendation:** none of these is a small, generalizable, build-it-now piece. Sequence when this
initiative is picked up: (1) external-service facts (smallest, most general, but design its consumer
first); (2) FastAPI/Flask call-argument registration edges (bounded, one framework family); explicitly
**decline** the DI-container resolver as project-specific. Aligns with the long-term vision's "richer
graph edges" bullet; belongs in Phase 3 (deepen change-impact), after the trust foundation.

**Fixed this cycle (for the record, not backlog):** the flagship confidence-threshold regression
(numeric domain guard in `answerGate.ts` + deterministic-query-type authority guard in
`llmEvidencePlanner.ts`); the harness gateStatus-strip; `gather_evidence` now accepts `query` as an
alias for `question`; and `CraftConnect_Demo_Guide.md` was re-scoped onto the deterministic graph
tools plus the one re-verified narrative question.
