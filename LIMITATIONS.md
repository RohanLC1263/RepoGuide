# RepoGuide Known Limitations

Last updated: 2026-07-11. This is the consolidated map of every confirmed failure class,
grouped by root cause. Sources: the 2026-07-07/09 live investigation sessions (CraftConnect
15-question eval, AnswerGate false-positive hunt, model-replay experiment, axios branch-logic
control, and three new-failure-class probes), the 2026-07-11 self-contradiction-check
investigation (§1.3), plus the per-fix detail in `ROADMAP.md` and `CHANGELOG.md`. Claims here
were verified against real runs and real source, not assumed.

**Root-cause legend:**
- **(a) architectural gap** — needs a real new capability, not a patch.
- **(b) tunable bug** — fixable with targeted engineering; several already fixed this week.
- **(c) model capability ceiling** — inherent to the local 7B default (`qwen2.5-coder:7b`);
  not fixable by RepoGuide's own code, only mitigated by it.

**Frequency legend** (would an ordinary user hit this): **often** / **occasionally** /
**adversarial-only** (surfaced only under deliberate probing).

---

## 1. Model capability ceilings (c)

### 1.1 Boolean/branch-logic tracing is unreliable — in general, not just on complex code
The default local model frequently inverts conditional logic when explaining code: which
branch fires under which condition, what a guard clause blocks vs. allows.

