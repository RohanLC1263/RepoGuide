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

## 3-model local architecture: measured, partially adopted (2026-07-29)

Three model roles were proposed -- generation, embedding, and a net-new reranking role --
plus one deliberate non-model (the deterministic verification layer, untouched here). The
round was run as build-then-measure, not a blind swap.

### What the brief got wrong about the current state

Confirmed against the code, not assumed: generation `qwen2.5-coder:7b`, planning
`qwen2.5-coder:3b`, embedding `nomic-embed-text`, and no model reranking anywhere on the
retrieval path. The single "rerank" hit is `MemoryReranker`, a heuristic score blender
(source/recency/confidence) on the memory path behind a default-off flag.

Separately: **`repoguide.embeddingModel` was declared in package.json but read nowhere**,
and `inferenceModel` only in one `extension.ts` branch. `getProfile()` returned hardcoded
profile values, so changing either setting did nothing. Making them selectable at all was
a prerequisite for this round, not a feature of it.

### bge-reranker-v2-m3 cannot run on this stack

Not "impractical" -- impossible, for three independent reasons: absent from the Ollama
library (404); Ollama 0.32.5 exposes no rerank endpoint, and its generate/chat/embed APIs
cannot serve a cross-encoder correctly regardless; and the HuggingFace repo ships no ONNX
weights, so `@xenova/transformers` (already a dependency) cannot load it either.

Two ONNX cross-encoders that DO run were shipped as selectable backends and decided by
measurement: `Xenova/bge-reranker-base` and `Xenova/ms-marco-MiniLM-L-6-v2`. Both run on
CPU at **zero VRAM**, which is not incidental -- the card has 8151 MiB and the generator
alone takes ~5.4 GB.

Two implementation details were load-bearing, and both were initially wrong:

- The `text-classification` pipeline cannot express a (query, passage) PAIR, which is the
  entire point of a cross-encoder. It failed with `text.split is not a function`. Fixed by
  dropping to tokenizer + model directly, which also enabled batching.
- Raw cross-encoder output would have made reranking **worse than useless**. A correct top
  hit sigmoids to ~0.002 while the retrieval scores it competes against sit at 0.9-1.0, and
  the packer sorts on `score + 0.75 * lexicalRelevance`. Written through raw, the reranker
  would have been swamped by the lexical term and outranked wholesale by any item outside
  the shortlist that kept its original score. Scores are now spread across [0.3, 1] with the
  unscored tail compressed below.

### Phase 6 results (RUN 1 of 2 -- see the two-run confirmation below)

Three arms differing by exactly one variable; index, generator, embedder and the
determinism reset held constant. Reranking positively confirmed firing
(`Reranked 40/94 items via bge-reranker-base`), zero occurrences with it off.

| | baseline (off) | bge-reranker-base | ms-marco-MiniLM |
|---|---|---|---|
| adversarial suite | 35/37 | **36/37** | 35/37 |
| 38-query pass / block / revise | 14 / 17 / 7 | 15 / 17 / 6 | 21 / 11 / 6 |
| answers delivered | 21 | 21 | 27 |
| median delivered answer length | 2482 | **2650** | 1621 |
| citation violations (count / questions) | 11 on 6 | **6 on 5** | 9 on 4 |
| median latency | 28.2s | 31.4s | 31.4s |
| VRAM added | -- | 0 | 0 |

**minilm's headline number is an artifact and must not be read as a win.** Its pass count
jumps 14 -> 21, but its median delivered answer is **35% shorter** (1621 vs 2482 chars): it
passes more often largely by saying less that can be checked -- the exact trap this project
has documented repeatedly. It also introduced a fabrication the other two arms did not
(`adv-fp-3`, "WebSocket connection streams") and regressed question 3.1 from a correct,
line-quoting answer to a block.

**Baseline's second adversarial failure was infrastructure, not quality**: `adv-det-1`
iteration 3 died with an `AbortError` after 375s. Adjusted for that, baseline and bge have
the same number of content failures, so the raw 35 -> 36 is not the real signal.

### The real signal, and the honest size of it

The defensible improvement from `bge` is **citation violations nearly halving, 11 -> 6, at
identical delivered-answer count and slightly longer answers**. Fewer misattributed
citations with no loss of substance is a genuine quality gain, and it is consistent with the
mechanism: better-ranked evidence surviving the budget cut.

On the two targets this was supposed to fix:

- **Multi-hop omission (`adv-mh-1`): partial, real.** Baseline omitted both
  `mission_service` and `mission_coordinator`; bge recovered `mission_service` and omitted
  only `mission_coordinator`. Still a FAIL (the case requires both), but it moved, and it
  moved in exactly the predicted way.
- **Retrieval-miss-as-abstention (q3.1): no evidence either way.** Baseline *passed* this
  run -- it named `stt_service.py` and quoted the averaging line -- so the failure this was
  meant to fix did not reproduce and there was nothing to improve. bge matched it; minilm
  regressed it to a block.

### Recommendation: adopt partially

- **Adopt `bge-reranker-base`.** Real reduction in misattributed citations, partial movement
  on the multi-hop target, no substance loss, zero VRAM, +11% latency (28.2s -> 31.4s).
- **Do not adopt `ms-marco-MiniLM`.** Kept as a selectable fallback for slower hardware, but
  it degrades answer substance and introduced a new fabrication.
- **Hold `embeddinggemma`.** Pulled and verified at 768 dims (drop-in with the store schema)
  and selectable, but deliberately NOT measured this round: comparing embedders requires
  mutating shared index state across two full re-indexes, and index state is a documented
  confound in this project. It deserves its own round with two isolated indices.
- **Hold `qwen3:8b`, and note a latency problem.** Wired, pulled, and verified serving a
  real query end-to-end (the gate caught a numeric fabrication in its answer, so the whole
  pipeline works with it). Not measured for quality -- the agreed Phase 6 scope was baseline
  + reranker only -- but the smoke run took **115s against 28-58s for qwen2.5-coder:7b**,
  roughly 2-4x slower, consistent with it emitting reasoning tokens. Any future evaluation of
  it has to weigh that against whatever quality it buys.

### Two-run confirmation (2026-07-30)

Run 1 rested on one pass per arm, which this project has direct proof can flip. Baseline and
bge were re-run on both suites, same held-constant setup. **The second run confirms the
adoption, and corrects the size of the headline.**

| | run 1 off | run 1 bge | run 2 off | run 2 bge |
|---|---|---|---|---|
| adversarial | 35/37 | 36/37 | 36/37 | **37/37** |
| 38-query pass/block/revise | 14/17/7 | 15/17/6 | 13/13/12 | 17/15/6 |
| answers delivered | 21 | 21 | 25 | 23 |
| median answer length | 2482 | 2650 | 2459 | 2322 |
| citation violations | 11 on 6q | 6 on 5q | 18 on 10q | 14 on 9q |
| median latency | 28.2s | 31.4s | 32.8s | 30.1s |

**The direction replicates; the magnitude does not.** bge reduced citation violations in both
runs, but by 45% in run 1 and 22% in run 2, and the absolute counts moved a lot between runs
for BOTH arms (baseline 11 -> 18). Combined across the two runs: **29 violations on 16
questions for baseline vs 20 on 14 for bge, a 31% reduction.** The original "nearly halved"
was a run-1 artifact and is superseded by that combined figure.

**Both mechanism-level targets confirmed, and one produced a decisive data point run 1 could
not:**

- **Multi-hop (`adv-mh-1`): improved in 2/2 runs.** Baseline failed it in both (run 1 missing
  both files, run 2 missing `mission_service`). bge partially recovered it in run 1 and
  **passed it outright in run 2** -- which is also why run 2's bge arm scored a clean 37/37.
- **Retrieval-miss (q3.1): reproduced and fixed.** Run 1 gave no evidence because baseline
  happened to answer it correctly. In run 2 the failure DID reproduce under baseline -- it
  abstained, named neither `stt_service` nor the averaging line, and the Phase-3 abstention
  verifier correctly flagged it as a retrieval gap. **bge answered it correctly**, naming the
  file and quoting the line. One clean data point, in the predicted direction.

**Latency: no reliable penalty.** Run 1 showed +11% (28.2 -> 31.4s); run 2 showed bge *faster*
than baseline (32.8 -> 30.1s). The earlier "+11% cost" claim does not survive two runs -- the
difference is inside run-to-run noise.

