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

## Chat feature — the 5 questions to demo (RepoGuide chat panel)

Lead with the graph-backed ones; they route to the deterministic program graph, not model synthesis.

1. **"What depends on `MissionOrchestratorAgent`?"** — routes to the program graph; returns real
   dependents (main.py, mission_service.py, sibling agents). Deterministic, verified non-empty.
2. **"What does `StoryGenerationAgent` depend on?"** — program-graph dependencies; verified rich,
   non-empty output.
3. **"What is the confidence threshold in the customization interview agent, and what does it protect
   against?"** — the one narrative question that is safe: it resolves to the specific value `0.55`
   in `customization_interview_agent.py`. This was the flagship regression that was fixed and
   re-verified; the numeric gate now confirms the value instead of blocking it. **⚠️ USE THE EXACT
   WORDING ABOVE, DO NOT PARAPHRASE ON CAMERA.** Verified live: a natural rephrase ("how confident
   does the interview agent need to be before it accepts an answer?") makes the model emit `0.70`,
   which the gate correctly *blocks* — so an off-script phrasing reproduces the original block.
4. **"Where is `execute_mission` defined?"** — narrow symbol-location question (answer:
   `app/services/mission_service.py:62`). Checkable file-path claim, in the gate's wheelhouse.
5. **"Where is `RAGRetrieverAgent` defined?"** — narrow symbol-location question (same reliable
   shape as #4). *Replaces the earlier "What instantiates `RAGRetrieverAgent`?" — that phrasing
   reliably blocked (2/2) because the model fabricates an illustrative code block the gate catches.
   "Who creates/instantiates X" questions route through synthesis and are unreliable; ask the
   deterministic `get_dependents`/`get_dependencies` tools for wiring instead.*

## MCP feature — the 5 calls to demo (Claude Desktop)

Show the deterministic tools first — they are the strongest, most reproducible moments. Use
`gather_evidence` (cited evidence, no local synthesis) rather than `ask_repoguide` when you want
Claude Desktop itself to reason over grounded material.

1. **`get_dependents` on `MissionOrchestratorAgent`** — deterministic dependents from the program
   graph (**8** dependents; `found: true`). No model in the loop.
2. **`get_dependencies` on `StoryGenerationAgent`** — deterministic dependencies (**37** references;
   `found: true`). *(This high-degree symbol briefly returned `found: false` due to a symbol-node
   truncation bug — fixed 2026-07-25, see "Do NOT ask" note below.)*
3. **`get_dependents` on `ArtifactManager`** — smaller, clean dependent set (**4**); good for showing
   a focused blast-radius answer.
4. **`gather_evidence` — "What is the confidence threshold in the customization interview agent?"**
   — returns cited, ranked evidence (deterministic facts separated from retrieved code) with a
   plain-language grounding indicator, and *stops before synthesis* so Claude Desktop draws the
   conclusion. Note: `gather_evidence` also accepts `query` as an alias for `question`.
5. **`ask_repoguide` — the confidence-threshold question (same phrasing as chat #3).** The one
   synthesis question trusted for live use, because it resolves to a specific verified value the
   numeric gate confirms.

## Do NOT ask these live (reproduced as unreliable in the audit)

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