- **Evidence (CraftConnect, real eval):** inverted `process_answer`'s retry-index `if/else`
  (claimed the exception fires when questions match; it fires when they don't), and swapped
  the high-risk trigger vs. bypass condition in `_filter_story_against_facts`.
- **Evidence (axios control, 2026-07-09):** to test whether this was specific to
  CraftConnect's nested conditionals, 4 questions targeting *shallow* branches were run
  against the indexed axios corpus. Score: 2/4. It inverted a **single-level `if/else`**
  (`settle.js` — quoted the resolve condition correctly, then concluded the opposite for the
  no-status case) and botched a two-level OR (`buildFullPath.js` — De Morgan error on the
  `allowAbsoluteUrls === false` override). Evidence packets were verified complete and
  uncorrupted in all 4 cases, so these are pure reasoning failures.
- **Model-replay confirmation:** the two CraftConnect failures were replayed through Claude
  Sonnet on byte-identical evidence packets; it got both right (including recovering the
  truncation-corrupted packet in §3.1 from a surviving comment). The ceiling is the model,
  not (only) the evidence.
- **The sharper pattern:** across all six branch questions, the model was right exactly when
  the code matches the intuitive prior and wrong exactly when the code is counterintuitive —
  in both axios failures it quoted the correct condition and then contradicted it in prose.
  It appears to answer from plausibility, not from evaluating the boolean. Counterintuitive
  branches are precisely where users most need the answer to be right.
- **Frequency:** often — any "under what condition / what happens if" question, a core use case.
- **Status:** open; inherent to the 7B tier. Mitigations live in RepoGuide's control
  (evidence presentation §3.1, relation verification §2.1), but cannot close it.

### 1.2 Plausible-structure padding on broad questions
On wide "explain the architecture" questions the model pads real evidence with
plausible-but-wrong workflow structure. Confirmed twice: the 2026-07-07 decomposition test
(claimed `StoryGenerationAgent` runs in the mission pipeline; `run_mission` builds its report
with `story_text=None`) and the 2026-07-09 probe P1 (placed marketplace-readiness analysis and
listing generation inside the image-upload mission; same `run_mission` disproves both —
`marketplace_report=None`, listing generation actually happens via the interview path).
Generation-side this is a model ceiling; the fact that nothing *catches* it is §2.1.

- **Frequency:** often — broad orientation questions are a primary day-one use case.
- **Status:** open. Decomposition measurably narrows it (focused per-facet evidence) but
  doesn't verify it.

### 1.3 Self-contradiction check attempted for §1.1 — the verifier shares the generator's ceiling (2026-07-11 investigation)
§1.1 established that the generator answers boolean/branch questions from plausibility, not
evaluation. A mitigation was designed: `AnswerGate.checkBranchConsistency`, an isolated re-ask
that strips the original question framing and asks a *second* model call whether the answer's
own quoted condition actually supports its own stated conclusion — catching the contradiction
after generation rather than trying to prevent it. Before any pipeline wiring, the design
required a validation harness (same pattern as the axios control in §1.1) replaying real
captured cases through the drafted re-ask prompt, with an explicit go/no-go gate.

- **Step-1 gate: FAILED, 0/3 real contradictions caught.** Extraction was verified correct
  (both branch bodies present, not just the bare condition) before concluding this was a
  verifier problem, not a harness bug — an earlier extraction bug had grabbed the whole
  46 KB evidence dump instead of the containing function and was caught and fixed first.
  With correct extraction, `qwen2.5-coder:7b` — the same model tier as the generator —
  reproduced the *identical* inversions on two of the three real cases: on `settle.js` it
  reasoned "`response.status` is falsy → reject" from `if (!response.status || ...)`, the
  same `||`-short-circuit inversion as the original generator failure; on `buildFullPath.js`
  it repeated the same De Morgan error on the `allowAbsoluteUrls === false` override. (The
  third case, `_filter_story_against_facts`, was later found to have an incomplete rule
  extraction — the captured replay-prompt reconstruction truncated mid-list — so the
  verifier was reasoning over code it couldn't see; this instrumentation bug was caught in
  a follow-up pass and doesn't weaken the other two, but the case itself isn't clean
  evidence either way.) All 5 should-not-flag cases (including the two adversarial probes:
  q4's exactly-at-threshold boundary, and q3's correct answer with one internally-wrong
  middle sentence) correctly produced zero false flags — extraction and gating held; the
  verifier's own reasoning was the failure.
- **Identifier-neutralization diagnostic: 3/3 caught with neutral tokens.** The same three
  cases, re-encoded with identical logical structure but opaque symbols (`P`/`Q`/`R`,
  `ALPHA`/`BETA`) instead of `response.status`/`reject`/domain names, were all correctly
  traced with clean step-by-step boolean reasoning and no plausibility appeals. This isolates
  the verifier's ceiling to the same identifier-driven plausibility effect as §1.1 — the
  model can evaluate the boolean; real-world names trigger a prior that overrides it.
- **Deeper findings from refined-design probes, at mechanical fidelity.** The
  hand-constructed neutralization probe above pre-digested premises into direct truth
  assignments; a follow-up probe tested inputs closer to what a mechanical renamer would
  actually produce, and found two further, independent failure modes:
  - **Negation-crossing-assignment failure, even under neutral names.** `let q1 = !g1(p2)`
    combined with a premise stating `g1(p2)` is true was answered wrong (verdict flipped)
    when the negation had to be carried across the assignment; the identical logic with the
    assignment mechanically inlined into the condition (`!g1(p2)` written directly at the
    use site) was answered correctly. The ceiling is not purely identifier-driven — it also
    has a structural limit on negation-through-assignment tracing.
  - **Non-abstention on unpinned premises.** When a probe's premise deliberately left one
    referenced variable unspecified, the verifier did not report the designed-for
    `UNDETERMINED` — it picked a branch anyway. A "the model will say so if it can't tell"
    fallback cannot be delegated to the model; premise completeness has to be checked
    deterministically before the model is asked at all.
- **Tractability of the redesign, hand-verified against all 8 cases.** A refined design
  (neutralize only the deterministic code/rule side; ask which abstract branch fires;
  separately classify the conclusion's claimed outcome from a closed candidate set derived
  from the same extraction, rather than asking the model to reason about the real-world
  conclusion at all) reaches 3/3 caught, 0/5 false-flagged **on paper** for all 8 cases. But
  the outcome-label extraction needed five structurally distinct sub-patterns across the 8
  cases (callee-name matching, identifier-set discrimination between branches, enum-arm
  matching, guard-clause negation handling, and question-stated-disjunction parsing) plus a
  mechanical inliner (per the negation finding above) and a premise-completeness gate (per
  the abstention finding above) — six new mechanical components, each validated against
  exactly the one case that motivated it.
- **Deferred, not abandoned.** Six single-case-validated heuristics is the same
  overfit-to-benchmark shape this codebase has a written post-mortem about
  (`docs/engineering-log/LANGUAGE_HACK_CLEANUP_REPORT.md`) — tuning a mechanism until it clears a fixed set of
  known cases proves it fits those cases, not that it generalizes. A properly generalized,
  independently-revalidated version is honestly a 3-5 day effort (extraction fixes, a
  renamer/inliner, a premise atomizer, the five-pattern outcome labeler, a full
  revalidation pass, then pipeline wiring and tests) — not attempted against a one-day
  runway. All harness code, both diagnostic probes, and every raw verifier trace are
  preserved (outside this repo, in a scratch directory) for exact resumption without
  re-deriving any of the above.
- **Frequency:** the underlying §1.1 ceiling this was meant to catch is **often**; this
  mitigation itself is not deployed, so it has no current user-facing frequency.
- **Status:** open; investigation complete, redesign scoped, implementation deferred by
  explicit decision (timeline, not feasibility — the failure boundary and one rescue path
  are mapped, not unknown).

---

## 2. Architectural gaps (a)

### 2.1 AnswerGate cannot verify RELATION claims — PARTIALLY CLOSED 2026-08-04
"A runs after B", "X delegates to Y" — claims about a symbol *pair* contain no quote, fence,
number, or path, so no check touched them. This is the verification-side half of §1.2 and was
the gate's largest open blind spot. The VALUE half (a confident wrong number for a named
symbol) was closed 2026-07-08 via the AST-derived `numeric_threshold` cross-check.