**Answer parity holds.** bge delivered 21 vs 21 in run 1 and 23 vs 25 in run 2, with median
length within 6% of baseline both times. It is not drifting toward the minilm shorter-answer
pattern (which was -35%).

**Verdict: confirmed on two runs. `bge-reranker-base` stays the default.** The adoption is no
longer single-run evidence. The honest headline is a ~31% reduction in misattributed citations
plus replicated improvement on both targeted failure modes -- not the 45% run 1 suggested.

## Session-variance investigation: CLOSED (2026-07-31)

The tracker still listed the three fixes as pending. **All three shipped in `7247f579`**, and
the code confirms it -- checked independently rather than trusted:

1. **History character cap: shipped and wired.** `MAX_HISTORY_CHARS = 4000` with
   `trimToCharBudget()` called from `add()`, alongside the existing 10-message cap, and
   `historyChars` still feeds `deriveEvidenceBudgetChars`, so the cap constrains the real
   budget rather than sitting unused.
2. **Seed pinning: shipped, and complete on the paths that matter.** `DETERMINISTIC_SEED = 42`
   on both `INFERENCE_MODEL_OPTIONS` and `PLANNING_MODEL_OPTIONS`. An audit of every Ollama
   call site did find three that pass no options at all (`qaGenerator`, `synonymNormalizer`,
   `ollamaClient`) -- but an import-graph walk shows **none is reachable from `queryDispatcher`
   or `mcpServer`**. They are background cache generation, comprehension indexing, and the
   orphan with zero callers. Intent classification, strategy routing and synthesis are all
   seeded. Seed pinning was NOT the gap.
3. **stdout fix: shipped.** No `console.log` in any query-path module; the reachability test
   passes and a live MCP query yields 6 valid JSON-RPC lines and 0 non-JSON.

### The system is now reproducible -- proven, not asserted

Two back-to-back baseline runs of the full 38-query set, identical configuration:
**38/38 identical answer text and 38/38 identical gate outcomes.** Both also matched the
Phase 6 run-2 baseline exactly (13/13/12, 25 delivered, 18 violations on 10 questions). Three
independent full-suite runs, byte-identical.

### What actually caused the Phase 6 baseline spread: a reindex, not noise

Phase 6 run 1's baseline differed from the other three on **all 38 questions, diverging at
question 1** -- before any conversation history could accumulate, which rules out the residual
history-content cascade. Retrieval was identical (15 items packed / 81 dropped / 5 truncated,
43 facts / 442 dropped in every run); only the prompt scaffolding differed, by 139 characters.

The timeline settles it:

| when (UTC) | event | index |
|---|---|---|
| 2026-07-29 16:27 | Phase 6 run 1 baseline | built 2026-07-25 |
| **2026-07-30 14:16** | **full reindex** (1792 chunks, 391 files) | -- |
| 2026-07-31 09:33 | Phase 6 run 2 baseline | built 2026-07-30 |
| 2026-07-31 10:47 / 11:05 | back-to-back baselines a / b | built 2026-07-30 |

**A full reindex of CraftConnect happened between the two Phase 6 executions.** Every run on
the newer index agrees byte-for-byte; the single run on the older index is the outlier. This is
the index-state confound this project already documented -- not a fourth variance source, and
not a failure of the three fixes.

**The Phase 6 conclusion survives.** Each run compared its two arms against the *same* index, so
the bge-vs-baseline comparison was fair within both runs, and bge reduced citation violations in
both. That it replicated across two different corpus states is arguably stronger evidence than
two runs on one. The one figure to treat with care is the pooled 29-vs-20 count, which mixes
two indices; the per-run deltas (-45%, -22%) are the sounder statement.

### Verification standard going forward

Every measurement in this project must record the index build timestamp
(`.repoguide/meta.json` -> `lastFullIndexAt`) alongside its numbers, and any before/after
comparison must confirm both arms ran against the same index build. Two runs separated in time
are not comparable on that basis alone. Within a fixed index and fixed configuration the
pipeline is now byte-reproducible, so an unexplained difference between runs should be treated
as a changed input -- index, configuration, or model -- and hunted as such, rather than
written off as model nondeterminism.

## MCP surface audit (2026-07-31)

Whole-surface pass after the determinism and reranker work. Driven by a confirmed *pattern*:
two bugs this session were `mcpServer.ts` silently diverging from a shipped default
(`resetModelBeforeSynthesis`, then the reranker backend), both because the MCP server read its
own fallback rather than tracking the setting everyone else used.

### Solid

- **Settings divergence: no new instances on the MCP query path.** Every declared
  `repoguide.*` setting was compared against what the MCP path actually falls back to. The
  shim returns each *call site's* hardcoded fallback, so divergence lives at call sites, and
  every query-path one now matches its declared default. Both previously-found bugs are fixed.
- **Determinism and reranker parity is structural, not coincidental.** `mcpServer.ts` contains
  no inference code at all -- no `streamChat`, no `INFERENCE_MODEL_OPTIONS`, no direct Ollama
  call. It delegates entirely to `QueryDispatcher`, so it cannot drift into "a second, different
  configuration for a different path" the way the history-aware path once did.
- **Concurrency is clean.** Six tools fired simultaneously resolved in 5.2s with 6/6 distinct
  responses, each containing its own subject. No cross-contamination, no stale results.
- **Deterministic graph tools repeat byte-identically** on a repeated call.
- **Protocol purity holds**: 0 non-JSON lines on stdout across the whole audit.
- **Malformed input degrades cleanly**: empty, missing and wrong-named arguments produce clean
  tool-errors, never a crash or a hang. No timeouts anywhere in the audit.
- **Both prior content-size fixes still hold**: `trimEvidenceItemsForMcp` is still applied in
  `get_facts`, and `capReferencesByKind` is still applied per entry in `get_last_chat_evidence`.
- **`gather_evidence` is COMPLETE, not in progress** (see below).

### Fixed this round

**Pathological identifiers were echoed back at full length.** `get_dependents` with a
10,000-character junk symbol returned the correct `found: false` verdict inside a
**20,258-character** payload, because the identifier is echoed twice -- as `requestedSymbol`
and inside `message`. Sixty times the size of the same answer for an ordinary unknown symbol.
Capped via `truncateIdentifierForEcho`, applied in both the dependents and dependencies
builders. Verified live: **20,258 -> 704 chars**, with `found: false` preserved, the ordinary
unknown case unchanged at 300 chars, and a real symbol unchanged at 2,170 chars / 4 dependents.
Two tests added; 60/60 MCP tests pass.

### Flagged, deliberately not fixed

1. **`get_facts` returns unrelated facts for a term that matches nothing.** Querying
   `NoSuchSymbolZZZ` returned **49,762 characters** of facts about unrelated symbols, and the
   response does not contain the query term anywhere. A calling model receives 50KB of
   confident-looking facts with no signal that nothing matched -- a plausible fabrication
   trigger. NOT fixed here because `get_facts` delegates to
   `queryDispatcher.retrieveRawEvidence`, which the Chat path also uses; changing its no-match
   semantics is a shared-retrieval change, not an MCP-local one.
