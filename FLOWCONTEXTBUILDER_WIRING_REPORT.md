# Wiring `FlowContextBuilder` into the canonical query pipeline

## What got wired

New `FlowContextProvider implements EvidenceProvider` (`src/query/flowContextProvider.ts`), modeled directly on `ProgramGraphProvider`. It constructs `FlowContextBuilder` fresh on every `retrieve()` call — pulling `ComprehensionEngine.getFlowExtractor()` fresh each time rather than caching it at provider-construction time — and converts each `FlowContextBlock` in a non-null `EnrichedFlowContext.flowContext.contextBlocks` into an `EvidenceItem` via the same `withNormalizedEvidenceFields` helper every other provider uses. Registered into the `RetrievalOrchestrator` provider array — the frozen, canonical integration point (`ARCHITECTURE_FREEZE.md` Part 4) — not into `chatPrompt.ts`/`explainPrompt.ts` (confirmed themselves dead code, zero call sites in `src/`) or as a new ad hoc field on `EvidencePacketBuilderStores` (the shape the freeze doc explicitly forbids).

**Two premises from the plan needed correcting during implementation, not assumed:**

1. **The category gate was initially wrong, measured against real questions.** The plan scoped `queryCategories` to `dependency_analysis`/`architectural_reasoning`/`debugging` — real `QueryCategory` values, correctly mapped from `impact_analysis`/`architecture_analysis`/`runtime_intelligence`-style `QueryType`s. But the *actual* golden questions this whole thread has been about ("Trace the execution flow when...", "How does the cache logic work...") get classified by the live regex planner (`evidencePlanner.ts`) as `queryType: 'behavior_explanation'` or `'unknown'` — neither of which has a dedicated case in `mapQueryTypeToCategory()`, so both fall through to `'repository_exploration'`. Added that category to `FlowContextProvider.capabilities.queryCategories` (and a matching `selectProviderIds()` case in `executionPlanner.ts`) after confirming this directly against the real question text, not assumed from the category names alone.
2. **A third construction site existed that the plan didn't name.** `RetrievalOrchestrator`/`QueryDispatcher` are built in three places, not two: `extension.ts`, `mcp/mcpServer.ts` — and `src/evaluation/queryPipelineHarness.ts`, which is what `eval:mini` (and thus this report's own verification) actually uses. Missing this meant the first two rounds of verification technically succeeded (provider constructed, category-gated correctly) but zero real eval questions ever saw a `flow_context` item, because the harness the eval runs through had never been given the new provider. Found by checking `capturedContext.retrievedChunkIds` for `flow_context_`-prefixed ids after the category fix and seeing none — wired the harness the same way as the other two once this was traced to its root cause.

## Handling "not yet built"

No new logic needed — confirmed, not assumed, via a standalone test against a freshly-created workspace with no comprehension run: `initialize()` reports `{ ready: false, diagnostics: [...] }`, `canHandle()` declines cleanly with `{ canHandle: false, reason: 'Call graph not yet built; flow context unavailable.' }`, no throw. `CallGraphBuilderV2.getFlowExtractor()` returning `null` (confirmed non-throwing) is the entire mechanism; `RetrievalOrchestrator` already treats a `canHandle: false` decision as a normal, logged skip.

## Verification

**Static**: `tsc --noEmit`, `eslint src` clean.

**Real data, standalone** (`ComprehensionEngine.loadExisting()` against axios/yarn's already-comprehension-built `.repoguide` state from `CALLGRAPHV2_WIRING_REPORT.md`):

| Repo | `readiness()` | `canHandle()` (dependency_analysis/architectural_reasoning/debugging/factual_lookup) | `retrieve()` |
|---|---|---|---|
| axios | READY | true/true/true/**false** (correct decline, wrong category) | 10 items, e.g. `dispatchRequest`, `getAdapter` — genuinely the axios adapter-dispatch chain, 3.4ms |
| yarn | READY | true/true/true/**false** | 10 items, e.g. `fetchChangedWorkspaces`, `fetchRoot` — genuinely yarn's git-fetch chain, 8.8ms |
| fresh (no comprehension run) | — | `initialize()` reports not-ready, `canHandle()` declines cleanly, no throw | not attempted (correctly declined) |

**Real data, end-to-end through the actual eval pipeline** (after fixing both premises above): 8 of yarn's 19 golden questions and 6 of axios's 19 actually received `flow_context` items in their captured context — including `yarn-flow-2` ("How does the cache logic work when downloading a package?" → `fetchPackageFromCache`) and `yarn-flow-3` ("How are plugins loaded at CLI startup?" → `getAvailablePlugins`), the exact questions this whole call-graph thread traces back to.

**Eval scoring, before/after** (against `CALLGRAPHV2_WIRING_REPORT.md`'s baselines, `--use-existing-artifacts`, no reindex needed):

| Corpus | Before | After | Flow-specific scores |
|---|---|---|---|
| yarn | 55% | 55% (0.2 pt, noise) | `yarn-flow-1..4`: `1,2,1,2` before and after — byte-identical, despite `flow_context` items now genuinely present in `yarn-flow-2`/`yarn-flow-3`'s evidence set |
| axios | 38.16% | 39% (0.84 pt) | `ax-flow-1..4`: all `flow: 0` before and after; axios's flow questions specifically received zero `flow_context` items this run (6 *other* questions did) |

**Per your explicit instruction not to assume this moves scores: it didn't, measurably.** Both corpora's movement (0.2–0.84 points) is well within this session's already-established LLM-graded run-to-run noise band (yarn alone swung 59%→55.26%→55% across three identical-code reruns two tasks ago). The flow-containment score component reads `call_graph_v2.json` directly (confirmed in `CALLGRAPHV2_WIRING_REPORT.md`), which this wiring doesn't touch — so `flow` sub-scores were never going to move via this path, and they didn't. What changed is real and verified independently of the aggregate score: genuinely relevant flow-trace evidence now reaches the LLM's prompt for questions where it's applicable, for the first time ever in production. Whether that improves answer quality on THESE 19 golden questions specifically, versus a broader/different query set, is not something this pass's evidence settles either way.

**Full jest suite**: 214/268, matching the established baseline (one run mid-session hung for ~40 minutes with idle worker processes — confirmed via `Get-Process` showing near-zero accumulated CPU time across all jest workers, killed and retried cleanly at normal ~15-20s speed; not reproducible, not traced to this change, noted here rather than silently ignored since a 40-minute silent hang is not normal and deserves a plain mention even without a root cause).

## Explicit non-goals

- `medusa` was not re-verified at scale for this pass — the underlying `getFlowExtractor()`/`FlowExtractor.extractFlow()` mechanics were already proven fast at medusa scale in `CALLGRAPHV2_WIRING_REPORT.md`, and `FlowContextProvider` is a thin, cheap wrapper around them (confirmed sub-10ms per call on yarn's larger graph); re-running the full medusa comprehension pass would not have taught anything new about this specific change.
- `EnrichedFlowContext.reliability.caveat`/`gaps` are not threaded into `EvidencePacket.gaps` — a different mechanism (Phase 3's truncation-gap work), and doing so would mean touching `evidencePacketBuilder.ts`, defeating the point of the provider shape's zero-touch integration with the rest of the pipeline.
- `mapQueryTypeToCategory()`'s classification logic itself was not changed — only `FlowContextProvider`'s own declared `queryCategories` and the corresponding `selectProviderIds()` entries. Other providers'/callers' routing is unaffected.