**Closed for file-scoped USE claims** (`relationClaimVerifier.ts`, gate check 6c): a claim of
the form "`<file>` calls/uses `<symbol>`" is now verified by reading that file's real source,
stripping comments and string literals, removing definition-position occurrences, and flagging
what remains. This catches both measured fabrication classes — the symbol being absent from the
claimed file entirely, and the symbol being present only as that file's own definition
(direction inversion, where the model enumerates a method's DEFINERS and narrates them as its
CALLERS). Measured on the real recorded `adv-hot-3` answer: 10 of 10 fabricated claims flagged,
0 violations on the two recorded accurate answers.

Notably it reads files rather than querying the graph, so it inherits neither the ~38%/13%
inbound-edge precision wall (§ deadFileDetector) nor ProgramGraphStore's lowercased bare-name
collisions — and `app.add_middleware(ObservabilityMiddleware)`, the framework-wiring case that
forced the earlier symbol-scoped usage check to be withdrawn, passes cleanly because the
registering file textually contains the symbol.

- **Still open:** relation claims that name no file ("`A` delegates to `B`" with no path),
  anaphoric subjects ("it uses this instance"), and ordering claims ("A runs after B") — none
  of which the file-reading oracle can adjudicate. Symbol-pair claims without a file remain
  unverified.
- **Frequency:** reduced — the file-naming shape (the dominant one in measured inbound-dependency
  answers) is now covered; other relation shapes are not.
- **Status:** partially closed.

### 2.2 Fabricated illustrative code can still pass the gate (new, 2026-07-09) — FLAGGED FOLLOW-UP
Probe P1's answer included a fully fabricated `ListingContentAssistant.generate_draft`
snippet (invented `DraftInput`/`DraftOutput` types and `draft_content` field — zero hits for
any of the three names anywhere in CraftConnect) and the answer passed the gate. This is a
false *negative* in the same fence-verification territory as the false positives fixed this
week (§3.3) — the check exists but did not catch this block. **Root-caused 2026-07-09 (not
yet fixed):** detection worked — the evidence-wide fence check flagged the fabricated block
into `unsupported_claims` — but blocking is policy-gated to `confidence_mode === 'exact' ||
'grounded'` (`answerGate.ts` fence branch), and broad questions classify as
`architecture_analysis` → `conceptual`, a mode in which **no check blocks at all** (fences,
quotes, misattribution, numerics, equivalence claims — all record-only; the only
conceptual-mode consequence is a low-coverage "revise" prefix). Confirmed empirically:
replaying the exact captured answer through the real compiled gate yields `pass` under the
plan's real conceptual mode and `block` ("likely fabricated illustrative code") with mode
forced to `grounded`. This is a different class from §3.3's fixed bugs (those were matcher
false positives; this is an enforcement-policy exemption that is too broad — a fenced code
block is a verbatim claim regardless of question type). **Fix is not the one-liner it looks
like:** the same replay shows a *real*-code fence in the same answer (a multi-line
`__init__` signature the model flattened onto one line) that would falsely block under
grounded rules — naively enabling enforcement in conceptual mode would reintroduce the
§3.2/§3.3 over-blocking class on broad questions. A safe fix needs signature-flattening
tolerance in `fenceLinesMatchInOrder` (or a non-blocking remediation such as
stripping/annotating the offending fence) first.