2. **`get_last_chat_evidence` returns ~154,753 characters by default** (10 entries, the
   writer's `QUERY_EVIDENCE_MAX_ENTRIES` cap). Roughly 38k tokens in a single tool result.
   This is a *documented deliberate choice* -- `parseLimitArgument` explicitly prefers "no
   limit" over "an arbitrary default" -- so it is reported with the measurement rather than
   silently overridden. Worth revisiting: a default of 2-3 entries would leave explicit
   `limit` callers unaffected.
3. **Latent divergences outside the MCP path.** `excludePatterns` is declared with 19 entries
   but every call site passes `[]` as its fallback, and `embeddingModel` is declared
   `nomic-embed-text:latest` while the profile default is `nomic-embed-text` (functionally
   identical to Ollama, cosmetically divergent). Neither affects MCP -- `indexManager` is not
   reachable from `mcpServer` -- but both would bite any future headless indexing path.
4. **Four settings are read but never declared** in `package.json`, so they cannot be set
   through the UI: `memory.bridge.enabled`, `enableChatNoteDistillation`,
   `enableDailyBriefOnStartup`, `queryArchitecture`.
5. **Argument naming is inconsistent across tools**: `ask_repoguide` takes `question`,
   `get_facts` and `retrieve_raw_evidence` take `query`, and `gather_evidence` accepts either.
   This audit's own harness tripped on it and produced a false cross-contamination reading
   until corrected. The `gather_evidence` alias is the right pattern; the others lack it.

### Evidence-gathering tool status: DONE, tracker was wrong

The tracker listed this as open and in progress. The code shows it complete: `gather_evidence`
returns structured `deterministic_facts` / `retrieved_code_context` / `coverage` with an
explicit assistant-role contract in code ("for an external model to reason over and answer
itself... deliberately no answer"), a markdown builder with a plain-language grounding
indicator, an MCP Apps (SEP-1865) `ui://` card resource, 8 tests, and a `query`/`question`
alias. Verified live this session returning real cited evidence with no synthesized conclusion.

**This is the second tracker status proven wrong in one session** (the three session-variance
fixes were the first). Treat tracker status on "is X shipped" as unverified until checked
against the code.

### Known ceilings, surfacing unchanged through MCP

Branch-logic inversion, correct-citation-wrong-belief, and inbound-dependency prose fabrication
all surface through the MCP path exactly as through Chat -- same `QueryDispatcher`, same gate.
The `ask_repoguide` tool description already routes callers to `gather_evidence` for
branch-logic questions, which is the correct existing mitigation. Not re-attempted.

## MCP surface: audit findings fixed (2026-07-31)

All five items from the audit above, in priority order. One audit finding is corrected below.

### Correction to the audit

The audit claimed `get_facts` "delegates to `retrieveRawEvidence`, which the Chat path also
uses." **That was wrong.** `retrieveRawEvidence`'s only production callers are the four MCP
tools; the Chat path builds its packet through `buildPacket`. Both share
`retrievalOrchestrator.execute()` one level down, but the fix below is MCP-local and cannot
alter Chat retrieval -- which made Phase 1 considerably lower-risk than the audit implied.

### Phase 1 -- structured no-match signal

`get_facts` and `retrieve_raw_evidence` now return a `relevance` field alongside their
payload: `{ verdict: 'exact' | 'partial' | 'none', matchedItems, totalItems, queryTerms, note }`.
Deterministic, no model involved -- an item counts as relevant if a significant query term
appears in its symbol, path or content; `exact` additionally requires the symbol to BE the
term. A caller branches on `verdict === 'none'` rather than parsing prose, matching the
deterministic-check pattern used elsewhere in this project.

Verified live: `get_facts("NoSuchSymbolZZZ")` -> `verdict: none, matched 0/50`;
`get_facts("MIN_RESOLUTION_PX")` -> `verdict: exact, matched 3/50`;
`retrieve_raw_evidence("NoSuchSymbolZZZ")` -> `verdict: none`. The facts payload is unchanged
in both cases (50 items still returned) -- the signal is additive, so nothing that worked
before returns less. 8 tests.

### Phase 2 -- bounded default for get_last_chat_evidence

Default entry limit is now 3. Verified live: **no `limit` argument 154,754 -> 51,588 chars
(3 entries)**; `limit: 10` still returns 10 entries / 154,754 chars, so explicit callers are
untouched -- confirmed in code, not just in the doc comment. A pre-existing test that pinned
the old "return everything" behaviour was updated rather than left contradicting the change.
3 tests added.

### Phase 3 -- latent divergences fixed at source

`excludePatterns`: every call site passed `[]` as its getConfig fallback. Under the real VS
Code host the declared default came back, but every shimmed host (MCP server, evaluation
harness) returns the CALLER's fallback -- so those paths saw **no exclusions at all** and
would have indexed `node_modules`, `.venv` and `dist`. Now falls back to
`DEFAULT_EXCLUDE_PATTERNS`, verified byte-identical to the 19 entries package.json declares.

`embeddingModel`: package.json declared `nomic-embed-text:latest` while the profile default
was `nomic-embed-text`. Aligned to `nomic-embed-text` (what the index actually records).
Verified: package.json and `getProfile()` now agree.

### Phase 4 -- undeclared settings: three declared, one deleted

Not all four were worth declaring:

- `memory.bridge.enabled`, `enableChatNoteDistillation`, `enableDailyBriefOnStartup` each gate
  a real feature and were unreachable through the UI. **Declared**, each off by default.
- `queryArchitecture` was **dead**: the two shims answered it, and nothing anywhere calls
  `getConfig('queryArchitecture')`. **Both branches removed** rather than declaring an
  invisible knob for a question nobody asks.

### Phase 5 -- argument naming

`query` is canonical across the server. Every free-text tool accepts it (`ask_repoguide` now
takes `query` with `question` kept as an alias; `gather_evidence` already had both;
`get_facts` and `retrieve_raw_evidence` already used it). The graph tools keep `symbol` --
the semantically correct name for them -- but also accept `query`, so a caller who guesses
the canonical name gets an answer instead of a silent argument error. Verified live: all four
combinations of `symbol=`/`query=` on both graph tools return `found: true` with identical
item counts. Schema descriptions now name the canonical argument and point at the new
`relevance` field.

### Regression after all five

`npm run lint` 0 errors. **104/104 MCP tests pass.** Concurrency re-run: six tools fired
simultaneously resolved in 6.6s, 6/6 distinct sizes, each containing its own subject.
Malformed input still degrades cleanly (empty/missing arguments -> clean tool-errors; the 10k
junk symbol stays capped at 705 chars). Protocol purity: **0 non-JSON stdout lines**.

### Verdict: is the MCP feature reliable to depend on?

**Yes for the deterministic surface, with one honest caveat on the synthesized one.**

*Solid, and now verified rather than assumed:* the graph tools (`get_dependents`,
`get_dependencies`) are deterministic, repeat byte-identically, correctly report `found: false`
for unknown symbols, and are the right tool for impact analysis. `gather_evidence` is complete
and is the strongest thing on this surface -- cited, ranked evidence with an explicit grounding
indicator and no synthesized conclusion, so the calling model does the reasoning. Concurrency
is clean. Malformed input never crashes or hangs. Nothing writes to the JSON-RPC transport.
Configuration parity with the Chat path is now structural rather than coincidental.

*What genuinely changed this round:* a caller can now tell the difference between "here is your
evidence" and "here is what we found instead", which was previously invisible and is the single
most fabrication-prone gap on this surface. Two silent size hazards (154KB default response,
20KB echoed junk) are bounded. A setting that silently did nothing on every headless path now
works.

*Still a known limitation, unchanged and out of scope:* `ask_repoguide` inherits all three
model ceilings -- branch-logic inversion, correct-citation-wrong-belief, and inbound-dependency
prose fabrication -- identically to the Chat panel, because it is the same dispatcher and the
same gate. Its own tool description already routes callers to `gather_evidence` for
branch-logic questions, which remains the correct mitigation. **The honest guidance for an
external agent is unchanged: prefer `gather_evidence` and the graph tools, and treat
`ask_repoguide` as a quick take rather than an authority.**

## Inbound-dependent fabrication: root-caused and closed for file-scoped claims (2026-08-04)

The "Still open" item from the 2026-07-25 trust round (chat inventing INBOUND dependents in
prose) is now closed for the shape that produced every recorded instance. Two findings
reframed it before any code was written.

### Finding 1 — it is two failure classes, not one

Verified by grep over real CraftConnect source:

- **Class A, TRUE ABSENCE.** All seven instances named in the 2026-07-25 entry
  (`ArtifactManager` claimed in community_engine.py / studio_read.py / studio_write.py /
  auth.py; `RAGRetrieverAgent` in conversation_agent.py / explanation_agent.py /
  auth_validator_agent.py) have **0 occurrences** of the claimed symbol.
- **Class B, DIRECTION INVERSION.** The recorded `adv-hot-3` answer named ten callers of
  `execute`. Every one has exactly one `def execute` and **zero call sites** — the token IS
  present, so a textual-absence test cannot see it. The model enumerated a method's DEFINERS
  and narrated them as its CALLERS. The sole real caller is `base_agent.py:171`
  (`output = await self.execute(inputs)`), which the answer never mentions.

Class B matters because it invalidates the obvious fix: "does the claimed file mention the
symbol at all" would have passed all ten fabricated claims.

### Finding 2 — the permanent regression suite was scoring the fabrication as a PASS

`adv-hot-3` carried no `mustNotContain` and no `required`, so `scoreAnswer` returned zero
violations. Worse, the obvious repair (`required: ["base_agent"]`) would ALSO have passed it:
`MentorInsightRenderer` appends a deterministic Change Impact block after the model's prose,
and that block — which is graph-derived and correct — names `base_agent` at index 2941 and
`BaseAgent` at 3116 of a 3199-char answer whose prose never mentions either. **RepoGuide's own
correct output was answering on the model's behalf.**

Fixed by scoring the model's prose only (`src/evaluation/modelProse.ts`, `modelProseOnly()`,
stripping the four renderer headers) before applying any marker. Replayed over all 37 recorded
answers: `adv-hot-3` flips PASS → FAIL; `adv-hot-1` and `adv-hot-2` (genuinely accurate) stay
PASS; no other case changes verdict. A sync test reads `mentorInsightRenderer.ts` and asserts
the header list matches, so a newly-added insight block cannot silently reintroduce the leak.

### The check: read the file, not the graph

`src/query/relationClaimVerifier.ts`, wired as AnswerGate check 6c. For a claim "`<file>`
calls/uses `<symbol>`": read the file, strip comments and string literals, remove
definition-position occurrences (`def X`, `class X`, `function X`, `func X`), and flag if
nothing remains — reported as `absent` (Class A) or `defines` (Class B).

Stripping is load-bearing on real data: `base_agent.py` names `execute` twice in its module
docstring before the real call, and `story_gen_agent.py:41` contains
`logger.warning("StoryGenAgent.execute() called on deprecated agent")` — a string that reads
exactly like a call site and would otherwise mask a real Class B fabrication.

**Why this does not repeat the withdrawn symbol-usage check.** That one asked the program
graph, and framework wiring produces no edge, so genuinely-used symbols were flagged —
`app.add_middleware(ObservabilityMiddleware)` being the canonical case. Asking the FILE gets
that right: main.py textually contains the symbol in code position, so it is not flagged. The
check therefore inherits neither the ~38%/13% inbound-edge precision wall nor
ProgramGraphStore's lowercased bare-name collisions (where `execute` unifies every agent
method with sqlite3's `cursor.execute`).

**Safety property:** only claims that NAME THE FILE are verified, so the file to read comes
from the answer itself — there is no symbol→file resolution step and no resolution ambiguity.
Every ambiguity resolves toward NOT flagging: an unrecognised definition form survives
stripping, counts as a use, and the claim passes.

### Measured result

Against the real recorded answers and real CraftConnect source, through the compiled gate:

| case | claims detected | violations |
|---|---|---|
| `adv-hot-3` (10/10 verified fabricated) | 10 | **10 flagged** |
| `adv-hot-1` (6/6 verified accurate) | 4 | **0** |
| `adv-hot-2` (3/3 verified accurate) | 0 | **0** |

Detection is deliberately two-pass: clause-local catches 9 of 10, and a list-item-scoped pass
catches the tenth, whose file is named in the item's first sentence and whose assertion lands
in the second ("...which ultimately depend on the `execute` method" — note the bare "depend",
which a `depends`-only pattern cannot match). The item pass fires only when an item names
exactly one distinct file; two or more is genuinely ambiguous and is skipped rather than
guessed at.

Because the check needs only `workspaceRoot` and not a graph handle, it also covers the
DECOMPOSED path (`subAnswerMerger.ts:75`, `subTaskRetry.ts:46`) — gate call sites that pass no
`graphLookup` and are therefore invisible to check 6b, despite being the shape a broad "what
depends on X" question is most likely to take.

### Still open

Relation claims that name no file, anaphoric subjects ("it uses this instance"), and ordering
claims ("A runs after B"). The file-reading oracle cannot adjudicate any of these. Recorded in
LIMITATIONS.md §2.1 as partially closed rather than closed.

Verification: `npm run compile` clean, `npm run lint` 0 errors, relationClaimVerifier 18/18,
answerGateFileUsage 12/12, answerGate.contentVerification 64/64, modelProse 6/6,
mentorInsightRenderer 7/7.

## Script-role files produced ZERO logical units — root-caused and fixed (2026-08-04)

The second "Still open" item from the 2026-07-25 trust round — "the program graph under-reports
at least one real dependent", found incidentally when `scripts/craftconnect_cli.py:68` did
`MissionOrchestratorAgent(use_mock_llm=True)` yet was absent from
`get_dependents("MissionOrchestratorAgent")` — is fixed. It was never a graph-construction
defect. The file was never in the graph at all.

### Root cause

`logicalUnitExtractor.ts` routed any `isNonSourceRole(role)` file to
`extractUsefulNonSourceUnits(...)`. That function handles `'config'` and `'docs'`, then
`return []`. `isNonSourceRole` also includes `'script'` — so **every file classified `script`
extracted to zero logical units**, silently. No units means no graph nodes, no facts, and no
retrievable evidence: the file is invisible to every question asked about the repository.

`classifyFileRole` assigns `script` to anything under `scripts/`, `tools/`, `bin/` or `cli/`
(`SCRIPT_COMPONENTS`), regardless of language. CLI entry points, migrations and build tooling
are ordinary Python and TypeScript, so this discarded real source.

**Measured on CraftConnect:** 39 of 44 files under `scripts/` had zero units. The five
survivors were not a partial success — they were misclassified as `test` by the content
heuristic (`verify_*.py`, `init_storage.py`), which is not a non-source role, so they took the
normal path. That accident is why the defect looked arbitrary rather than systematic.

Two hypotheses were tested and rejected before the real one was found, both against real data:
CRLF line endings (both the missing and the present files are CRLF) and the 2000-file walk cap
(only 361 files were in the graph). The discriminator turned out to be the file PATH, not its
content: the same source yields 5 units as `t.py` and 0 as `scripts/craftconnect_cli.py`.

### Fix

`script` is a ROLE, not a verdict on whether a file contains parseable code. Script-role files
in a language the extractor can handle (`python`/`typescript`/`javascript` or
`SOURCE_LANGUAGES_WITH_GENERIC_REGEX`) now take the normal source path. Scripts in languages
with no detectable source structure (`.sh`, `.bat`, `.ps1` — `detectLanguage` returns null)
keep the previous behaviour. `role` is still recorded as `script`, so retrieval prioritisation
is unchanged; only extraction changed.

### Verified end to end

| stage | before | after |
|---|---|---|
| `scripts/craftconnect_cli.py` units | 0 | **5** (`cli_logger`, `main`, `run_analyze`, `print_report`) |
| `scripts/*.py` with ≥1 unit | 5 / 44 | **43 / 44** (holdout is a 0-byte file) |
| instantiation fact at the ROADMAP's line | absent | **`run_analyze -> instantiates MissionOrchestratorAgent (L68)`** |
| `.sh` / `.bat` under `scripts/` | 0 units | 0 units (unchanged) |

The fact is what `ProgramGraphBuilder` consumes to emit an `instantiates` edge, so
`get_dependents("MissionOrchestratorAgent")` now has the evidence it was missing.

5 regression tests added to `src/test/logicalUnitExtractor.test.ts` covering all four
script-component directories, role preservation, the unparseable-language carve-out, and
docs/config being unaffected.

Verification: compile clean, lint 0 errors, logicalUnitExtractor 16/16, fileRoleClassifier 5/5,
factExtractor 4/4, logicalUnitStore 6/6, programGraphBuilder 2/2.

### Note for the next reindex

Existing `.repoguide` indexes were built with the defect and still omit script files. The
numbers above are from running the extractor directly; a full reindex is required before a live
`get_dependents` query reflects them. Any previously-recorded self-index node/edge/fact counts
predate this fix and will rise.

## Import-edge resolution + package-initialiser false positive (2026-08-04)

Software defect #4 — "import graph under-captures framework-wired reachability". Investigating
it against real CraftConnect turned up a different and larger root cause than the framework
wiring the backlog entry described, plus one measurement error of my own worth recording.

### Root cause 1 — import edges were a basename substring guess

`programGraphBuilder.ts` resolved an import edge by scanning file nodes in insertion order and
linking to the FIRST whose basename appeared anywhere in the import text, then breaking:

- **Package files were unreachable.** A package's basename is `__init__`, and that string
  occurs in no import statement, so no import edge could ever point at an `__init__.py`.
- **Short basenames produced wrong edges.** `from . import auth` matched `app/core/auth.py`
  purely because "auth" occurs in the text, regardless of the importing file's directory.

Replaced with real module-path resolution (`src/graph/importResolver.ts`): dotted Python paths
and relative TS/JS specifiers map to concrete candidate files (`<path>.py`,
`<path>/__init__.py`, `<path>/index.ts`), relative imports are anchored to the importing file's
own directory, and `from pkg import submodule` resolves to both the package and the submodule.
Unresolvable imports now yield NO edge, which is correct for stdlib and third-party modules.

Measured on CraftConnect: `app/llm_backends/__init__.py` 0 → 10 importers,
`app/schemas/marketplace_readiness.py` 0 → 4.

### Root cause 2 — package initialisers are imported implicitly

`app/agents/__init__.py` still reports zero importers after the fix, and that is CORRECT: it
has **0 direct `from app.agents import ...` statements** and 119 submodule imports beneath it.
Python executes the package initialiser on every one of those, so the file is thoroughly live
while having no direct importer any graph could record. Same shape for
`craft_classifier_agent/__init__.py` (0 direct / 16 submodule) and `app/database/__init__.py`
(0 direct / 2 submodule).

This is a language-semantics property, not a missing edge, so it is handled where entry points
already are — `PACKAGE_INITIALISER_BASENAMES` in `deadFileDetector.ts`, covering `__init__.py`,
`index.ts/js/tsx/jsx` and `mod.rs`. Files with 0 external importers and no framework-wiring
exemption fell 36 → 33 of 140.

### Correction to an earlier measurement in this investigation

An intermediate note in this session claimed `app/agents/__init__.py` had "68 real importers".
That was wrong — an artefact of a regex (`from\s+app\.agents(\s|\.)`) that also matched
`from app.agents.base_agent import ...`, i.e. submodule imports. The true direct count is 0.
The conclusion survived the correction but the mechanism changed completely: from "the graph is
missing 68 edges" to "zero direct importers is correct here, and the dead-code heuristic must
know that". Recorded because the wrong number would otherwise look like supporting evidence.

### What was deliberately NOT built

The framework-registration edges (`include_router`/`add_middleware`) and the DI-container
resolver from the 2026-07-24 "Richer graph edges" scoping remain unbuilt, per that entry's own
recommendation. Verified empirically that the shipped gate-level mitigation already covers the
real cases: all 7 CraftConnect `APIRouter` files, the middleware, and `main.py` return true
from `isEntryPointOrFrameworkWired`, while the genuinely dead `community_engine.py` correctly
returns false.

### Still open

33 of 140 CraftConnect `.py` files have zero external importers and no exemption. That set has
not been triaged file-by-file; an unknown share is genuinely dead code (which the caveat is
supposed to flag) and the remainder is other resolution gaps. Quantifying that split is the
natural next step if this defect is revisited.

Verification: compile clean, lint 0 errors, importResolver 10/10, answerGateFileUsage 12/12,
relationClaimVerifier 18/18, programGraphBuilder 2/2, logicalUnitExtractor 16/16.

## Evidence-sufficiency gate check (2026-08-04)

Software defect #5 — "`ask_repoguide` gate does not check coverage/evidence-sufficiency"
(Codex audit, ROADMAP ~line 499): `gateStatus: pass` could co-occur with essentially no
retrieved evidence, so a barely-grounded answer presented as a clean pass.

### Why the obvious fix was wrong, and what the codebase already knew

The audit framed this around `coverageScore`, and gating on that score is the intuitive fix.
It would have been a mistake, and the evidence was already in the repo:
`src/mcp/gatherEvidenceResponseBuilder.ts` deliberately routes AROUND the score and says why —
`coverageScore` is `matchedRequiredEvidence / requiredEvidence` and is 0 whenever a plan
enumerates no required evidence, **measured at 9 of 12 answers scoring 0 across a real
CraftConnect batch, several of them correct**. A gate keyed on it would fire constantly on good
answers, which is the over-blocking class this project has already reverted checks for twice.

Two contributing defects in the score itself, confirmed but deliberately NOT changed here:
- `evidencePacketBuilder.ts:669` returns **0** when `requiredEvidence` is empty. Semantically
  that is "not applicable", not "no coverage", and several non-main planning paths
  (`executionPlanner.ts:430`, `investigationEngine.ts:535/580`, `planAnalyzer.ts:407`) pass an
  empty list.
- The planner emits `'structured gaps'` for `unknown` query type and the matcher has no case
  for it, so those queries score 0 unconditionally. 17 of the other 18 requirement strings do
  match.

Both are left alone on purpose: `coverageScore` has live consumers (MCP response payload,
report writers) and check 7 keys conceptual-mode behaviour on `< 0.5`, so changing its
semantics has a far wider blast radius than this defect warrants. Logged here instead.

### The fix

New AnswerGate check 6d, keyed on actual grounding VOLUME (`facts.length + items.length`),
reusing the `sparse` threshold already validated in `gatherEvidenceResponseBuilder.ts` so the
Chat gate and the MCP evidence card cannot disagree about what "thin" means. Below 3 retrieved
sources the answer gets a prominent caveat and `pass` becomes `revise`.

Deliberately `revise`, never `block`: thin evidence makes an answer low-confidence, not false.
An answer already acknowledging a gap is skipped — it is being honest and does not need a
second warning.

Verified behaviour: 0/1/2 sources → `revise` + caveat; 3 and 10 sources → clean `pass`, no
caveat.

### Test-fixture consequence, and why it is not churn

26 existing gate tests failed on the first run because their fixtures pass `packet([])` — zero
evidence — while isolating some other check. That is precisely the state this check exists to
flag, so the fixtures were padded with content-free baseline items (volume without text any
content-matching check could accidentally satisfy) rather than the check being weakened. A
`{ thin: true }` opt-out was added for tests that specifically exercise thin grounding.

Verification: compile clean, lint 0 errors, answerGate.contentVerification 69/69 (5 new),
answerGateFileUsage 12/12, relationClaimVerifier 18/18, importResolver 10/10.

### Relationship to defect #6

#6 ("fabrication → refusal is non-deterministic; the real fix is a graceful insufficient-evidence
state") is the same design area. 6d supplies the deterministic thin-grounding signal that state
would be built on, but does not by itself make the refuse-vs-hedge UX consistent — that remains
open.

## Deterministic insufficient-evidence state (2026-08-04)

Software defect #6 — "fabrication → refusal is real but non-deterministic" (Codex audit,
ROADMAP ~line 506).

