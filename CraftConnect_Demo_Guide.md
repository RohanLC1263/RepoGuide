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

Two deterministic checks were added to `AnswerGate`, both verified live:

- **Fabricated technology names are now blocked.** A sentence asserting the project uses
  a library/framework absent from the entire repository ("uses an asynchronous task queue
  (e.g. Celery)", "exposes GraphQL resolvers") previously passed the gate completely
  clean -- prose nouns had no check of any kind. Correctly DENYING a false premise is
  never penalised.
- **Citations are now mechanically verified.** When an answer claims a symbol lives in or
  is used by a specific file, the real file is read and checked. This caught two genuine
  misattributions during the adversarial run. Surfaced as a caveat, not a refusal.

Adversarial suite after this round: **36/37** (`npm run eval:adversarial`), with
false-premise 5/5, near-miss symbols 3/3, hotspots 3/3, and **0% variance across 20
repeat runs**.

Unchanged and still true: inbound-dependency prose remains NO-GO (below), and applied
branch logic remains a real model ceiling.

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