- **Frequency:** occasionally — every conceptual-mode question (architecture, onboarding,
  refactoring) where the model "illustrates" instead of quoting, which is its strong habit on
  exactly those questions.
- **Status: fixed (2026-07-09)** via the approved middle-ground remediation: a fence that
  fails verification in conceptual mode now gets an inline "could not verify" annotation
  directly after the offending block plus a pass→revise downgrade (existing tier), instead
  of either silence or a block. Matching tolerances and all exact/grounded block logic
  untouched. Verified with 7 tests (5 induced failures confirmed failing pre-fix, 2
  controls) plus a pinned-generation live replay through the real pipeline: the captured
  fabricated answer now delivers with gate=revise and the annotation adjacent to the
  fabricated fence, while the flattened-signature real fence gets the soft flag, not a
  block.

### 2.3 RepositoryBrain is wired but empty on real projects
The `repository_brain` provider runs in the real orchestrator, but `repository_brain.sqlite`
has 0 rows on the dogfood corpus — the ingestion pipelines (git history, ADRs, review,
coverage, incidents) don't populate it for a real single-developer repo. Probe P3 confirmed
the failure mode is *partially* graceful: asked about past incidents and change hotspots, the
answer correctly declined to invent incidents ("no specific information provided in the
evidence"), but the change-frequency half went wrong via §3.6 rather than degrading to an
honest "evidence does not determine".

- **Frequency:** occasionally — history/incident questions are natural but not daily.
- **Status:** open. Needs ingestion sources built/connected; query-side is done and idle.

### 2.4 The trust machinery is invisible in the UI
Verification, decomposition, retries, prompt budgeting — all real, all invisible: no badge
distinguishing a decomposed answer from single-shot, no retry visibility, telemetry only in
the output-channel log. The chat surface shows little beyond a "Not covered" line when a
section fails verification. Users have no way to see *why* an answer was blocked or trust why
one passed. Confirmed unchanged since Phase 5 via git log on `src/ui/`/`webviews/`.

- **Frequency:** often — affects every answer's interpretability, if not its correctness.
- **Status:** open, tracked in `ROADMAP.md` so it isn't silently forgotten.

### 2.5 Legacy vs. evidence query-pipeline split — CLOSED 2026-08-04, and the original claim was wrong
This entry previously read: "`explainSelection` still silently falls back to the legacy
`HybridQueryPipeline` for some query types, so gate/retrieval fixes don't propagate to those
paths." **That was stale, and it is corrected here rather than deleted, because four
engineering-log documents still repeat it as current.**

There is no legacy fallback and has not been one since the Phase 1 consolidation
(`docs/engineering-log/PHASE1_CONSOLIDATION_REPORT.md` §8): `src/query/hybridQueryPipeline.ts`
does not exist, `legacyPipeline` appears 0 times in `src/`, and the `repoguide.queryArchitecture`
setting that selected between the two was removed from `package.json`. `explainSelection` runs
the canonical plan → retrieve → packet → synthesize → `AnswerGate.verify()` sequence, passing
`workspaceRoot` and the graph store, so it gets the relation-claim (6c) and evidence-sufficiency
(6d) checks — both unconditional inside `verify()` — and the shared withheld-answer rendering.

**What was actually still divergent** was one layer down: `explainSelection` never called
`emitFinalAnswer`, the canonical post-gate tail, and hand-rolled a partial copy of it. It was
therefore fully verified but emitted no `gateStatus` token (so the UI's "Unverified" fallback
chip rendered on a *verified* answer), was invisible to MCP `get_last_chat_evidence`, and got no
mentor insights or citation resolution. `explainSelectionResult()` was separately orphaned —
a full duplicate of the same sequence that no production code ever called.

Fixed by extracting `QueryDispatcher.finalizeApprovedAnswer()` as the single post-gate tail and
routing both surfaces through it, deleting `explainSelectionResult()`, and teaching the explain
panel the side-band token contract. A source-level drift guard
(`src/test/query/canonicalAnswerTail.test.ts`) now fails if a delivery path grows a second
partial tail — verified by restoring the pre-fix shape and confirming 3 of 10 assertions fail.
See `ROADMAP.md`, 2026-08-04.

- **Frequency:** was **occasionally** — any explain-selection use.
- **Status:** closed. The residual UI-side gap it touched (verification status not surfaced on
  every surface) is tracked as §2.4, not here.

### 2.6 Structural coverage gaps
- Ruby/PHP/Swift have no tree-sitter grammar → fixed-window plain-text chunking (degraded,
  not broken). **Occasionally** (repo-dependent). Open.
- Orphaned modules (`src/intent`, `src/evolution`, `src/drift`, `src/causal`→MCP,
  `src/orchestrator`, `src/incident`) still need keep-or-delete. Not user-facing; a
  maintenance hazard. Open.
- All seven semantic providers run shadow-mode — computed but not yet authoritative for any
  language's answers. A staged rollout state, not a failure; listed so nobody mistakes the
  capability as load-bearing. **Adversarial-only** as a user-visible issue.

### 2.7 MCP raw-evidence items don't carry staleness flags
`retrieve_raw_evidence`/`get_dependents`/`get_facts` return `RetrievalOrchestrator` items
directly, bypassing `EvidencePacketBuilder`'s `checkStale`/redaction logic — an MCP caller gets
no index-freshness signal on raw evidence. A parity gap versus the answer path, not a hardening
hole: no answer is asserted from raw evidence, so there's nothing to falsely present as current.
**Occasionally.** Open.

---

## 3. Tunable bugs (b)

### 3.1 Evidence-packet truncation silently strips control-flow keywords (found 2026-07-09)
The oversized-item truncation ("head + question-matching lines") deleted the `if not
is_retry:` / `else:` lines from `process_answer` while keeping both branches' bodies as
flattened, unconditional-looking sequential lines — no indication in the item header that the
controlling keywords are gone. This directly aggravates §1.1: the 7B model reproduced the
inversion; Sonnet recovered only via a surviving comment. A fix (e.g., always retaining
control-flow keyword lines that dominate kept lines) is targeted engineering, not new
capability.

- **Frequency:** occasionally — needs a large method + a branch question about it, but that
  combination is natural (long methods are where branch questions arise).
- **Status: fixed (2026-07-09).** `truncateItemContent` now walks each kept tail line's
  indentation ancestors and retains its governing control-flow lines (`if`/`else`/`try`/...,
  bounded to 4 ancestors, stopping at a shallower non-control-flow line or already-kept
  structure). Verified with a regression test reproducing the exact `process_answer` shape
  (confirmed failing pre-fix) plus a control confirming unrelated shallower lines aren't
  dragged in.

### 3.2 Numeric-contradiction check: proximity-collision family
One mechanism (symbol-word proximity matching), several manifestations:
- *(fixed)* one shared word ("confidence") collided unrelated symbols → require ALL
  distinctive word tokens.
- *(fixed)* generic short symbol (`base`) as proximity anchor → `MIN_STANDALONE_SYMBOL_CHARS`.
- *(fixed)* useState-collision v2 → `factExtractor` skips `numeric_threshold` for
  React-hook/setter-argument literals (fixed at the fact source, not the matcher).
- *(fixed)* markdown list markers ("1. ", "2. ") read as numeric claims — the dominant
  over-blocking driver in the 4/14 eval regression → `isListMarkerContext()`.
- *(fixed)* compound symbols degenerating to one generic token (`min_words` → "words") →
  `MIN_WORD_TOKEN_CHARS = 3` + generic-word stoplist.
- *(deliberately deferred, open)* **shared-constant-cluster collision**: `TIMEOUT_RAG` (30)
  and `TIMEOUT_CLASSIFICATION` (60), real adjacent constants sharing the word "timeout" — a
  correct claim about the 60s timeout with "RAG" mentioned nearby falsely blocks. Verified
  pre-existing, same root family (proximity AND-matching cannot disambiguate two real symbols
  sharing a generic word); deferred by explicit agreement rather than patched reactively.
- **Frequency:** the fixed classes were **often** (list markers hit most walkthrough answers);
  the deferred cluster case is **occasionally** (needs sibling same-word constants + prose
  mentioning both topics).
- **Status:** five fixed with induced-failure regression tests; one deferred.

### 3.3 Fence/quote attribution false positives — fixed, one residual disclosed
Three live false-positive classes fixed 2026-07-08/09 (commit `863011bb`): resolved f-string
placeholders now accepted by per-file attribution (`matchesTemplateInContent` in both quote
and fence branches); real-but-non-contiguous fence reproductions accepted via
`fenceLinesMatchInOrder` (ordered line-cursor match with a distinctive-line requirement).
A fourth blocked answer was verified as a genuine catch and stays blocked. **Disclosed
residual:** a fence made entirely of short generic lines is still refused — nothing left to
distinguish boilerplate from reproduction; accepted trade-off.
- **Frequency:** was **often** (quoting code with f-strings or elided lines is normal model
  behavior); residual is **adversarial-only**.
- **Status:** fixed; residual deliberate.

### 3.4 Numeric cross-check is packet-bound — CLOSED 2026-08-04
The VALUE check previously compared a claimed number only against `numeric_threshold` facts
already in the evidence packet. If retrieval didn't surface the relevant fact (confirmed on the
audit-03/04 questions: 32 such facts in the packet, none for the symbol at issue), the check
silently didn't fire and a wrong number passed unexamined — the *safety net* having holes.

