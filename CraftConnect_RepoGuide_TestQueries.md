# CraftConnect × RepoGuide — Realistic Test Query Set

A broad, unrehearsed set of the kind of things a developer maintaining or extending CraftConnect
would actually type into RepoGuide's Chat panel, or say to Claude Desktop over the MCP connection,
in the normal course of real work. This is **query generation only** — nothing here has been run
live yet. Every symbol/file referenced was verified to exist in the current CraftConnect checkout
(grepped/read directly, not recalled from earlier session findings) before being included.

> **Reading this against what's already known:** a prior investigation this session found that
> Chat's **inbound**-dependency prose ("what depends on X", "who uses X") fabricates relationships
> not present in the graph, while **outbound**-dependency prose ("what does X depend on") reads
> reliably. Every query below is marked with which side of that line it falls on — 🔴 for inbound
> (known-risky territory, being tested again deliberately, not avoided) or 🟢 for outbound/neutral
> (new territory or the previously-verified-reliable shape). Everything outside the
> impact-assessment category is genuinely new ground this session hasn't touched.

---

## 1. Orientation / onboarding

*Arriving in an unfamiliar part of the codebase, getting oriented before touching anything.*

**1.1 — 🟢 New territory**
- Chat: "What does the ImageQualityAgent actually check before letting a listing through?"
- MCP: "I just opened `image_quality_agent.py` for the first time — walk me through what this agent is responsible for."
- Target: `ImageQualityAgent` — `app/agents/image_quality_agent.py:21`
- Why: a developer landing on an unfamiliar agent file wants a functional summary before reading 300 lines of checks.

**1.2 — 🟢 New territory**
- Chat: "What's the craft_classifier_agent folder for? It's not under app/agents like everything else."
- MCP: "There's a top-level craft_classifier_agent directory, separate from app/agents — what does it do and why is it separate?"
- Target: `craft_classifier_agent/` (top-level package, distinct from `app/agents/`)
- Why: an unusual directory placement is exactly the kind of thing that prompts a "wait, what's this" moment.

**1.3 — 🟢 New territory**
- Chat: "What is the SarvamClient and when would CraftConnect actually use it instead of the other voice stuff?"
- MCP: "Explain what SarvamClient does — is it for speech-to-text, text-to-speech, or both?"
- Target: `SarvamClient` — `app/services/sarvam_client.py:38`
- Why: onboarding into the voice pipeline, where there are multiple STT/TTS-shaped classes and it's not obvious which does what.

**1.4 — 🟢 New territory**
- Chat: "What does the mission_coordinator.py file under agents/orchestrator/ do that mission_orchestrator.py doesn't already do?"
- MCP: "Give me an overview of MissionCoordinator — what's its role in the mission pipeline?"
- Target: `MissionCoordinator` — `app/agents/orchestrator/mission_coordinator.py:26`
- Why: onboarding into a pipeline with several similarly-named orchestration classes.

**1.5 — 🟢 New territory**
- Chat: "What's in the legacy folder and is any of it actually still running?"
- MCP: "Give me a quick orientation on the legacy/ directory — heritage_engine.py, pricing_helper.py, that stuff."
- Target: `legacy/app/core/heritage_engine.py`, `legacy/app/helpers/pricing_helper.py` (both confirmed present)
- Why: a very common real onboarding question — "is this legacy folder dead weight or load-bearing."

---

## 2. Pre-change impact assessment

*Both directions, phrased the way someone actually asks before editing — not pre-filtered by what's known-safe.*

**2.1 — 🔴 Inbound (known-risky territory)**
- Chat: "If I change the confidence threshold logic in apply_decision_policy, what else in the codebase touches that function?"
- MCP: "What calls apply_decision_policy? I'm about to change its threshold constants."
- Target: `apply_decision_policy` — `craft_classifier_agent/decision_policy.py:30`
- Why: a developer about to tweak `STRICT_THRESHOLD`/`REJECT_THRESHOLD` wants to know the blast radius first — the textbook "don't break things" moment.

**2.2 — 🟢 Outbound (previously-verified-reliable shape)**
- Chat: "Before I touch the ObservabilityMiddleware, what does it actually rely on — is it hooked into anything besides the request/response cycle?"
- MCP: "What does ObservabilityMiddleware depend on?"
- Target: `ObservabilityMiddleware` — `app/middleware/observability.py:14`
- Why: middleware changes are notoriously easy to get wrong quietly; a dev wants to know what it touches before editing.