### Root cause

The system had no concept of "insufficient evidence" as an answer state. It had `block`
("a claim failed verification") and `pass`. Which of those an UNGROUNDED question landed in
depended on whether the model happened to emit a **verifiable artifact**: fabricate a code
fence and a checker catches it, producing a refusal (reproduced 5/5 on the
`community_engine.py` dead-code question); hedge in prose instead and there is no number,
quote, fence or path to check, so the same unanswerable question passes with a vague answer.
Identical underlying condition, opposite UX, decided by an accident of phrasing.

Compounding it, four near-duplicate refusal strings existed across the block sites in
`queryDispatcher` (lines 437, 814, 922, 947), each concatenating
`gateResult.diagnostics.join(', ')` — internal checker jargon — straight into user-facing text.
A real recorded instance is preserved in `docs/engineering-log/DOGFOOD_TEST_REPORT.md:69`:
asked where the FastAPI app is instantiated, the user got *"the evidence pipeline was unable to
find exact evidence... Gap: Unsupported numeric claim: 147"* — for a question `app/main.py`
plainly answers.

### Fix

`src/query/withheldAnswer.ts` separates the REASON for withholding from its PRESENTATION,
because two genuinely different situations were collapsed into one message:

- **`insufficient_evidence`** — retrieval found little or nothing. The honest answer is "I don't
  have enough evidence", and the model did nothing wrong. Message names the real source count
  and points at the two plausible causes (not indexed yet, or under an excluded path). Carries
  no diagnostics.
