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

## Chat/MCP trust fix round (2026-07-25) — what landed, and the one real gap left

Six issues (A–F) were root-caused and four fixes landed (`549ae323`..`4643fb90`). Resolved:

- **Graph-evidence contamination — FIXED.** `programGraphProvider` re-tokenized the raw question and
  sub-token-split identifiers (`BaseAgent` → `Base`, `Agent`); the bare `Agent` fragment matched a real
  but unrelated node (`agent` in `craft_classifier_agent/agent.py`) whose dependents were emitted under
  the same DEPENDENCY category as the subject's. Graph targets now come only from the plan's extracted
  symbol/file targets. Side effect worth noting: `get_dependents("AuthValidatorAgent")` went 9 → 2, and
  the 7 removed were UI `.tsx` files that never reference the symbol.
- **Inflated blast-radius numbers — FIXED.** `MentorEngine` counted every DEPENDENCY-tagged item as a
  "dependent" — the subject's own anchor, its *outbound* dependencies, structural edges, and the
  SemanticImpactEngine's *transitive* assessment. Now counts only true inbound signals; transitive
  impact is reported separately under its own label. ArtifactManager 37 deps/23 files CRITICAL → 4/3
  MEDIUM (graph truth: 4/3); BaseAgent 70/25 CRITICAL → 13/13 HIGH (truth: 13).
- **Confidence badge — FIXED.** Was derived from retrieval volume (`coverageScore`, which is 0 for most
  queries by construction), so the same "Low" covered a correct answer and a fabricating one. Now
  derived from the gate: blocked → low, revised/unsupported → medium, clean pass → high.
- **BM25 "index appears corrupted" — FIXED.** The save-triggered refresh (2s debounce after any source
  save) called `clearAll()` then `indexUnits()` on the *same store instance the chat pipeline queries*,
  so retrieval searched an empty index for the whole repopulation window. Note the generation swap alone
  was NOT sufficient — `beginRebuild()` also reassigns state on that instance — so
  `SegmentedMiniSearchIndex` now snapshots the live index at `beginRebuild()` and serves reads from it
  until commit. This also removes a real source of cross-session evidence variance.
- **ProgramGraphStore hardening — FIXED (defensive).** Atomic temp+rename save; `load()` reports a
  corrupt graph loudly instead of silently returning an empty one (which previously made every
  dependency lookup answer "nothing depends on this" repo-wide with no error anywhere).

### Still open