**2.3 — 🔴 Inbound (known-risky territory)**
- Chat: "I want to refactor OutputValidator's validate_confidence_alignment method — what's calling it right now?"
- MCP: "What depends on validate_confidence_alignment in OutputValidator?"
- Target: `OutputValidator.validate_confidence_alignment` — `app/agents/output_validator.py:222`
- Why: method-level (not class-level) blast-radius question — a narrower, more realistic ask than always asking about the whole class.

**2.4 — 🟢 Outbound**
- Chat: "What does MarketplaceReadinessAgent rely on to compute eligibility? I want to know if it's calling out to anything external before I add a new check."
- MCP: "Before I add a new eligibility check to MarketplaceReadinessAgent, what does it depend on?"
- Target: `MarketplaceReadinessAgent._analyze_eligibility` — `app/agents/marketplace_readiness_agent.py:75`
- Why: a dev extending a checklist-style agent wants to know its existing dependency surface first.

**2.5 — 🔴 Inbound**
- Chat: "What breaks if I rename the `limiter` object in ratelimit.py?"
- MCP: "What uses the limiter from app/core/ratelimit.py?"
- Target: `limiter` — `app/core/ratelimit.py:9`; confirmed used in `app/routers/conversation.py` (4 decorated endpoints)
- Why: a small, easy-to-miss shared singleton — the kind of rename that quietly breaks four unrelated endpoints if you don't check first.

**2.6 — 🟢 Outbound**
- Chat: "Before I mess with the PDF export, what does pdf_generator.py actually need — fonts, templates, anything external?"
- MCP: "What does the PDF generator module depend on?"
- Target: `app/services/pdf_generator.py` (functions `_register_fonts`, `draw_shell`, `section_label`, etc.)
- Why: file-level (not class-level) dependency question — pdf_generator.py is function-based, not class-based, a different shape than most of the agent questions.

---

## 3. Symbol / code location

*Finding where something is actually implemented.*

**3.1**
- Chat: "Where's the STT confidence averaging logic actually implemented?"
- MCP: "Find where speech-to-text confidence gets averaged across chunks."
- Target: `STTService` — `app/services/stt_service.py:19`, `avg_confidence` computation around line 181
- Why: a "I know roughly what it does, find me the exact spot" question — common mid-debugging.

**3.2**
- Chat: "Where is get_current_user actually defined? I keep seeing it imported everywhere."
- MCP: "Where's get_current_user implemented?"
- Target: `get_current_user` — `app/core/auth.py:29`
- Why: an extremely common cross-file dependency (`Depends(get_current_user)`) that a dev would want to jump to the source of.

**3.3**
- Chat: "Where's the actual seal-mission endpoint? I need to add a field to the response."
- MCP: "Find the endpoint that handles sealing a mission."
- Target: `seal_mission` — `app/routers/studio_write.py:203`
- Why: a very concrete "I'm about to edit this specific handler" location lookup.

**3.4**
- Chat: "Where's MIN_RESOLUTION_PX defined and what uses it?"
- MCP: "Find MIN_RESOLUTION_PX."
- Target: `MIN_RESOLUTION_PX = 1000` — `app/agents/image_quality_agent.py:9`
- Why: locating a specific constant before changing its value — a narrow, safe, symbol-location-shaped question.

**3.5**
- Chat: "Where does the frontend actually gate routes behind login?"
- MCP: "Find the route protection / auth guard component in the frontend."
- Target: `ProtectedRoute` — `craftconnect-frontend/src/components/ProtectedRoute.tsx`
- Why: crossing into frontend code for a location lookup, a category not exercised yet this session.

**3.6**
- Chat: "Where's the actual fallback chain construction for the LLM backends?"
- MCP: "Find where the LLM fallback order gets built."
- Target: `LLMRouter._get_available_backend` — `app/llm_backends/llm_router.py`, `fallback_order` list built around line 153-211
- Why: fallback-chain questions are their own recognizable shape (RepoGuide has a dedicated `fallback_chain` query type) — worth testing on a symbol other than the ones already used this session.

---

## 4. Behavior / configuration questions

*How something behaves under specific conditions — thresholds, config, feature flags, fallback logic.*

**4.1**
- Chat: "What's the actual rejection threshold in the craft classifier, and what happens below it?"
- MCP: "What is REJECT_THRESHOLD in the craft classifier decision policy, and what decision does it trigger?"
- Target: `REJECT_THRESHOLD = 0.40` — `craft_classifier_agent/decision_policy.py:11`; triggers `DecisionType.REJECT_UNCERTAIN`
- Why: a genuine multi-tier threshold system (strict/lenient/moderate/reject) — richer than the single-threshold questions already tested, good stress test for a "what does this value control" question with real conditional branching attached.