- **`verification_failed`** — retrieval found ample evidence and the answer contradicted it. A
  real catch, stated plainly, with ONE specific reason (truncated at 180 chars) instead of the
  whole diagnostic list.

Classification is keyed on grounding VOLUME, importing `THIN_GROUNDING_MIN_SOURCES` from
`answerGate` rather than redeclaring it, so the withheld message and check 6d can never
disagree about what "thin" means. Deliberately NOT keyed on `coverageScore` — 0 for most
queries by construction, so it cannot distinguish these two cases.

All four block sites now render through it. The decomposed path aggregates facts/items across
ALL sub-answers before classifying, since any single sub-packet understates what the question as
a whole retrieved.

### The consistency guarantee, pinned by test

With no grounding, the message is now byte-identical whether the model fabricated or hedged —
asserted directly in `withheldAnswer.test.ts` ("the ungrounded case reads the same regardless of
WHY it was withheld"). That is the defect, closed at its root rather than papered over.

Combined with check 6d, an unanswerable question now behaves consistently across all three ways
it can arrive: blocked-after-fabricating, blocked-after-verification-failure, and
delivered-but-thin all state the same thing in the same words.

### Test-fixture updates

Two suites pinned the old wording and were updated rather than worked around:
`askRepoguideTokenProcessor.test.ts` (used the refusal only as a token-stripping fixture) and
`queryDispatcherEvidenceExport.test.ts` (now asserts on a `WITHHELD_MARKERS` list covering both
shapes, so it cannot rot against future wording changes).

Verification: compile clean, lint 0 errors, withheldAnswer 8/8 (new), askRepoguideTokenProcessor
8/8, answerGate.contentVerification 69/69, answerGateFileUsage 12/12, relationClaimVerifier
18/18, importResolver 10/10, modelProse 6/6, logicalUnitExtractor 16/16, programGraphBuilder 2/2.

### Still open

The gate-status chip still shows `block` for an insufficient-evidence case. The message is now
right, but the chip arguably should distinguish "couldn't verify" from "nothing to verify
against" — a UI change, not a correctness one.

## First-run false-success: empty-index guard made absolute (2026-08-04)

Software defect #7 (ROADMAP ~line 465, "False-success bug"). Closed.

### Root cause

The empty-index guard was RELATIVE. `lanceStore.ts:411` and the MiniSearch-family stores all
read:

    if (previousChunkCount > 0 && newChunkCount === 0) { abort; return false; }

`previousChunkCount > 0` is false on a first run by definition, so the guard was *structurally
unable to fire* in exactly the situation it was meant to cover. A workspace whose embedding
calls failed during its first index committed a zero-chunk index, `forceFullReindex()` reported
success, and nothing downstream could distinguish "genuinely empty repository" from "embeddings
were unreachable and nothing got chunked".

The generation-swap machinery added earlier was working correctly; it simply had no signal to
act on when there was no prior generation to protect.

### Fix

The guard now takes a second, ABSOLUTE signal. `IndexManager.fullIndex()` records
`lastWalkedFileCount`, and `forceFullReindex()` passes `expectedNonEmpty = lastWalkedFileCount > 0`
into `commitRebuild(previous, expectedNonEmpty)`:

    if ((previousChunkCount > 0 || expectedNonEmpty) && newChunkCount === 0) { abort; }

"Files present, zero chunks produced" is now refused as the pipeline failure it is, while a
genuinely empty repository still commits cleanly. The parameter defaults to `false`, so every
existing caller keeps the previous relative behaviour unchanged.

Threaded through all four stores: `lanceStore`, `bm25Store`, `logicalUnitBm25Store`,
`segmentedMiniSearchIndex`. **Bug caught during implementation:** the two delegating stores
initially accepted `expectedNonEmpty` and silently dropped it instead of forwarding to the
underlying index — the flag would have compiled, passed review by eye, and done nothing. Fixed
and pinned by test.

The first-run failure now also produces an ACTIONABLE message instead of the generic one, since
the two situations need different advice: "Indexing walked N file(s) but produced no searchable
chunks... This usually means the embedding model is unreachable -- check that Ollama is running
and the embedding model is pulled, then re-index."

### Verification

`src/test/store/emptyIndexGuard.test.ts`, 5 tests covering the regression directly: first-run
with files → refused; first-run genuinely empty → commits; the old relative guard still holds;
real content commits under both flag values; omitting the flag preserves old behaviour.

compile clean, lint 0 errors, emptyIndexGuard 5/5, all store suites 17/17, plus withheldAnswer
8/8, answerGate.contentVerification 69/69, answerGateFileUsage 12/12, relationClaimVerifier
18/18, importResolver 10/10, logicalUnitExtractor 16/16, askRepoguideTokenProcessor 8/8.

### Still open from the same 2026-07-12 entry

The other four items in that first-run bundle are untouched and remain queued: the
`startupCheck` `ready | ollama-down | models-missing` verdict refactor, activation resilience
(try/catch around the startup rebuild so a failed first index degrades instead of aborting
`activate()`), the raw "fetch failed" chat message, and documenting `qwen2.5-coder:3b`. The
correctness bug is fixed; the first-run UX work around it is not.

## Legacy vs. evidence query-pipeline split: the claim was stale, the residual was real (2026-08-04)

Software defect #11 (`LIMITATIONS.md` §2.5, cross-referenced from
`docs/engineering-log/ARCHITECTURE_CONFORMANCE_REPORT.md` #1 and quoted in `CLAUDE.md`'s DoD #3).
Closed, with a correction to the record.

### The documented claim was false — say so plainly

§2.5 read: "`explainSelection` still silently falls back to the legacy `HybridQueryPipeline` for
some query types, so gate/retrieval fixes to the canonical pipeline don't propagate there."

There is no such fallback, and there has not been one since the Phase 1 consolidation
(`docs/engineering-log/PHASE1_CONSOLIDATION_REPORT.md` §8). Measured, not assumed:

| Claim in §2.5 | Checked against | Result |
|---|---|---|
| `HybridQueryPipeline` exists | `src/query/hybridQueryPipeline.ts` | File does not exist |
| It is reachable from the dispatcher | `legacyPipeline` identifier across `src/` | 0 occurrences |
| A setting selects between pipelines | `repoguide.queryArchitecture` in `package.json` | 0 occurrences (removed) |
| Any residual reference | `HybridQueryPipeline` across `src/` | 2, both historical comments (`evaluation/types.ts:10`, `evaluation/phase3ReportWriter.ts:116`) |

And on the specific worry that motivated re-opening this — that a Chat path might deliver
unverified answers after the five gate fixes landed earlier today — `explainSelection`
(`queryDispatcher.ts:961`) calls `answerGate.verify(...)` with `workspaceRoot`, the graph store,
and the technology set, exactly as `runEvidenceQuery` does at `:735`. Checks **6c**
(relation-claim verification) and **6d** (evidence sufficiency) are unconditional inside
`verify()` — `answerGate.ts:1173` and `:1210`, gated on neither `confidence_mode` nor
`VerificationPlan` — so both run there. The withheld-answer rendering was already wired
(`renderWithheldAnswer`, `:986`). §2.5's headline concern was not real.

The §2.5 text has been rewritten rather than deleted, so the false claim doesn't reappear from
the four other engineering-log documents that still repeat it as current.

### The residual that WAS real

`explainSelection` never called `emitFinalAnswer` — the canonical post-gate tail — and instead
hand-rolled a two-line partial copy of it (`history.add` and nothing else). It therefore silently
skipped four things every chat answer gets. This is the same class §2.5 was worried about, one
layer down: not a second retrieval pipeline, a second *delivery tail*.

| Post-gate step | chat (`emitFinalAnswer`) | `explainSelection`, before | after |
|---|---|---|---|
| `AnswerGate.verify` incl. checks 6c/6d | yes | **yes** (never actually missing) | yes |
| withheld-answer rendering on block | yes | **yes** | yes |
| `gateStatus` trust-visibility token | yes | **no** | yes |
| query-evidence export (MCP `get_last_chat_evidence`) | yes | **no** | yes |
| mentor insights | yes | **no** | yes |
| `(ev-N)` citation resolution | yes | **no** | yes |
| conversation-history recording | yes | yes (own copy) | yes (shared) |

The `gateStatus` gap was actively misleading rather than merely absent: `deriveGateChipInfo`
(`webviews/sidebar/gateStatusRendering.js:69`) renders a muted **"Unverified"** chip when the
token never arrives, and its own comment cited "legacy explainSelection" as the reason that
branch exists. So a fully gated explanation was being presented to the user as unverified.

Separately, `explainSelectionResult()` was **orphaned**: it duplicated `explainSelection`'s whole
plan→retrieve→synthesize→gate sequence and then built its own answer-metadata tail, and the only
reference to it anywhere outside its own definition was the pass-through assignment in
`extension.ts`'s `ChatPipeline` object literal. Nothing ever invoked it.

### Fix

1. **One tail, extracted.** New `QueryDispatcher.finalizeApprovedAnswer()` owns the post-gate
   side effects (history, mentor insights, citation resolution, evidence export) and returns the
   finalized text. `emitFinalAnswer` keeps only the typed side-band token *yields* and delegates
   the effects. This split is what lets a generator surface and a plain-text surface share one
   tail.
2. **`explainSelection` routed through it**, and it now emits the `gateStatus` token on both
   outcomes (block and non-block), matching the chat path. Citation markers are resolved back to
   display text on this path only, because its consumer renders with `textContent`.
3. **`explainSelectionResult()` deleted** (with `ExplainSelectionBackendResult` and the
   `ChatPipeline` member), per DoD #3 — removed rather than routed, since keeping an uncalled
   second path alive is the orphaned-subsystem pattern this repo has a written history of.
4. **Consumers taught the token contract.** `src/ui/explainPanel.ts` now routes control tokens out
   of the prose (they would otherwise render as literal JSON) and shows a gate chip built with the
   *same* `gateStatusRendering.js` the sidebar uses — loaded via `asWebviewUri`, not reimplemented.
   `queryPipelineHarness.ts` already stripped `gateStatus`, so evaluation was unaffected.
5. **New `src/query/answerStreamTokens.ts`** holds the two pure pieces (`classifyAnswerStreamToken`,
   `stripCitationMarkersToDisplayText`) dependency-free — `queryDispatcher.ts` cannot be required
   in a plain Node process (it transitively loads the LanceDB native binding), so anything needing
   real unit tests has to live outside it.

### Verification

`src/test/query/answerStreamTokens.test.ts` — 13 tests, behavioral. The ones that matter are the
false-positive controls: prose containing braces, an answer that *quotes* `{"__type":"gateStatus"}`
inline, and a truncated control token all stay classified as text. Erring toward "text" shows a
stray token at worst; erring toward "control" would silently delete answer content.

`src/test/query/canonicalAnswerTail.test.ts` — 10 tests, a drift guard. This divergence class is
invisible to ordinary tests: nothing throws, an answer just quietly gets less than the canonical
one. So it asserts the invariants against the real source text (same technique as
`gateStatusRendering.test.ts`), the strongest being **conversation history is written in exactly
one place, inside `finalizeApprovedAnswer`** — a second partial tail cannot be added without
tripping it. `runDocumentationReport`'s deliberate exemption is asserted too, so it stays a
decision rather than drifting into an oversight.

**Induced-failure check, run for real:** the pre-fix `explainSelection` shape was restored in the
working tree and the guard failed on exactly 3 of 10 tests — the shared-tail, `gateStatus`, and
single-history-write assertions — then passed 10/10 again after restoring. The guard detects the
actual defect, not just its own scaffolding.

**A measurement of mine that was wrong, recorded:** the first run of the drift guard reported
`emitFinalAnswer` as not delegating to the shared tail. That was a bug in my test helper, not the
code — `methodBody()` brace-matched `emitFinalAnswer`'s inline object parameter type
(`decompositionContext?: { ... }`) instead of its body. Fixed by skipping the parameter list by
paren depth first, and pinned with a `SELF-CHECK` test so a silently-wrong extractor can't make
the real assertions vacuously pass.

compile clean (`tsc -p ./`, exit 0), lint 0 errors / 965 warnings (all pre-existing; none in the
touched files beyond 3 pre-existing `curly` warnings in `queryDispatcher.ts`), answerStreamTokens
13/13, canonicalAnswerTail 10/10, gateStatusRendering 31/31, answerGate.contentVerification 69/69,
answerGateFileUsage 12/12, askRepoguideTokenProcessor 8/8, lastChatEvidenceResponseBuilder 15/15.

`queryDispatcherEvidenceExport`, `queryDispatcherRawEvidenceCap` and `confidenceFromGate` fail in
this sandbox — all three at `require('queryDispatcher')` → `@lancedb/vectordb-linux-x64-gnu`
missing, before any test body runs. Verified as the known missing-native-binary environment gap on
an import chain this change does not touch, not a regression.

### Deliberately not done

- **`flagRetrievalGapAbstention` / `flagOmittedTraceFiles` were NOT extended to
  `explainSelection`.** They live in `generateForPlan`, are driven by the question text, and
  `explainSelection`'s `question` is optional — on a bare selection there is no question to
  measure omission against. Adding them there would flag on a signal that isn't present. This
  project has reverted two checks for over-blocking; not flagging beats false-flagging.
- **`runDocumentationReport` still skips the tail**, deliberately: it is a whole-repository dump
  with no question and no conversational turn, so recording it as chat history and exporting it as
  chat evidence would pollute both. Now asserted as an explicit exemption.
- **The explain panel's gate chip is not verified live.** The TypeScript and the token routing are
  tested; the webview rendering needs a real Extension Development Host pass, which no session has
  had. It degrades safely — if the script URI can't be built the chip is simply omitted.

### Still open

`LIMITATIONS.md` §2.4 (trust machinery invisible in the UI) is unchanged in scope; this closed one
instance of it (explain-selection had no verification signal at all) but not the general gap.
Four engineering-log documents — `REPOGUIDE_AUDIT.md`, `ARCHITECTURE_CONFORMANCE_REPORT.md`,
`CPP_SEMANTIC_PROVIDER_REPORT.md`, `RUST_SEMANTIC_PROVIDER_REPORT.md` — still describe the legacy
fallback as current. They are dated audits, so they have been left as history rather than
rewritten; §2.5 and the conformance report's item #1 now carry the correction that supersedes them.

## Numeric cross-check no longer packet-bound (2026-08-04)

Software defect #10, `LIMITATIONS.md` §3.4. Closed. §3.2 deliberately left open — see below.

### Root cause

`AnswerGate`'s numeric-contradiction check builds `numericThresholdFacts` exclusively from
`packet.facts`. It can only contradict a claimed number when a matching `numeric_threshold`
fact was already retrieved. When retrieval missed that fact the check didn't fire at all and a
wrong number passed unexamined — confirmed on the audit-03/04 questions, where the packet held
32 numeric facts and none for the symbol under discussion. §3.4's own phrasing: the safety net
having holes, felt precisely when the model is also wrong.

The reason it stayed open was structural, not conceptual: `verify()` is synchronous and pure,
`FactStore` is async, and §3.4's noted fix ("thread a live store into AnswerGate") would have
forced every one of the gate call sites to change shape for an I/O concern that isn't the
gate's.

### Fix — split the sync/async concern instead of threading a store

- `src/query/numericClaimSymbols.ts` (new, pure, no store): extracts identifier-shaped tokens
  appearing within the gate's own `CLAIM_SYMBOL_WINDOW_CHARS` of any number. Deliberately
  over-collects — a symbol with no numeric fact costs one indexed lookup that returns nothing,
  whereas missing a symbol reopens the hole. Over-collection cannot cause a false block on its
  own: the gate's existing proximity matching still decides whether a fetched fact pertains.
- `AnswerGate.verify()` takes an optional 7th argument `supplementalNumericFacts`, merged into
  `numericThresholdFacts` with dedup on symbol+value+file+line. Gate remains synchronous and
  store-free; parameter is defaulted so every existing caller is unchanged.
- `QueryDispatcher` holds `stores.factStore` (same pattern as the existing `graphStore` field)
  and pre-fetches via `fetchSupplementalNumericFacts()`. Wired at ALL THREE production gate call
  sites — `runEvidenceQuery`, `explainSelection`, and the documentation path — so Chat and MCP
  `ask_repoguide` are both covered (they share this dispatcher). Fails soft: any store error
  logs and returns `[]`, because a verification aid must never break answer delivery.

### Verification

The decisive test asserts BOTH directions on one claim: `The MAX_RETRIES limit is 9.` passes
when no fact is available (reproducing the old hole) and is caught once the supplemental fact
says 3. Plus: a correct claim with an agreeing fact still passes, omitting the argument
reproduces previous behaviour exactly, and a duplicated fact is not double-counted.

**A test-design error worth recording.** The first version of these tests failed 3/4 — not
because the fix was wrong, but because the fixtures put the claimed number nowhere in evidence
content, so the *presence* check ("is this number supported at all") blocked first and the
*contradiction* check under test never ran. Two different checks were being conflated. Fixtures
now carry both numbers in content so only the supplemental fact distinguishes them.

compile clean, lint 0 errors; numericClaimSymbols 7/7 (new), answerGate.contentVerification
73/73 (4 new), answerGateFileUsage 12/12, relationClaimVerifier 18/18, withheldAnswer 8/8,
canonicalAnswerTail 10/10, answerStreamTokens 13/13, emptyIndexGuard 5/5, importResolver 10/10,
logicalUnitExtractor 16/16, modelProse 6/6, askRepoguideTokenProcessor 8/8.

## Gate bypass: one English word disabled every blocking check (P0-1, 2026-08-05)

First item from `docs/engineering-log/STRICT_AUDIT_2026-08-04.md`, and the most severe finding in
it: not a missing check, but a switch that turned the existing ones off.

### The reproduction

`AnswerGate.verify()` computed a single boolean, `skipStrictBlocking`, from a plain substring scan
of the lowercased answer for five phrases — one of which was the bare word `'missing'`. That
boolean guarded **eight** `outcome = 'block'` sites plus check 6d. Executed against the compiled
gate, identical 4-item packet, `presentTechnologies = {Django}`:

| Answer | Outcome |
|---|---|
| `The project uses Redis for caching.` | **block** |
| `The project uses Redis for caching. Error handling for a missing key is elsewhere.` | **pass** |

Same fabrication. One appended clause containing "missing" — ordinary code-explanation vocabulary,
not a hedge. The failure was silent: `gateStatus` reported `pass` and the trust chip rendered
green. Confirmed the same flip for all five phrases against the fabricated-technology block, the
fabricated-quote block, the fabricated-fence block, and check 6d's thin-evidence caveat.

### Root cause, in two parts

**Part 1 — the flag.** A conservatism intended for one narrow case (the model restating the
QUESTION inside an abstention: *"I cannot determine if 0.85 is the threshold"*, where `0.85` came
from the user) was implemented as an unanchored substring test over the whole answer, then wired
as a global kill-switch for every blocking check rather than scoped to the one it was reasoning
about. Two independent errors compounding: wrong vocabulary, wrong scope.

**Part 2 — found while verifying Part 1's fix, and it is the same defect class.** Fixing the gate
closed only two of the five phrases against the flagship technology check. `technologyClaimVerifier`
tested its negation guard (`NEGATION_REGEX` — "does not use Celery", correctly never flagged) over
a fixed ±120-character proximity window that crosses sentence boundaries. So a negation in a
NEIGHBOURING sentence suppressed the flag. Measured: `The project uses Redis for caching.` is
flagged, but appending *any* of "The evidence does not specify the TTL.", "The port is not
explicitly stated.", or even the entirely ordinary "There is no reason to think otherwise about
it." made the identical fabrication go unflagged. The module's own doc comment defends the wide
window — correctly, but that defence is about finding the USAGE VERB across false boundaries like
"e.g.", and it was applied to negation, where the window has the opposite failure mode because
negation *suppresses* the check.

This is why the fix is not "delete the flag": the same unscoped-suppression mistake existed twice,
in two modules, and only the first was in the audit.

### Fix

One primitive, `src/query/sentenceSpans.ts`, shared by both call sites so they cannot drift.

- `abstentionVerifier.ts` gains `abstentionScope(answer)` returning `{ any, covers(index) }`, built
  on the module's already-validated `ABSTENTION_PATTERNS` rather than a second private phrase list.
  The active-voice forms the old scan covered ("cannot determine", "does not specify", "not
  explicitly stated") were folded into that list so nothing real was lost. `'missing'` was
  deliberately NOT reinstated, and the comment now states that no bare word may be added.
  `detectAbstention` was refactored onto the same splitter — one sentence-boundary implementation
  in the file, not two (DoD #3).
- `answerGate.ts` replaces the global boolean with positional queries. Numeric occurrences inside
  an abstaining sentence are filtered out of `claimIndices` by the same per-occurrence mechanism
  that already excludes markdown list markers; quote and fence sites ask `covers()` at the
  artifact's own offset; the equivalence check tracks its sentence offset. Only the three checks
  that are genuinely answer-level — the gap prepend, 6d, and the conceptual prefix, none of which
  can block — read `.any`.
- The technology check now takes **no** abstention exemption at all. It needs none:
  `detectFabricatedTechnologyClaims` already declines to flag a mention inside a negation window,
  which is precisely the abstaining shape. The exemption was removed rather than narrowed.
- `technologyClaimVerifier.ts` keeps the wide window for the usage verb and scopes negation to the
  mention's own sentence.

Quote offsets index into the fence-stripped copy of the answer, whose replacement shifts positions,
so a second scope is computed on that string. Deliberately that rather than padding fences to equal
length, which would preserve offsets but change the distances `findNearestClaimedFile` measures.

### Verification

`src/test/query/gateBypassScope.test.ts` (35 tests, new) pins the invariant rather than the
implementation: **a hedge exempts an artifact only where the artifact might be a restatement of the
question — inside the abstaining sentence itself.** Five former bypass phrases × four
independently-reachable blocking checks, plus the audit's verbatim A/B pair, plus the second root
cause, plus the vocabulary itself.

Both directions are asserted. A fix that simply never exempts anything would pass a one-directional
suite while reintroducing the over-blocking this project has already reverted twice, so the suite
also pins that `I cannot determine if 0.85 is the confidence_threshold used here.` is still exempt
while `The confidence_threshold is 0.85. Separately, the evidence does not specify the retry limit.`
is not.

Run against the pre-fix behaviour (compiled modules patched back to the old semantics before load):
**24 of 35 fail.** The 11 that pass are the four controls, the legitimate-exemption cases, and — for
three of them — cases the simulation cannot restore because the fix deleted the technology check's
guard outright rather than narrowing it; those three are covered by the direct pre-fix execution
recorded in the table above.

| After | Result |
|---|---|
| Audit A/B pair | both **block** |
| 5 phrases × 4 blocking checks | 20/20 still **block** |
| Number/quote restated inside the abstention | still exempt |
| Same artifact asserted in its own sentence | **block** |
| 6d on `"The config value is missing from the loader."` | `revise` + thin-evidence caveat restored |
| Genuine abstention on a thin packet | still not double-flagged |

`tsc` exit 0; `eslint src` 0 errors (965 warnings, pre-existing). Suites exercising the changed
modules: gateBypassScope 35/35 (new), answerGate.contentVerification 73/73, technologyClaimVerifier
14/14, abstentionVerifier 11/11, answerGateFileUsage 12/12, canonicalAnswerTail 10/10,
gateStatusRendering 31/31, factExtractor 4/4. `subAnswerMerger` cannot run in this sandbox
(`@lancedb/vectordb-linux-x64-gnu` absent) — it calls the same `verify()`, so it inherits the fix by
construction, but that is reasoning, not a measurement, and is recorded as such.

Full-tree sweep: 678 pass / 63 fail across 159 compiled suites. Every failure was attributed before
being disregarded — 11 files `@lancedb/vectordb-linux-x64-gnu`, 13 files `@jest/globals` under
`node --test`, 8 `describe is not defined`, 5 `suite is not defined`, 2 `Cannot find module
'vscode'`, 7 `no such table: knowledge_hotspots`, plus `evidencePacketBuilder.test.js` 0/5 (the
pre-existing rot the audit records as P1-6). **None of the failing suites reference `answerGate`,
`technologyClaimVerifier`, `abstentionVerifier` or `sentenceSpans`** — verified by grep, not
assumed.

### What this does not fix

The gate is shared by Chat and MCP `ask_repoguide` through the same `QueryDispatcher`, so both
surfaces are covered. But P0-1 was a switch that disabled checks; nothing here improves the checks
themselves, and the audit's remaining P0/P1 items — including P0-2, where the empty-index guard
shipped on 2026-08-04 does not reach the store the query pipeline actually reads — are untouched.

### §3.2 deliberately NOT fixed, and why

The sibling-constant collision (`TIMEOUT_RAG`=30 vs `TIMEOUT_CLASSIFICATION`=60 sharing the word
"timeout") remains open by design. It was deferred by explicit agreement, and the only available
lever — loosening proximity AND-matching so two real symbols sharing a generic word can be told
apart — is the same lever behind the over-blocking regression this project has already reverted
twice. It is tagged *occasionally* and needs a specific shape to trigger (sibling same-word
constants plus prose mentioning both topics). Fixing it would likely trade a rare false block for
a common one. Left documented rather than patched reactively.

### Known small defect: runtimeIngestion test leaves scratch dirs behind (2026-08-05)

`src/test/runtimeIngestion.test.ts` DOES clean up -- `afterEach` calls `db.close()` then
`fs.rmSync(workspaceRoot, {recursive: true, force: true})` -- but the removal fails and 24
`out/test/mock_workspace_*` directories are currently left behind. The surviving contents show why:
each leftover holds either a `runtime_snapshot.jsonl` or a `.fuse_hidden*` placeholder, which is what
the filesystem leaves when a file is unlinked while a handle is still open. So the snapshot writer is
not closed before `afterEach` runs. Deliberately NOT gitignored -- `out/` is already ignored
(`.gitignore:2`), so this pollution can never reach a commit; the fix belongs in the test's teardown,
not in an ignore rule that would hide it.