- **Chat fabricates INBOUND dependents in prose — NOT fixed, and not fixable by the above.** Asking chat
  "what depends on X" still invents dependents (verified against source: `community_engine.py`,
  `studio_read.py`/`studio_write.py`/`auth.py` "using ArtifactManager", several agents "using
  RAGRetrieverAgent" — none reference those symbols). The text does not come from the graph: the model
  narrates over ~650 co-occurring RAG/BM25 chunks, and `AnswerGate` cannot catch it because it does not
  verify prose relationship claims — the same gap the relationship-claim gate check was scoped out of.
  The **outbound** direction ("what does X depend on") is reliable for a principled reason: those
  dependencies are visible inside the file being narrated, so the model reads rather than invents —
  verified claim-by-claim on 3 symbols, 23/23 real. Demo guidance updated accordingly; the MCP
  `get_dependents` tool is the correct answer for the inbound question.
- **The program graph under-reports at least one real dependent** (found incidentally 2026-07-25).
  `scripts/craftconnect_cli.py:68` genuinely does `MissionOrchestratorAgent(use_mock_llm=True)`, but the
  symbol is absent from `get_dependents("MissionOrchestratorAgent")`. A recall defect in graph
  construction, distinct from the fabrication issue above (which is over-reporting). Not investigated
  this round — worth a scoped look before leaning harder on blast-radius completeness claims.

## Dead-file retrieval suppression — built, measured, declined (2026-07-28)

A retrieval-side down-rank of "evidence from files nothing imports" was implemented and
measured against CraftConnect, then deliberately not shipped. It targeted a real, verified
failure: asked why `get_current_user` returns 401, Chat explained Firebase JWT verification
(`jwt.decode`, `RS256`, `FIREBASE_PROJECT_ID`) -- all real code, lifted verbatim from
`app/core/community_engine.py`, a dead module -- while the live implementation in
`app/core/auth.py` calls `supabase.auth.get_user(token)`. That dead file was a top-3
retrieval source in roughly a third of tested queries.

**Why it was declined — measured precision of "zero inbound import edges":**

| signal | backend .py | frontend .ts/.tsx |
|---|---|---|
| import graph alone | 38% | 13% |
| graph + BM25 corroboration | 50% | 61% |

The import graph misses path-alias imports (`@/pages/...`), `__init__.py` re-exports and
dynamic imports, so genuinely live files (`ingest_agent.py`, `qa_agent.py`,
`rag_retrieval_engine.py`, `InterviewPage.tsx`) were repeatedly judged dead. Suppressing
their evidence on every query is a worse regression than the misattribution it fixes. This
is the same conclusion reached when the "cited-from-dead-code" gate check was declined
earlier — the underlying defect is the graph's reachability recall, already logged above.

**Shipped instead:** a FILE ATTRIBUTION RULE in `evidencePrompt.ts` telling the model to
describe a symbol's behaviour only from the file where that symbol is defined, and to name
the file explicitly when referencing a different one. It suppresses no evidence, so it
carries no false-positive risk. Verified: the Firebase/RS256/jwt.decode contamination is
gone from the 401 answer, and "what's in the legacy folder" still answers correctly.

`deadFileDetector.ts` retains only the entry-point / framework-wiring helper that
AnswerGate's file-usage check uses; the measurement code was not kept.

## Claim-listing technique: technique fix or model-size fix? (measured 2026-07-28)

A cloud experiment (Llama 3.3 70B) showed that forcing the model to enumerate every claim
with an explicit `SUPPORT: <citation> | NONE` table before answering reversed two documented
fabrications. That left the important question open: is this a property of a big model, or of
the technique? Answered by running the SAME structure on the LOCAL model
(`qwen2.5-coder:7b`, production `num_ctx=16384`, `temperature=0`), with a matched
no-instruction baseline on the same evidence -- the controlled comparison the cloud run lacked.

Packets larger than the context budget were trimmed HEAD-first before the run: Ollama silently
keeps only the TAIL of an over-length prompt, which would have deleted the very instruction
under test and produced a false negative.

| case | failure class | baseline | + claim-listing |
|---|---|---|---|
| PDF export sync/async | fabrication (false premise) | FAIL (asserted "handled asynchronously / in the background") | **CLEAN** (correct abstention) |
| get_current_user 401 | dead-file cross-contamination | CLEAN | CLEAN |
| apply_decision_policy callers | misattribution | FAIL | FAIL |
| ArtifactManager dependents | misattribution | FAIL | FAIL |
| RAGRetrieverAgent dependents | misattribution | CLEAN | FAIL |
| branch logic (MADHUBANI .86/.75) | inference error | FAIL | FAIL |

**Verdict: it is a technique fix, but it only fixes ONE failure class.** On the same local
model, the instruction alone converted the PDF case from a confident fabrication into a correct
abstention -- so the benefit is not model size. But it does not generalise:

- **Fabrication from absent evidence -> FIXED.** With nothing in the packet to cite, the local
  model does write `SUPPORT: NONE` and then abstains.
- **Misattribution -> NOT fixed, root-caused.** The local model treats the SUPPORT field as a
  LOOKUP ("find an evidence item containing a related token"), not as a VERIFICATION ("does this
  item establish this claim?"). It emits syntactically perfect, semantically empty citations.
  Worst instance: for "what depends on RAGRetrieverAgent" it claimed `Depends` is used to depend
  on RAGRetrieverAgent and cited ~20 real file:line locations -- every one of which is a route
  decorator or unrelated signature, and `RAGRetrieverAgent` appears **0 times** in
  `community_engine.py`, the file it cited most. The format is followed; the semantics are not.
- **Branch-logic inference -> STRUCTURALLY UNFIXABLE by this technique.** Asked what
  `apply_decision_policy` returns for MADHUBANI at confidence 0.86 with second-best 0.75, the
  correct answer is `REQUIRE_USER_CONFIRMATION` (strict group: conf 0.86 >= 0.85 passes, but
  margin 0.11 < 0.15 fails the AND). Both baseline and claim-listing answered `AUTO_ACCEPT`, and
  claim-listing attached a *genuine* citation to the wrong answer. Claim-listing verifies
  PROVENANCE (did this come from evidence?), not INFERENCE (did I reason over it correctly?), so
  it cannot catch a branch inversion by construction. This is the already-documented ceiling that
  the deterministic branch-bypass exists for, re-confirmed under the new structure.

Practical consequence: claim-listing is worth adopting for the abstention win, but it must not be
sold as a general anti-hallucination fix -- 4 of 6 documented cases still failed with it enabled.

## Deterministic citation verification (shipped 2026-07-28)

Claim-listing alone was measured to fix only fabrication-from-absent-evidence; it does
nothing for misattribution, because the local model treats `SUPPORT:` as a LOOKUP
("find an evidence item containing a related token") rather than a VERIFICATION.
`src/query/citationVerifier.ts` moves that check off the model: for a claim pairing a
symbol with a cited file, it reads the real file and confirms the symbol is actually in
it. Deterministic, no inference.

Measured against the three cases where claim-listing alone had failed:

| case | claim-listing alone | + citation verification |
|---|---|---|
| `apply_decision_policy` callers | FAIL | caught (`apply_decision_policy` absent from `customization_interview_agent.py`) |
| `ArtifactManager` dependents | FAIL | caught (absent from `auth.py` and `studio_read.py`) |
| `RAGRetrieverAgent` dependents | FAIL | caught (absent from `auth.py`) |

Precision controls: zero violations on three answers independently verified correct.
It also fired live during the adversarial suite on two genuine misattributions --
`ListingContentAssistant` cited to `pdf_generator.py`, and the nonexistent
`MissionOrchestratorService` cited to `orchestrator_agent.py` -- both confirmed absent
from the cited files.

Surfaced as `revise` + caveat rather than `block`: the symbol/file pairing is
proximity-based, so a correct answer that merely mentions two things near each other
should be corrected, not withheld. One residual imprecision is known and accepted at
that severity: a proximity artifact can pair a symbol with a nearby file it was not
actually claimed to be in (the reported statement is still factually true, it just is
not a claim the answer made).

**Deliberately out of scope: branch-logic inversion.** A citation can be entirely
correct and still be attached to an inverted conclusion (measured: MADHUBANI at
confidence 0.86 / second-best 0.75 must return REQUIRE_USER_CONFIRMATION because margin
0.11 < 0.15; both prompting conditions answered AUTO_ACCEPT while citing the right
lines). This verifies provenance, not reasoning -- that ceiling is why the separate
deterministic branch-bypass exists.

### Multi-hop truncation: diagnosis retracted

An earlier entry attributed a dropped file on deep multi-hop questions to budget
truncation. That did not survive checking. An A/B against pre-fix packing showed
`mission_service.py` was ALREADY reaching the packed prompt (16 distinct files either
way); the `[PromptBudget] N dropped` telemetry reports how many items were dropped but
not WHICH, and the inference that this file was among them was wrong. The per-file
packing cap built for it was reverted. The real cause is the 7B model omitting a file
it was given -- an instruction-following limit, not a retrieval or packing one.

## Session-to-session non-determinism: root-caused, one channel fixed (2026-07-28 to 2026-07-29)

Two full runs of the same 38-question set, against an unchanged index, disagreed on 8 of 9
re-checked questions. A separate earlier test had measured 0% variance across 20 repeats.
Both numbers were real; they measured different conditions, and until this investigation
nobody knew which. That made every round-over-round pass-rate comparison in this project
uninterpretable, so it was traced to mechanism rather than guessed at.

**Two independent state channels were found. Neither is sampling temperature** -- that was
checked properly and is pinned to 0 on every live path (`streamChat` sends
`INFERENCE_MODEL_OPTIONS`; `intentClassifier` and `strategyRouter` both send
`PLANNING_MODEL_OPTIONS`). There is no second, history-aware model config. One orphan,
`ollamaClient.streamGenerate`, sends no options at all and would inherit Ollama's default
0.8 -- it has zero callers.

### Channel 1 -- conversation history eating the evidence budget (fixed)

`ConversationHistory` kept the last 10 messages by count with no character ceiling, and
`buildEvidenceMessages()` subtracts that window's length from the evidence budget
(`historyChars` -> `deriveEvidenceBudgetChars`). Every character of prior conversation is a
character of repository evidence that does not reach the model. Measured growth over a real
session: **10.3% of the budget after three exchanges, 27.3% after twelve, 38.2% by the end
of a 38-question run.**

`mcpServer.ts:288` and `extension.ts:159` each create one instance for the whole session.
MCP never clears it; the Chat panel clears only on an explicit user reset
(`sidebarProvider.ts`). `QueryPipelineHarness.runQuestion()` calls `history.clear()` before
every question -- which is exactly why the 20-repeat determinism test measured 0%: the eval
harness structurally cannot see this channel.

The one-variable control -- the same 10-step interleaved sequence run twice, changing only
whether `ConversationHistory.add()` records:

| probe repeat (identical question each time) | #1 | #2 | #3 | #4 |
|---|---|---|---|---|
| history recording ON | block | block | block | **pass** |
| history recording OFF | block | block | block | block |

History off gave 4/4 byte-identical answers and a byte-identical budget (49,262 chars, 12
items, 49 facts). One variable removed, the flip disappears.

**Stage localisation: retrieval is not involved.** Across every condition and repeat the
retrieval telemetry was byte-identical -- same planner (`Regex, Score: 1`), same intent,
BM25 86 / Vector 15 / fused 5, 577 facts, 67 units. The divergence is entirely in prompt
assembly: an identical candidate set, a different budget, a different subset packed.
`AnswerGate` has no instance fields and is a pure function of (answer, packet), so the gate
is not a source either -- an identical answer hash always produced an identical outcome.

A second, currently inert history channel exists upstream: `conversationContext` is passed
to `ExecutionPlanner`, where a non-empty history adds +2 complexity (`complexityScorer.ts`)
and the last 6 messages are injected into the LLM planning prompt (`llmEvidencePlanner.ts`).
The +2 only applies to queries of six tokens or fewer, or anaphoric ones, so it never fired
for this material -- but for short follow-ups it would move *retrieval*, not just packing.

**Fix:** `MAX_HISTORY_CHARS = 4000` with oldest-first eviction, applied in addition to the
existing 10-message cap, never emptying the window entirely. Covered by
`src/test/query/conversationHistoryBudget.test.ts`.

**Verification -- the dose-response curve, re-measured.** Eight characterised questions at
three session depths, every arm started from an unloaded model so the arms are comparable:

| arm | pre-fix | post-fix |
|---|---|---|
| no-state (history off) | 6 pass / 1 block / 1 revise | 6 / 1 / 1 |
| shallow session (history on) | 4 / 3 / 1 | **6 / 2 / 0** |
| deep session, 12 questions first | **2 / 4 / 2** | **4 / 3 / 1** |

**Partially flattened, not flat -- and the reason is now precise.** The starvation mechanism
itself is gone: evidence actually packed in the deep arm went from 11.9 items / 27.1 facts
pre-fix to 14.6 / 42.3, against a no-state reference of 14.9 / 41.9. The budget channel is
closed.

What remains is that a capped window is still window: 4,000 characters of prior Q/A sit in
the prompt and bias synthesis even when they no longer displace evidence. A fourth arm pins
this down -- 12 questions asked first with history recording OFF returned answers
**byte-identical to the no-state reference on 8 of 8 questions**, so the residual deep-arm
difference is history content, not model residency and not retrieval. Eliminating it
entirely would mean not carrying conversation context at all, which would break follow-up
resolution; the remaining effect is accepted and now documented rather than mistaken for
noise.


### Channel 2 -- Ollama model residency (found during verification, NOT fixed)

Post-fix verification exposed a second channel the original investigation had missed,
because "fresh client process" was never a clean isolation: the Ollama *server* persists
across them, and its resident model state changes the output of a byte-identical prompt.

Question 2.1, single query, fresh client process, empty history, identical packing
(13 items / 79 dropped / 41 facts) every time:

| condition | runs | distinct answers | gate outcome |
|---|---|---|---|
| Ollama model left resident | 6 | 2 | block (all 6, two different texts) |
| model unloaded (`keep_alive: 0`) before each run | 4 | **1** | pass (all 4) |

Unloading restores exact reproducibility, and reproduces the value recorded 15 hours
earlier. Note the outcome differs between the two conditions (block vs pass), so this
channel can flip a gate verdict on its own, not merely reword an answer. `temperature: 0`
and a pinned `seed` do not prevent it: llama.cpp's prompt-cache reuse and GPU reduction
order are not bit-reproducible across differing server states.

**Not fixed, deliberately.** The options are forcing a model unload per query
(unacceptable: ~22s cold vs ~9s warm) or accepting the model server as an uncontrolled
variable. What changed instead is measurement practice: **any A/B on live answer text must
unload the model between arms**, or the arms are not comparable. The Condition 4
verification above was re-run under that discipline after a first attempt produced arms
that disagreed with each other.

### Elapsed time alone: no effect

The scripted 18-minute-interval run was interrupted when its session ended and only its
first data point survived; the question is answered instead by a longer natural interval.
The same question, history off, fresh process, **15.0 hours apart**, returned a
byte-identical answer and byte-identical packing (`sha 55e5b759ef81`, 49,262 chars, 12
items, 49 facts). No TTL or timer-driven mechanism was found in the trace, and the variation
that does exist is fully accounted for by the two channels above, both independent of
elapsed time.

### Which past measurements were trustworthy

Worth being explicit, because it determines what can still be cited:

| measurement | path | status |
|---|---|---|
| Adversarial suite (33/36 -> 36/37); determinism 20/20 at 0% variance | `QueryPipelineHarness` -- clears history per question | **Trustworthy.** Ran in the reproducible condition. |
| Technology-name and citation-verifier verification (2026-07-28) | same harness | **Trustworthy.** |
| BM25 race and truncation-anchor investigations | same harness | **Trustworthy.** |
| 38-question realistic set: 18/38 vs 17/38 | live MCP `ask_repoguide`, history accumulating | **Noise-dominated.** Not comparable to each other or to anything else -- session depth alone moved 6 of 8 characterised questions. |
| Any live Chat-panel measurement across a working session | history accumulating | **Suspect**, in proportion to how many questions preceded it. |

Standing rule: a before/after comparison runs through the harness, or pins session state
explicitly and unloads the model between arms, and records session depth with the result.

### Also fixed: MCP stdout was not a clean JSON-RPC transport

Found while tracing. `mcpServer.ts` speaks newline-delimited JSON-RPC over stdout, and 23
`console.log` sites across 6 modules on its import graph were writing into that stream.
Measured over five real tool calls: **305 non-JSON lines against 6 valid JSON-RPC messages**
(288 of them a single `[Deduplication Trace]` log; `inferencer.ts` contributed three lines
per inference call). It went unnoticed only because the investigation's own client silently
dropped unparseable lines -- a standard-compliant client, including Claude Desktop, is under
no obligation to. All were redirected to `console.error` or the `RepositoryContext` logger;
afterwards stdout carries **0** non-JSON lines, with 265 diagnostic lines confirmed present
on stderr. Guarded by `src/test/mcp/stdoutProtocolPurity.test.ts`, which walks the real
import graph from `mcpServer.ts` rather than a hand-maintained file list.

## User-impact fix round (2026-07-29)

Six phases, ordered by what a user actually sees. Two conclusions are negative and are
recorded as such rather than quietly dropped.

### Phase 1 -- Ollama model residency: no cheap reset exists (configurable full reset shipped)

Ollama is a stateful component, not a random one. Replaying a byte-identical 46KB request
10 times back-to-back gave 10 identical answers; the output only changed when the
PRECEDING request changed. Four different preceding sequences produced four
different-but-individually-stable answers to the same question.

A cheap "cache-normalising" throwaway request was tried first and appeared to work. It
was a full reload in disguise: it specified a different `num_ctx`, which is a load-time
parameter, so Ollama re-instantiated the model. Re-measured with a matching `num_ctx` it
cost nothing and stabilised nothing -- 2 of 3 questions still returned multiple distinct
answers. **There is no partial KV-cache reset exposed by the API.** Dropping the instance
is the only thing that normalises the state.

Measured, three real captured requests in rotation:

| option | reproducibility | median latency |
|---|---|---|
| no reset (today's default) | answer depends on the preceding request | 5.8s |
| same-`num_ctx` normalising request | **does not work** -- 2/3 questions unstable | 5.9s |
| full unload (`keep_alive: 0`) | byte-identical on all three questions | 14.6s |

End-to-end through the real pipeline the penalty is far smaller than that microbenchmark
suggests, because consecutive real questions share no prompt prefix to reuse anyway:
**21.1s -> 25.0s median, +3.9s (+18%)**. End-to-end proof, question held at position 1 of
a fresh process so conversation history cannot contribute, varying only what Ollama was
asked beforehand: **3 runs / 2 distinct answers with the reset off, 3 runs / 1 answer with
it on.**

Shipped as `repoguide.determinism.resetModelBeforeSynthesis`. **Default ON, decided
2026-07-29** (it shipped off for one commit, then flipped). +18% is worth paying: this
channel can flip a gate verdict rather than merely reword an answer, and an off-by-default
setting that `QueryPipelineHarness` pins on would mean the harness measures a pipeline no
user runs -- reopening exactly the harness-vs-live divergence this investigation set out to
close permanently.

Re-verified against the shipped default alone, with no environment variable and no code
path forcing it: the probe held at question 1 of a fresh process (so conversation history
is empty and cannot contribute), varying only what Ollama was asked beforehand.
**11 runs, 10 identical answers.** The single divergence was the first run of the session
at 50.1s against a steady-state 31s -- a cold-start outlier, not the residency channel;
the last 8 runs were identical. The reset was confirmed firing from the default (~300ms
per call, logged as `[Determinism] Model state reset before synthesis`).

Two call sites assumed the old default and were corrected rather than left: `mcpServer.ts`
returned `REPOGUIDE_DETERMINISTIC === '1'`, which would have silently kept the headless MCP
path off-by-default forever -- it now follows the shipped default unless explicitly opted
out with `REPOGUIDE_DETERMINISTIC=0`. `QueryPipelineHarness` still pins the value
explicitly; that is now redundant with the default and deliberately kept, so a future
change to the default cannot quietly make the measurement path non-reproducible.
See `src/ollama/modelStateReset.ts`.

### Phase 2 -- "correct citation, wrong belief": NOT built, and here is why

Question 7.5 cited real files and still answered the opposite of the truth (claimed the
PDF export is asynchronous; it is a plain `def` called directly in the route handler).
Before building an evidence-sufficiency check, the actual synthesis prompt was captured
and inspected. **The evidence was sufficient.** The prompt contained the complete route
handler, 3,632 characters of it, untruncated, including verbatim:

```python
    try:
        generate_artisan_report_pdf(
            mission_id=mission_id, ...
        )
```

No `await`, no `BackgroundTasks`, no `run_in_threadpool`. The model had the answer in
front of it. What it did instead was blend that handler with a *different* endpoint's
`background_tasks` usage that was also in the packet, and attribute it to the PDF export.

So the proposed "does the evidence contain the fact needed?" check would have passed here
and shipped the wrong answer anyway. This is the branch-logic family: correct evidence,
wrong inference. **Scope: 3 of 38 delivered answers make an execution-mode claim, and only
1 is wrong** -- the other two are vague or hedged. One instance is not a pattern.
Recommendation: do not chase this further; it is the documented model ceiling, and the
deterministic branch-bypass remains the right answer for the cases that matter.

### Phase 3 -- retrieval-miss abstentions (shipped)

An abstention is the one answer shape that reads as *more* trustworthy the more wrong it
is, and the gate cannot catch it because there is nothing fabricated in it. Measured:
asked where STT confidence averaging lives, RepoGuide said the evidence did not provide
details and advised searching by hand; it is at `app/services/stt_service.py:181`.

`src/query/abstentionVerifier.ts` detects the abstention shape, then asks the real index
whether it knows of a region the packet never contained. **Granularity turned out to be the
whole ballgame:** a first file-level implementation declared `stt_service.py` "already
retrieved" (the packet did contain it -- at line 229) and pointed the user at three
unrelated files. Comparing line ranges instead, run against the recorded failing answer
with the live index, it now names `app/services/stt_service.py:161-191` first -- the range
containing line 181. Only ever downgrades pass -> revise.

### Phases 4 and 5 -- citation checker recall and precision (shipped)

Both in `src/query/citationVerifier.ts`, pulling in opposite directions, verified together
against every recorded answer.

**Phase 4, recall.** The most common real fabrication shape was invisible: a bulleted list
of invented names under a file heading, far outside the 200-character window. Three defects
had to be fixed for the measured `pdf_generator.py` case to be caught at all -- the symbol
pattern rejected leading underscores (`_truncate`), then rejected single-underscore names
with no internal underscore, and finally a bare filename citation could not be resolved
from the workspace root. With anaphoric binding ("*the file* contains...") overriding
proximity, and bare names resolved against the packet's own files when unambiguous, all
**five invented helpers are now caught** (`_truncate`, `_safe_list`, `_get_title`,
`_get_description`, `_get_materials`; the real ones are `_register_font_alias`,
`fmt_craft`, `draw_shell`, `divider`, `section_label`, `wrap`).

**Phase 5, precision.** Proximity no longer reaches across a markdown section boundary. The
confirmed false positive is gone: an answer opening "The `MissionOrchestratorAgent`,
`MissionCoordinator`, and `OrchestratorAgent` classes serve distinct purposes" no longer
has its third name mispaired with the first name's citation. `OrchestratorAgent` is a real
class in `app/agents/orchestrator_agent.py` and the answer never claimed otherwise.

Across all 38 recorded answers: **11 true positives retained, the 6.1 false positive
eliminated, and 5 previously-invisible fabrications newly caught.**

### Phase 6 -- multi-hop file omission (shipped)

`src/query/multiHopCoverageVerifier.ts` flags a trace-shaped answer that never mentions a
file the evidence referenced four or more times. Deliberately narrow: only trace-shaped
questions, only emphatic files, at most three named. This is a post-hoc check rather than
prompt guidance because the cause is the model omitting a file it was handed -- the earlier
budget-truncation diagnosis was retracted after an A/B showed the file was already reaching
the prompt.

### Verification

`npm run lint` 0 errors. **81/81 node:test** across the nine touched areas. Full jest is
load-sensitive on this machine (39 failed suites under parallel workers, 27 under
`--runInBand`, and `runtimeDependencyPhaseB.test.ts` calls `process.exit(1)` which
truncates the summary), so the meaningful check is the nine jest suites that import
anything changed here: **3 failed suites / 4 failed tests, byte-identical before and after
the round.** No suite that imports a changed module regressed.