**Fixed.** `QueryDispatcher` now extracts the symbols an answer names near a number
(`numericClaimSymbols.ts`, using the gate's own `CLAIM_SYMBOL_WINDOW_CHARS` proximity window)
and looks those symbols' `numeric_threshold` facts up directly in `FactStore`, passing them into
`AnswerGate.verify()` as `supplementalNumericFacts`. Wired at all three production gate call
sites in the dispatcher, so Chat and MCP `ask_repoguide` both get it.

The gate stays synchronous and store-free: the async lookup lives in the caller, so no gate call
site had to change shape. The parameter is optional and defaulted, and facts arriving from both
the packet and the lookup are deduplicated on symbol+value+file+line.

Pinned by test: the same wrong claim `pass`es with no supplemental fact available and is caught
once the fact is supplied — the hole, closing. Lookup failures fail soft (log + empty array): a
verification aid must never break answer delivery.
- **Frequency:** was occasional but insidious; now covered for any symbol the answer names near
  the number.
- **Status:** closed.

### 3.5 Retrieval precision/thinness on ordinary questions — partially fixed
Ordinary "how does X work" questions have produced thin or off-target packets (the rc-01/04/10
findings from the earlier session threads). Confirmed contributing causes fixed: BM25 searched
with raw question text, letting filler words bury topically-precise files (fixed via the
additive keyword-only supplemental pass, with measured before/after and no displacement of
existing hits); infra files were structurally unindexable (fixed). Still real: token budgeting
packs a small fraction of what retrieval surfaces (live runs this week: 12 of 59 items,
4 of 615 facts packed), so single-copy decisive evidence competes with duplicates of
already-covered evidence — the same packets that exhibited §3.1 carried 4 redundant copies of
one guard clause while the increment-decision logic existed only in the corrupted item.
- **Frequency:** often (it's the default question shape).
- **Status:** partially fixed; duplicate-suppression / dedup-at-packing is the open remainder.

### 3.6 Internal staleness markers leak into content-level claims (new, 2026-07-09)
Every evidence item carries a `[STALE]` tag and the prompt mandates mentioning staleness.
Probe P3 showed the model reinterpreting these internal index-freshness markers as facts
about the *repository*: "several files have not been updated recently" — meaning-inverted
(STALE means the index entry may lag the file, i.e. the file changed *after* indexing) and
presented as an answer about change frequency. Evidence presentation handing the model
pipeline metadata it predictably misuses is a prompt/packet-format bug, not a model ceiling.
- **Root cause found (2026-07-09):** the markers themselves are false positives — see the
  everything-is-STALE entry in §5. The leak has two layers: (i) the flag fires on 100% of
  items due to a cwd-vs-workspaceRoot path bug, and (ii) even a *correct* STALE flag is
  presented in a way the model reinterprets as repository change history.
- **Frequency:** often (upgraded from occasionally once the flag was confirmed always-on) —
  the mandated staleness warning is demanded on every answer, followed inconsistently by the
  7B model, and false whenever the index is actually fresh.
- **Status:** open (root-caused, not yet fixed).

---

## 4. New-failure-class probes (2026-07-09, scope-capped at three)

| Probe | Question shape | Result |
|---|---|---|
| P1 | Broad "explain the overall architecture" | **Partial fail.** Sound high-level component map, but: workflow padded with wrong pipeline structure (§1.2, reconfirmed against `run_mission`); a fabricated code snippet passed the gate (§2.2, new); one snippet heading mislabeled (`CraftClassifierAgent` over `ImageQualityAgent` code). |
| P2 | Two-turn follow-up, anaphoric second turn ("What happens if **it** times out?") | **Pass.** History verified actually threaded (2 history messages in the captured turn-2 prompt), "it" resolved to the classification step, answer matches source. Multi-turn is not a failure class on this evidence. |
| P3 | RepositoryBrain-dependent (change hotspots, past incidents) | **Partial fail.** Gracefully declined to invent incidents (the feared silent-wrong mode did not occur), but answered the change-frequency half wrongly from misread `[STALE]` markers (§3.6) instead of an honest "evidence does not determine". |

## 5. Flagged follow-ups (observed, deliberately not chased)

- **§2.2 root cause** — why the fence check passed a fabricated block on a broad question.
- **"Architecture Insights" appendix noise** — an orientation-module footer appended to
  answers with low-value content (declared "Schema Management" the major component of
  CraftConnect; on an axios question, suggested five documentation files as the reading
  order). Not evaluated this session; reads as boilerplate that dilutes real answers.
- **Everything-is-STALE on a live index** — root-caused 2026-07-09 (investigation only, not
  yet fixed): `evidencePacketBuilder.checkStale()` is a genuine mtime/size comparison against
  the index manifest, but it resolves paths against `process.cwd()` instead of the
  `workspaceRoot` the class already holds, and its `catch`/missing-entry paths both default
  to "stale" — so whenever cwd ≠ workspace root (all harness runs; the Extension Host's cwd
  is VS Code's, not the workspace's), `statSync` throws ENOENT for every workspace-relative
  file and 100% of items are marked STALE. Verified against the real CraftConnect manifest:
  401/401 files are genuinely FRESH under the correct root, 0 mismatches — the flag is pure
  false positive on fresh data. This makes §3.6's noise universal and renders the
  staleness-type eval category unable to distinguish real staleness detection from an
  always-on flag.
- **`node-tree-sitter` Electron ABI** — the bundled prebuild is confirmed loadable under
  plain Node; whether it loads in VS Code's actual Electron runtime is unverified (needs a
  real F5/`.vsix` smoke test; no pass has had an interactive session to do it).
- **Jest suite flakiness** — pre-existing worker contention plus `process.exit()`-on-failure
  test files keep the full suite out of CI (CI runs compile/lint/`test:unit` only).
