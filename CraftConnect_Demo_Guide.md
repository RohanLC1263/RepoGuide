# CraftConnect Demo Guide (RepoGuide)

Practical guidance for demoing RepoGuide against CraftConnect live. Read the mental-model note
at the bottom before any demo.

> **Why these specific questions?** This list was rebuilt after a live adversarial audit (see
> `ROADMAP.md` → "Codex audit — out-of-scope backlog", and `docs/engineering-log/REPOGUIDE_AUDIT.md`).
> Every question below was run against CraftConnect and its behavior verified — it leans on the
> **deterministic program-graph tools** (`get_dependents` / `get_dependencies`), which the audit did
> not implicate, plus the one narrative question (`confidence threshold`) that was fixed and
> re-verified. The "Do not ask live" section lists question shapes that were reproduced as unreliable
> and should stay out of a recorded demo.

## Pre-recording checklist (do this before rolling)

1. **Warm up the model** with one throwaway question first. Cold start is ~**67s** (Ollama loads the
   model on the first call); warm answers are ~**16–27s**. Skipping this risks ~45s of dead air on
   take one.
2. Confirm CraftConnect is indexed (`.repoguide/` present) and the MCP server is on current `main`.
3. Have the exact wording of the confidence-threshold question on hand — do not paraphrase it live.

**Realistic timing to expect:** deterministic graph tools (`get_dependents`/`get_dependencies`)
~2s; `gather_evidence` ~6s; model-synthesis chat/`ask_repoguide` answers ~16–27s warm. A full
run of all 10 questions is ~3 minutes once warmed up.

## Prefer narrow, factual questions over open-ended "explain this feature" questions

**Ask specific, checkable questions.** RepoGuide's hallucination gate (`AnswerGate`) is strong at
what it actually verifies: fabricated **numbers, quoted strings, code blocks, and file paths** are
caught and blocked. Questions whose answers live in those forms stay in the gate's wheelhouse.
Questions that ask the model to *synthesize a cross-file narrative* do not — that is where it either
blocks, hedges vaguely, or (rarely) passes a false relationship claim.

## The demo script: a developer's workflow, not a Q&A list

The point isn't "here are 10 questions RepoGuide answers correctly" — it's showing what a developer
actually does before touching unfamiliar code: **orient, then check what a change would break,
then (while actually building) lean on Claude Desktop grounded in the real repo instead of
guessing.** Every line below is phrased the way a developer would actually say it (verified live,
current wording, 2026-07-25) — not a rehearsed-sounding test query, with one deliberate exception
called out where exact wording matters.

### Beat 1 — Orientation (RepoGuide chat panel): "I'm new to this part of the codebase"

Arriving somewhere unfamiliar, getting your bearings before changing anything.

1. **"Where's `execute_mission` actually implemented?"** → `app/services/mission_service.py`.
   Narrow symbol-location question, in the gate's wheelhouse.