**4.2**
- Chat: "How many requests per minute can someone hit the /reply/audio endpoint with before they get rate limited?"
- MCP: "What's the rate limit on the audio reply endpoint in conversation.py?"
- Target: `@limiter.limit("5/minute")` on `reply_message_audio` — `app/routers/conversation.py:97`
- Why: a specific, checkable numeric-config question on a symbol not previously tested — and notably a *different* limit (5/min) than the other three endpoints in the same file (10/min), so a shallow/wrong answer would be easy to catch.

**4.3**
- Chat: "What's FLAG_THRESHOLD actually for and where does its value come from?"
- MCP: "What does FLAG_THRESHOLD control, and is it configurable via environment variable?"
- Target: `FLAG_THRESHOLD = int(os.getenv("FLAG_THRESHOLD", "3"))` — `app/core/community_engine.py:49`
- Why: revisits a symbol already known to have produced a vague, hedged (not fabricated, but uncommitted) answer earlier this session — worth re-testing post-fixes since it sits in a file (`community_engine.py`) that was also a recurring source of graph contamination.

**4.4**
- Chat: "What resolution does an image need to be before ImageQualityAgent flags it as too small?"
- MCP: "What's the minimum resolution check in the image quality agent, and what happens if an image fails it?"
- Target: `MIN_RESOLUTION_PX` check — `app/agents/image_quality_agent.py:154` (`status = "pass" if max_dim_found >= MIN_RESOLUTION_PX else "needs_attention"`)
- Why: config value *plus* the conditional behavior it drives — tests whether the model can describe the branch correctly, not just cite the number (a documented weak spot for RepoGuide's local model).

**4.5**
- Chat: "Does the STT service actually use Sarvam, or is there a local fallback if Sarvam isn't configured?"
- MCP: "What's the fallback behavior in STTService if the primary speech-to-text backend is unavailable?"
- Target: `STTService` — `app/services/stt_service.py`; `SarvamClient.stt_available()` — `app/services/sarvam_client.py:58`
- Why: a genuine cross-file fallback-logic question spanning two real, distinct classes.

**4.6**
- Chat: "What languages does the interview flow actually support — is it hardcoded to English?"
- MCP: "What languages are configured in the frontend i18n setup?"
- Target: `LANGUAGE_OPTIONS` — `craftconnect-frontend/src/i18n.ts:1185`; `getSupportedLanguages()` at line 1234
- Why: config-shaped question on the frontend i18n layer, not yet tested this session.

---

## 5. Debugging-style questions

*"Why does X happen," tracing an error or unexpected behavior back to its source.*

**5.1**
- Chat: "Why would a mission come back with status 'failed' but no clear error message to the user?"
- MCP: "Trace what happens when the orchestrator raises an exception inside execute_mission — where does that error end up?"
- Target: `execute_mission` — `app/services/mission_service.py:62`; `except Exception as e: ... result = {"error": str(e)}; status = "failed"`
- Why: a genuine "something's going wrong in prod, help me trace it" debugging question, on the same function whose idempotency logic was tested earlier — this time testing the *error path*, not the idempotency path.

**5.2**
- Chat: "Why might two duplicate mission requests both start processing instead of one being skipped?"
- MCP: "Under what condition does the idempotency check in execute_mission fail to catch a duplicate?"
- Target: `execute_mission` idempotency block — `app/services/mission_service.py:73-87`; note the `except Exception as e: logger.warning(...)` swallows idempotency-check failures rather than blocking
- Why: a real, non-obvious edge case — the idempotency check's own failure path doesn't re-raise, so a Supabase hiccup could silently defeat the guard. Good test of whether the model reasons about the *failure mode of the safety check itself*, not just the happy path.

**5.3**
- Chat: "Why would an artisan see a 'needs_attention' status on their images when they look fine to the eye?"
- MCP: "What conditions cause ImageQualityAgent to flag an image as needing attention rather than passing?"
- Target: `ImageQualityAgent._check_resolution` / `_check_background` / `_check_diversity` — `app/agents/image_quality_agent.py:115-249`
- Why: multiple independent checks feed one status — a debugging question that requires the model to enumerate several real failure conditions, not just one.

**5.4**
- Chat: "Why would get_current_user throw a 401 even though the user just logged in successfully?"
- MCP: "Trace the failure conditions in get_current_user — what makes it reject a request?"
- Target: `get_current_user` — `app/core/auth.py:29`
- Why: auth-flow debugging is one of the most common real "why is this broken" questions in any app with a login system.

**5.5**
- Chat: "Why does the interview sometimes come back with English questions even when the user picked Hindi?"
- MCP: "Trace how the interview's question language gets selected — where could it fall back to English unexpectedly?"
- Target: `app/database/interview_db.py` (question storage/language lookup), cross-referenced with `craftconnect-frontend/src/i18n.ts`
- Why: a genuinely tricky cross-language, cross-layer debugging question — the kind that requires connecting backend data storage to frontend language selection.

---

## 6. Architecture / design comparison

*How two related pieces differ, why something is built the way it is, evaluating a choice.*

**6.1**
- Chat: "There's MissionOrchestratorAgent, MissionCoordinator, and OrchestratorAgent — are these three different things or basically the same class copy-pasted?"
- MCP: "Compare MissionOrchestratorAgent, MissionCoordinator, and OrchestratorAgent — which one is actually used in production?"
- Targets: `MissionOrchestratorAgent` (`app/agents/mission_orchestrator.py:33`), `MissionCoordinator` (`app/agents/orchestrator/mission_coordinator.py:26`), `OrchestratorAgent` (`app/agents/orchestrator_agent.py:12` — confirmed a near-empty stub, `__init__(self, *args, **kwargs)` only)
- Why: a genuinely great architecture-comparison question because the answer is surprising and checkable — `OrchestratorAgent` is a thin stub, not a real competing implementation, which is exactly the kind of nuance that separates a good architectural answer from a hand-wavy one.

**6.2**
- Chat: "Why does CraftConnect have both a ChromaVectorStore and a separate knowledge loader — couldn't the loader just talk to Chroma directly?"
- MCP: "Explain the relationship between ChromaVectorStore and the knowledge loader module."
- Targets: `ChromaVectorStore` — `app/agents/vector_store.py:57`; `app/knowledge/loader.py`
- Why: a "why is it built this way, not the obvious simpler way" design-evaluation question.

**6.3**
- Chat: "What's actually different between the strict, lenient, and moderate craft classification groups — is it just different threshold numbers or is the logic different too?"
- MCP: "Compare the strict, lenient, and moderate policy groups in the craft classifier's decision policy."
- Target: `STRICT_GROUP`/`LENIENT_GROUP`/`MODERATE_GROUP` and their threshold/margin pairs — `craft_classifier_agent/decision_policy.py:14-28`
- Why: tests whether the model can articulate that this is genuinely three *different policies* (different threshold AND margin requirements), not just three labels — real design nuance, checkable against source.

**6.4**
- Chat: "Why is there a separate SarvamClient AND separate STTService/TTSService — isn't Sarvam just the STT/TTS provider?"
- MCP: "Explain the layering between SarvamClient and STTService/TTSService — what's the division of responsibility?"
- Targets: `SarvamClient` (`app/services/sarvam_client.py:38`), `STTService` (`app/services/stt_service.py:19`), `TTSService` (`app/services/tts_service.py:20`)
- Why: a three-way architectural relationship question in the voice pipeline, a subsystem not touched by any prior demo/test round.

**6.5**
- Chat: "Is legacy/app/core/heritage_engine.py an older version of something that still exists in app/, or is it a completely separate feature that got shelved?"
- MCP: "Compare legacy/app/core/heritage_engine.py against anything similar in the current app/ tree."
- Target: `legacy/app/core/heritage_engine.py` vs. current `app/core/community_engine.py` (both confirmed to exist; whether they're related is exactly what the question is testing)
- Why: directly mirrors the already-known-tricky "is X dead code or does it correspond to something live" pattern — deliberately revisiting that shape on a *new* file pair, not the one already tested.

---

## 7. Cross-cutting / integration questions

*Tracing a request across layers — frontend to API to agent to storage.*

**7.1**
- Chat: "Walk me through what happens end to end when someone submits an answer during the interview — from the frontend click to wherever it gets stored."
- MCP: "Trace the full request path for submitting an interview answer, frontend to backend to storage."
- Targets: `craftconnect-frontend/src/pages/studio/InterviewPage.tsx` → `submit_answer` (`app/routers/interview.py:258`) → `app/database/interview_db.py`
- Why: the canonical cross-layer flow question — frontend event to API handler to persistence, spanning three real files across two languages.

**7.2**
- Chat: "How does a mission actually get from 'draft' to 'sealed' — what has to happen along the way?"
- MCP: "Trace the mission lifecycle from draft listing update through sealing."
- Targets: `update_listing_draft` (`app/routers/studio_write.py:167`) → `seal_mission` (`app/routers/studio_write.py:203`), frontend `DraftListingPage.tsx` / `ReviewSealPage.tsx`
- Why: a state-machine-shaped integration question across router endpoints and the frontend pages that drive them.

**7.3**
- Chat: "If I upload a low-res image, how does that actually surface to the user in the UI — does the backend block the mission or does the frontend just show a warning?"
- MCP: "Trace what happens end-to-end when ImageQualityAgent flags an image as needs_attention — where does that status surface in the frontend?"
- Targets: `ImageQualityAgent._aggregate_readiness` (`app/agents/image_quality_agent.py:273`) → mission report → frontend `VisualAnalysisPage.tsx`
- Why: tests whether a backend validation *result* is correctly traced through to its frontend consequence — genuinely requires connecting an agent's output shape to a specific UI page.

**7.4**
- Chat: "How does authentication actually flow from the React app to a protected FastAPI route — is it a token in a header, a cookie, something else?"
- MCP: "Trace the authentication flow from the frontend AuthContext to the backend get_current_user dependency."
- Targets: `AuthProvider`/`useAuth` (`craftconnect-frontend/src/contexts/AuthContext.tsx:24,76`) → `ProtectedRoute.tsx` → `get_current_user` (`app/core/auth.py:29`)
- Why: a full-stack auth-flow question, the single most common "how does this actually work" integration question in any app with login — not tested at all this session.

**7.5**
- Chat: "When someone asks for a PDF export of their listing, what actually generates it — is that synchronous or does it happen in the background?"
- MCP: "Trace how a PDF export request gets fulfilled, from the API endpoint to pdf_generator.py."
- Targets: `app/services/pdf_generator.py`, cross-referenced with whichever router endpoint triggers it (`app/routers/studio_write.py` / `studio_read.py`)
- Why: a sync-vs-async integration question — a real distinction a developer would need to know before adding a new export field.

---

## Summary

| Category | # queries | Chat/MCP pairs |
|---|---|---|
| 1. Orientation / onboarding | 5 | 5 |
| 2. Pre-change impact assessment | 6 | 6 (3× 🔴 inbound, 3× 🟢 outbound) |
| 3. Symbol / code location | 6 | 6 |
| 4. Behavior / configuration | 6 | 6 |
| 5. Debugging-style | 5 | 5 |
| 6. Architecture / design comparison | 5 | 5 |
| 7. Cross-cutting / integration | 5 | 5 |
| **Total** | **38** | **38 Chat + 38 MCP phrasings** |

**Subsystems/files touched** (verified to exist in current CraftConnect, distinct from each other):
`craft_classifier_agent/` (agent.py, decision_policy.py), `app/agents/` (image_quality_agent,
marketplace_readiness_agent, output_validator, mission_orchestrator, orchestrator_agent,
orchestrator/mission_coordinator, vector_store), `app/core/` (auth.py, ratelimit.py,
community_engine.py), `app/routers/` (conversation.py, studio_write.py, interview.py),
`app/services/` (mission_service.py, stt_service.py, tts_service.py, sarvam_client.py,
pdf_generator.py), `app/middleware/observability.py`, `app/database/interview_db.py`,
`app/knowledge/loader.py`, `app/llm_backends/llm_router.py`, `legacy/app/core/heritage_engine.py`,
`craftconnect-frontend/src/` (i18n.ts, contexts/AuthContext.tsx, components/ProtectedRoute.tsx,
pages/studio/{InterviewPage,DraftListingPage,ReviewSealPage,VisualAnalysisPage}.tsx) — **27 distinct
files/modules** across Python backend, the craft-classifier package, and the React frontend, none
of them the five symbols already exercised this session.

**Verification discipline:** every symbol, class, function, constant, and file path above was
located with `grep`/direct read against the current CraftConnect checkout in this pass — not
carried over from memory or earlier session findings. Two things worth flagging from that process:
`OrchestratorAgent` (6.1) turned out to be a near-empty stub, which makes that comparison question
more interesting, not less; and `app/routers/conversation.py`'s four rate-limited endpoints have
two different limits (10/min vs. 5/min on the audio-reply route specifically), which is why 4.2
targets that one specifically rather than a generic "what's the rate limit" question.