2. **"Where is `RAGRetrieverAgent` defined in this codebase?"** → `app/agents/rag_retriever_agent.py`.
   Same reliable shape. *(Do not ask "what instantiates RAGRetrieverAgent" — see the "Do NOT ask
   live" list; that phrasing reliably blocks.)*

### Beat 2 — "Don't break things" (RepoGuide chat panel): what a symbol relies on, before you change it

The most concrete, relatable value proposition for a developer audience: before you touch a shared
symbol, understand what it leans on.

> **Direction matters here, and it is not a stylistic preference.** Ask chat what a symbol
> **depends on** (outbound) — never what **depends on it** (inbound). Outbound dependencies are
> visible inside the very file being narrated, so the model *reads* them; inbound dependents would
> require correlating across files it never read, so it *invents* them. The inbound direction is a
> documented NO-GO below; use the MCP `get_dependents` tool for it instead (Beat 3 #6).

3. **"Before I touch `ArtifactManager`, what does it rely on to do its job?"** — outbound
   dependencies. Verified claim-by-claim against source: 10/10 real (logger, `os`/`pathlib`/
   `shutil`, `json`, `tempfile.NamedTemporaryFile` in `_save_atomic`, the `get_artifact_manager`
   singleton).
4. **"Before I touch `StoryGenerationAgent`, what does it rely on to do its job?"** — outbound
   dependencies; verified 4/4 real (LLMRouter, PromptBuilder, OutputValidator, BaseAgent).
5. **"What is the confidence threshold in the customization interview agent, and what does it
   protect against?"** → resolves to `0.55` in `customization_interview_agent.py`. **⚠️ USE THIS
   EXACT WORDING, DO NOT PARAPHRASE ON CAMERA.** This was the flagship regression this project fixed;
   a natural rephrase ("how confident does the interview agent need to be before it accepts an
   answer?") makes the model emit a fabricated `0.70`, which the gate correctly blocks — so an
   off-script phrasing reproduces the original bug live.

### Beat 3 — Claude Desktop, grounded in the real repo (RepoGuide MCP): the differentiated pitch

Switch to Claude Desktop. This is the moment that shows an AI coding assistant checking against a
real local index of *this* codebase instead of guessing — the same "don't break things" instinct
from Beat 2, but inside the tool a developer is actually building with.

6. **"I'm about to refactor `MissionOrchestratorAgent` — use RepoGuide to check what depends on it
   so I don't break anything."** → Claude Desktop calls `get_dependents` (**8** real dependents,
   `found: true`). No model in the loop for the actual answer — deterministic graph data.
7. **"Before I add a new field to `StoryGenerationAgent`, show me what it depends on using
   RepoGuide."** → `get_dependencies` (**37** references, `found: true`).
8. **"If I change how `ArtifactManager` works, what's the blast radius? Check with RepoGuide
   first."** → `get_dependents` (**4** dependents) — smaller, clean set, good for a focused answer.
9. **"Pull real evidence from RepoGuide on the confidence threshold in the customization interview
   agent so I can document it correctly."** → `gather_evidence`: cited, ranked evidence
   (deterministic facts separated from retrieved code) with a plain-language grounding indicator,
   *stopping before synthesis* so Claude Desktop draws the conclusion itself.
10. **"Ask RepoGuide: What is the confidence threshold in the customization interview agent, and
    what does it protect against?"** → `ask_repoguide`, same exact wording as Beat 2 #5 (same
    reason: don't paraphrase). Shows the same verified fact land twice — once as RepoGuide's own
    take, once as evidence Claude Desktop reasons over — reinforcing that it's the same real value
    both times, not a coincidence.

*Routing note: questions 6–8 have wording latitude — Claude Desktop (a frontier model) decides
which tool to call, and its descriptions closely mirror this phrasing ("use before modifying any
exported/shared symbol to see what could break," "blast radius"). Questions 9–10 pass your text
straight into RepoGuide's own local model, so — same as chat — wording matters there.*

### Beat 4 — Close: RepoGuide is honest about what it doesn't know

No new live question here — the honesty is already built into what Beat 3 just showed. Point at
`gather_evidence`'s own output: it always states plainly whether "Grounding: reasonable" or thin,
*before* Claude Desktop commits to an answer — that's not a caveat bolted on after the fact, it's
the tool's contract. Pair it with a spoken line: *"RepoGuide also knows exactly where it's
unreliable"* — and gesture at this guide's own "Do NOT ask live" section below: those are questions
this project tested, found unreliable, and documented rather than shipped. A tool that maps its own
blind spots is the point, not an afterthought.

## Do NOT ask these live (reproduced as unreliable in the audit)

- **⛔ IN CHAT: "What depends on `X`?" / "Who uses `X`?" / "What breaks if I change `X`?"** — any
  **inbound**-dependency question. **NO-GO, verified 2026-07-25.** A fix round corrected two real
  causes here — graph-evidence contamination (the provider was sub-token-splitting `BaseAgent` into
  `Base`+`Agent`, matching an unrelated real node) and blast-radius scoring (which counted outbound
  edges, anchors and transitive impact as "dependents", reporting 37 for a symbol with 4). Those are
  fixed: the quantified numbers now match graph truth exactly. **But the prose still fabricates
  dependents**, because that text does not come from the graph at all — the model narrates over ~650
  co-occurring RAG/BM25 chunks, and `AnswerGate` cannot catch it because it does not verify prose
  relationship claims (the same gap the relationship-claim gate check was scoped out of). Confirmed
  fabrications in the final run, checked against source: `community_engine.py`,
  `studio_read.py`/`studio_write.py`/`auth.py` "using ArtifactManager", and
  ConversationAgent/ExplanationAgent/AuthValidatorAgent "using RAGRetrieverAgent" — none of which
  reference those symbols at all. **Use the MCP `get_dependents` tool instead** (Beat 3 #6):
  deterministic, no model in the loop, and now returns exactly graph truth.
- **"Is `community_engine` used / wired into production?"** — `community_engine.py` is dead code
  (imported nowhere in `app/`). `ask_repoguide` blocked this **5/5** with a fabricated-code refusal.
  "Is X used in production?" questions are unreliable in general — the model has no negative-evidence
  signal, so it either refuses or invents usage.
- **"How does X connect to / integrate with / flow into Y across files?"** — cross-file narrative
  synthesis. The gate has no coverage for prose relationship claims, so a fluent-but-false answer can
  pass. If you must show cross-file relationships, use `get_dependents` / `get_dependencies` instead.
- **⛔ NEW (2026-07-28): "Is X synchronous, or does it happen in the background?"** — any question
  about *execution mode*. Asked of the PDF export, the answer confidently said generation "is done
  asynchronously ... to avoid blocking the main request thread." It is a plain `def
  generate_artisan_report_pdf(...)` called directly inside the route handler
  (`app/routers/studio_read.py:396`); the file contains no `BackgroundTasks`, no `run_in_threadpool`,
  no `create_task`. Every *citation* in that answer was correct — endpoint path, function name, both
  file paths — and the answer to the question asked was still the exact opposite of the truth. This
  is the same question that used to fabricate "Celery"; naming the technology is now blocked, but the
  wrong architectural claim survives in technology-free form. Nothing in the gate catches it.
- **⛔ NEW (2026-07-28): "What helper functions does `<file>` have?"** — asked of `pdf_generator.py`,
  the answer invented five (`_truncate`, `_safe_list`, `_get_title`, `_get_description`,
  `_get_materials`); the real ones are `_register_font_alias`, `fmt_craft`, `draw_shell`, `divider`,
  `section_label`, `wrap`. It passed the gate: the invented names sat ~1,400 characters after the
  filename, far outside the citation verifier's 200-character claim window, so the check never
  paired them with the file. The same answer's *external* dependencies (ReportLab, the font
  constants, `_register_fonts`) were all verified correct — accuracy is not uniform within a single
  answer, so spot-checking one section proves nothing about the next.
- ~~**A "RepoGuide can't find it" answer is not evidence of absence.**~~ — **PARTLY ADDRESSED
  (2026-07-29), safer to ask.** Asked where STT confidence averaging is implemented, the answer used
  to say the evidence "does not provide details" and advise searching by hand; the logic is one line
  at `app/services/stt_service.py:181`. An abstention is now checked against the real index before it
  is delivered: if the index knows of a code region the retrieval missed, the answer is downgraded to
  `revise` and names the region to check. Verified against the recorded failure — it now points at
  `app/services/stt_service.py:161-191`, the range containing line 181. **Still worth knowing:** the
  check only fires when the index can find something the packet lacked, so an abstention with no
  caveat is better evidence of absence than before, but not proof.
- **Open-ended "explain the whole X feature"** — invites narrative synthesis; treat as a stretch
  question, never a headline.
- **Questions whose answer lives only in a dead/backup file** (e.g. reasoning about
  `mission_orchestrator.backup.py`) — the graph may resolve a definition inside a `.backup.py`;
  prefer symbols with live call sites.
- ~~`get_dependents` / `get_dependencies` on a symbol you haven't confirmed exists~~ — **FIXED &
  VERIFIED (2026-07-24), safe to ask live.** Previously the graph tools tokenized the query and could
  silently resolve a **nonexistent** name that merely shared a token with a real node (any misspelled
  `...Agent` → the `agent` node) at `confidence: 0.9` with no "not found". Now the tools apply a
  post-retrieval identity check: a name that doesn't correspond to a real graph node returns
  `found: false` with closest-match `suggestions`, instead of a mis-target. Verified live —
  `get_dependents("PaymentReconciliationAgent")` and `get_dependents("InventorySyncAgent")` now return
  `found: false` (suggesting `agent@craft_classifier_agent/agent.py`), while real symbols
  (`BaseAgent` → 13 dependents, `ConversationAgent` → 8, `PackagerAgent` → 23) are unaffected. The
  response now carries an explicit `found` boolean; a real symbol with genuinely no graph edges
  returns `found: true` with an empty list (distinct from `found: false` = doesn't exist). You no
  longer need the manual "check `matchedSymbol.symbol`" workaround.
- ~~High-degree symbols returning `found: false`~~ — **FIXED & VERIFIED (2026-07-25), safe to ask
  live.** The identity check (above) required a `graph_symbol_node` anchor in the retrieved items,
  but the provider emitted that anchor *after* the dependency list, so a high-degree symbol (e.g.
  `StoryGenerationAgent`, 8 inbound + 38 outbound) truncated the anchor off the item cap and
  reported `found: false` for a real, well-connected symbol. Fixed by emitting the anchor first
  (`programGraphProvider.ts`). Verified: `get_dependents`/`get_dependencies("StoryGenerationAgent")`
  now return `found: true` (8 / 37); low-degree symbols and the mis-target controls above are
  unaffected.

## What changed most recently (2026-07-28)

Two deterministic checks were added to `AnswerGate`. Both are correct on the adversarial
suite (**36/37**, false-premise 5/5, near-miss 3/3, hotspots 3/3, **0% variance across 20
repeat runs**). Measured afterwards against the full 38-question realistic set, their
effect is much narrower than the adversarial numbers suggest -- recorded here so nobody
reads the suite score as a demo-safety guarantee:

- **Fabricated technology names are blocked** -- but the check **fired zero times across
  all 38 realistic questions**. It removes a *symptom* (naming Celery/GraphQL) rather than
  the underlying failure; see the "synchronous or background" entry above, which is the same
  question now getting the same wrong answer without naming a technology. Known latent false
  positive: presence is resolved through the logical-unit BM25 index, which misses terms that
  appear only in comments -- `OpenTelemetry` is in `app/core/community_engine.py:26` yet
  resolves as absent, so an accurate answer mentioning it would be blocked.
- **Citations are mechanically verified.** Across the 38 questions this produced 17 flags on
  8 questions, every one of them literally true (the named symbol really is absent from the
  named file). It independently changed **2 outcomes**: one correct (a `/me` route code block
  attributed to `app/core/auth.py`, where `get_current_user_info` actually lives in
  `app/routers/auth.py`) and **one false positive** -- `OrchestratorAgent` is a real class in
  `app/agents/orchestrator_agent.py`, and the answer never claimed otherwise; it merely listed
  three class names in one sentence near a citation for the first of them. The check pairs a
  symbol with the nearest file within 200 characters, so a list of names beside a list of paths
  can manufacture a claim nobody made. Treat a citation caveat as "check this," not "this is wrong."

Neither check can raise the pass rate: both only ever demote an answer. They are worth having
because two answers that used to pass silently now carry a warning -- not because more questions
now succeed.

Unchanged and still true: inbound-dependency prose remains NO-GO (below) -- re-confirmed on
2026-07-28, when "what's calling `OutputValidator.validate_confidence_alignment`?" produced a
fully invented caller chain through `MissionCoordinator.run_mission`; the only real caller is a
self-call at `app/agents/output_validator.py:313`. Applied branch logic remains a real model
ceiling.

## What changed on 2026-07-29

- **Session-to-session answer drift is fixed by default.** Ollama returns a different answer to the
  same question depending on what was asked before it — occasionally enough to flip whether an
  answer is delivered or withheld. `repoguide.determinism.resetModelBeforeSynthesis` removes that
  and is **on by default** as of 2026-07-29, at ~18% more latency (21.1s → 25.0s median). Nothing to
  turn on before a demo; if you need the lowest possible latency, set it false and accept that a
  repeated question may answer differently. **Update the timing expectations above accordingly** —
  warm answers now run ~25s rather than ~16–27s.
- **Invented helper-function lists are now caught.** The "what helpers does `<file>` have?" entry
  below was the shape that escaped every check; all five invented names in the measured case are now
  flagged.
- **One citation false positive is gone** — correctly listing several class names in one sentence no
  longer trips the checker.
- **Incomplete traces are flagged.** A walk-me-through answer that silently drops a file the evidence
  kept referencing now says so.
- **Unchanged:** execution-mode questions remain NO-GO — investigated on 2026-07-29 and confirmed to
  be model reasoning, not missing evidence. The synthesis prompt contained the complete route handler
  showing the direct, un-awaited call, and the answer still said "asynchronous".

## Retrieval reranking (added 2026-07-29, on by default)

A cross-encoder now rescores retrieved code against the actual question before it is packed into
the model's context. Retrieval scores never saw the question, so a genuinely relevant snippet could
be cut by the context budget while generic high-scoring matches survived. Measured over the 38-query
set against a no-reranker baseline: **misattributed citations roughly halved (11 → 6)** with no loss
of answer substance, for **~11% added latency (28.2s → 31.4s median)** and **no VRAM** (it runs on
CPU). It also partially recovered the long-standing multi-hop omission case, surfacing one of the
two files the answer had been dropping.

**Timing note for recording:** combined with the determinism reset, expect **~31s** per chat answer
rather than the ~16–27s in the checklist above.

## The one-line mental model to internalize before any demo

> **`gateStatus: pass` covers numbers, quotes, code, and file-identity claims only — it means
> RepoGuide found none of those fabricated. It does NOT cover relationship or integration claims
> in prose (e.g. "X integrates with / depends on / uses / calls Y"), and it is NOT a coverage or
> evidence-sufficiency check — a green gate on thin evidence (even `coverageScore: 0`) only means
> "no caught fabrications," not "well-grounded."** For any relationship claim, cross-check with
> `get_dependents` / `get_dependencies` before repeating it as fact.

State this plainly to yourself before demoing: a green gate is "no caught fabrications," not
"certified correct." The narrow factual and graph-backed questions above are where green genuinely
means green.

**The 2026-07-28 measurement that makes this concrete.** All 38 realistic questions were re-run and
every factual claim checked against source: **17 passed the gate, but only 6 were both accurate and
genuinely useful** (1.1 ImageQualityAgent's checks, 2.2 ObservabilityMiddleware's dependencies, 2.4
MarketplaceReadinessAgent's eligibility logic, 3.6 the LLM fallback chain, 4.1 the craft-classifier
rejection threshold, 4.5 the STT fallback order — all verified claim-by-claim, several quoting
source verbatim). Of the other 11: six were partly fabricated (invented helper names, an invented
`ViT-B/16` model, an invented `TTSService.synthesize`), four were generic filler with nothing
checkable, and one was flatly inverted. **A green gate carried a wrong answer roughly a third of the
time on this set.** Demo the six shapes above and their siblings; treat everything else as a
stretch question.
