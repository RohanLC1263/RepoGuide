# Change Log

All notable changes to the "repoguide" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Discipline going forward

- Every merged change that a user or contributor would notice (a new command, a
  behavior change, a bug fix, a security fix) gets an entry here **in the same
  change**, not as a follow-up. This mirrors the per-language `*_SEMANTIC_PROVIDER_REPORT.md`
  reports and `RELEASE_ENGINEERING_REPORT.md`: real, dated, specific -- not "various fixes."
- Entries land under `[Unreleased]` as they merge. When `package.json`'s `version`
  is bumped for an actual release, the `[Unreleased]` heading is renamed to that
  version with today's date, and a fresh empty `[Unreleased]` section is added above it.
- Categories, in order, only when non-empty: `Added`, `Changed`, `Fixed`, `Security`, `Removed`.

## [Unreleased]

### Added
- New MCP tool **`get_dependencies`**, the reverse of `get_dependents`: "what
  does this symbol itself call/read/import/instantiate/fall back to," not
  "who depends on it." Found via a developer-workflow gap analysis that
  `ProgramGraphStore` already maintains both inbound and outbound edge
  adjacency maps in memory -- `getDependencies()` is a literal outbound
  mirror of the existing `getDependents()` (same file/symbol resolution, same
  five edge types and confidence heuristic, walked via `outEdges`/`edge.to`
  instead of `inEdges`/`edge.from`), confirmed via a real induced test that
  the two are genuine inverses on the same edge set (`A calls B` <=> `B is
  called by A`). `ProgramGraphProvider` now computes both directions
  unconditionally for every retrieval, tagged with distinct
  `graph_*_target_dependency` signals; a new `buildDependenciesResponse`
  (twin of `buildDependentsResponse`) filters the combined item set down to
  just the outbound relationships (`callee`/`read_target`/`import_target`/
  `instantiation_target`/`fallback_target`), the mirror image of how
  `get_dependents`' own builder already filters to only the inbound ones from
  that same superset -- purely additive, `get_dependents`' output is
  unchanged.
- New command **"RepoGuide: Copy MCP Config for Claude Code / Claude Desktop"**
  (`repoguide.copyMcpConfig`), closing an MCP discoverability gap: previously
  nothing in the extension UI signaled that MCP existed at all (no command,
  status bar item, or sidebar element), and connecting a client required
  hand-constructing a `--workspaceRoot`/`--repoguideDir` invocation from a
  README code block. Investigated first rather than assumed: RepoGuide's MCP
  server is a **stdio-transport** process (`StdioServerTransport`, see
  `mcpServer.ts`), meaning it's spawned *by* the connecting client, not a
  daemon the extension could meaningfully start/stop/track -- so a "Start MCP
  Server" command was considered and deliberately not built (its stdio would
  connect to the extension host, reachable by no external client; making that
  meaningful would mean an HTTP/SSE transport, a real new subsystem out of
  scope here). The new command instead does the one thing users actually
  need: a QuickPick between three config formats (Claude Code project
  `.mcp.json`, `claude mcp add` CLI one-liner, Claude Desktop
  `claude_desktop_config.json`), builds the correct snippet with
  `--workspaceRoot`/`--repoguideDir`/the extension's own `mcpServer.js` path
  already filled in, and copies it to the clipboard. Snippet construction is
  a new pure, VS Code-free module (`src/mcp/mcpConfigBuilder.ts`, same
  extraction pattern as `dependentsResponseBuilder.ts`) so it's unit-testable
  without spinning up the extension host. The one genuinely fiddly part --
  Windows path backslashes -- is handled correctly by building a real object
  and running it through `JSON.stringify` for the two JSON formats (which
  double-escapes backslashes and round-trips back to the exact original
  path, verified in a dedicated test) versus shell-quoting (not
  backslash-escaping) the same paths for the CLI one-liner, where doubling
  would have produced a wrong shell path. Before generating a config, the
  command checks `isWorkspaceReadyForMcpConfig` against the workspace's
  existing `lastIndexedAt` signal (the same one `deriveIndexHealthStatusText`
  already treats as "Ready" -- no new, second readiness check introduced) and
  warns inline ("Index this workspace first") rather than handing back a
  config that would only fail later inside a client's much-less-legible
  logs, since the MCP server itself refuses to start against an unindexed
  workspace. The sidebar's Index Health section gained one line noting MCP
  is available and that a client must be restarted after any reindex (the
  server has no live reindex path, see the "MCP Server" README section).
  Explicitly not built, per the investigation that preceded this change: any
  spawn/start/stop/restart command, process liveness/heartbeat detection, a
  status bar item, or VS Code's native `McpServerDefinitionProvider` route
  (a real option for VS Code-native clients specifically, but a different
  audience and its own design pass) -- confirmed via a dedicated test that
  `mcpConfigBuilder.ts` never references `child_process`/`spawn`/`exec`.
- New command **"RepoGuide: Copy MCP Config for Claude Code / Claude Desktop"**
  (`repoguide.copyMcpConfig`), closing an MCP discoverability gap: previously
  nothing in the extension UI signaled that MCP existed at all (no command,
  status bar item, or sidebar element), and connecting a client required
  hand-constructing a `--workspaceRoot`/`--repoguideDir` invocation from a
  README code block. Investigated first rather than assumed: RepoGuide's MCP
  server is a **stdio-transport** process (`StdioServerTransport`, see
  `mcpServer.ts`), meaning it's spawned *by* the connecting client, not a
  daemon the extension could meaningfully start/stop/track -- so a "Start MCP
  Server" command was considered and deliberately not built (its stdio would
  connect to the extension host, reachable by no external client; making that
  meaningful would mean an HTTP/SSE transport, a real new subsystem out of
  scope here). The new command instead does the one thing users actually
  need: a QuickPick between three config formats (Claude Code project
  `.mcp.json`, `claude mcp add` CLI one-liner, Claude Desktop
  `claude_desktop_config.json`), builds the correct snippet with
  `--workspaceRoot`/`--repoguideDir`/the extension's own `mcpServer.js` path
  already filled in, and copies it to the clipboard. Snippet construction is
  a new pure, VS Code-free module (`src/mcp/mcpConfigBuilder.ts`, same
  extraction pattern as `dependentsResponseBuilder.ts`) so it's unit-testable
  without spinning up the extension host. The one genuinely fiddly part --
  Windows path backslashes -- is handled correctly by building a real object
  and running it through `JSON.stringify` for the two JSON formats (which
  double-escapes backslashes and round-trips back to the exact original
  path, verified in a dedicated test) versus shell-quoting (not
  backslash-escaping) the same paths for the CLI one-liner, where doubling
  would have produced a wrong shell path. Before generating a config, the
  command checks `isWorkspaceReadyForMcpConfig` against the workspace's
  existing `lastIndexedAt` signal (the same one `deriveIndexHealthStatusText`
  already treats as "Ready" -- no new, second readiness check introduced) and
  warns inline ("Index this workspace first") rather than handing back a
  config that would only fail later inside a client's much-less-legible
  logs, since the MCP server itself refuses to start against an unindexed
  workspace. The sidebar's Index Health section gained one line noting MCP
  is available and that a client must be restarted after any reindex (the
  server has no live reindex path, see the "MCP Server" README section).
  Explicitly not built, per the investigation that preceded this change: any
  spawn/start/stop/restart command, process liveness/heartbeat detection, a
  status bar item, or VS Code's native `McpServerDefinitionProvider` route
  (a real option for VS Code-native clients specifically, but a different
  audience and its own design pass) -- confirmed via a dedicated test that
  `mcpConfigBuilder.ts` never references `child_process`/`spawn`/`exec`.
- Every approved chat/`ask_repoguide` answer (single-shot and decomposed) now
  exports the evidence behind it to `.repoguide/last_query_evidence.json` --
  a rolling, newest-first history (capped at 10) so a connected Claude Code
  (MCP) session can reuse the same context instead of rediscovering it
  independently. Follows the exact same shape as this session's `retrieve_raw_evidence`
  design: file/line/symbol references only, never evidence content (index-time
  chunk text can lag the real file; a caller `Read`s the file itself), so there's
  no new redaction surface either -- there is no content field for a redacted
  `.env` value to leak through. One call site (`QueryDispatcher.emitFinalAnswer`)
  covers chat and MCP, single-shot and decomposed (`SubAnswerMerger` already
  merges sub-packets into one union packet for the merge-verification gate;
  the export reuses it) uniformly. Confirmed with a real, non-mocked
  `QueryDispatcher` that a gate-blocked refusal writes no export (the block
  branch returns before the call site is ever reached) while a real delivered
  answer does, and that the eval-harness client is excluded so evaluation
  runs don't pollute the file. Export failures are caught and logged, never
  allowed to affect answer delivery. New MCP tool `get_last_chat_evidence`
  (optional `limit`) reads the same file fresh per call.
- Chat sidebar now shows a persistent readiness status line above the input,
  instead of readiness being visible only in the separate Index Health panel.
  `IndexManager` gained an `isAnnotating` flag (mirroring the existing
  `isIndexing`) set around the background file-annotation batch that
  `fullIndex()` kicks off via a fire-and-forget `setTimeout` -- previously
  `isIndexing` alone went false as soon as the synchronous indexing work
  finished, well before that background annotation actually completed, so
  there was no signal for the true "fully settled" point. The status line has
  four states, reusing the `--rg-success`/`--rg-warning`/`--rg-muted` tokens
  and the `.confidence-badge` pattern from the gate-status chip work:
  "Indexing... (building understanding)" (blocks question submission --
  the core evidence pipeline isn't ready), "Finishing up (annotating
  files)..." (indexing done, annotation still running in the background --
  does NOT block submission, since annotations don't feed the evidence
  pipeline, but stays visually distinct from Ready), "Not indexed yet", and
  "Ready" (both indexing and annotation complete -- distinct color AND text
  from every other state). The decision logic lives in
  `deriveReadinessStatus` in `webviews/sidebar/gateStatusRendering.js` for
  the same DOM-free testability reason as `deriveGateChipInfo`.
- MCP's `ask_repoguide` now returns the same `gateStatus` field
  (`{outcome, unsupportedCount, mode}`) chat's UI renders as a Verified/
  Verified with notes/Blocked chip -- previously MCP callers had no gate-
  outcome signal at all, the same invisibility gap chat had before this
  session's UX trust-visibility work. Token processing is extracted into a
  standalone, side-effect-free `src/mcp/askRepoguideTokenProcessor.ts`
  specifically so it's directly unit-testable (`mcpServer.ts` itself runs a
  heavyweight `main()` as an unconditional side effect of being imported --
  LanceStore, ExecutionPlanner, DatabaseSync, ... -- so it can't be imported
  into a test process).
- Chat UI now surfaces AnswerGate's verification outcome instead of it being
  invisible past a "Not covered" line -- the trust machinery (verification,
  gap disclosures, conceptual-mode annotations, decomposition) had one UI
  touch since Phase 5 before this. A `gateStatus` token (`{outcome,
  unsupportedCount, mode}`) is yielded from `emitFinalAnswer` and both
  single-shot/decomposed blocked branches; the sidebar renders it as a chip
  beside the confidence badge: Verified / Verified with notes / Blocked, or
  an explicit muted "Unverified" when the token never arrives at all (the
  legacy `explainSelection` path) -- that absence is itself an honest signal,
  not hidden. Decomposed answers that used the sectioned fallback or
  disclosed unreachable facets are surfaced as "Verified with notes", never
  "Blocked", since real content was delivered either way. AnswerGate's own
  gap/low-coverage prepend sentences now render as a notice bar above the
  bubble instead of indistinguishable plain prose, and the conceptual-mode
  fence-verification annotation (`⚠️ RepoGuide could not verify...`) renders
  as an inline callout instead of a raw blockquote line. A blocked-refusal
  answer now gets the existing `.message.error` styling instead of default
  bubble styling. The rendering-decision logic (chip text/class, prepend
  stripping, annotation-marker splitting) lives in a new dependency-free
  `webviews/sidebar/gateStatusRendering.js`, specifically so it's directly
  unit-testable under `node:test` without a DOM -- cross-referenced, with an
  enforced drift-guard test, against the literal strings in `answerGate.ts`
  it mirrors.
- Query decomposition for genuinely multi-facet questions (architecture
  walkthroughs, multi-step flows): the planner's decomposition now reaches
  generation instead of being flattened into one retrieval pool. When a
  question qualifies, each ordered sub-question runs the full single-question
  pipeline -- its own retrieval, evidence packet, synthesis, and MANDATORY
  AnswerGate pass -- and the gate-approved parts are merged by one final
  generation call that is itself verified against the union of the
  sub-packets (demonstrated against a real induced failure: a merge that
  invented a config value from a nonexistent file was blocked and replaced by
  the verified-sections fallback). Blocked sub-answers become explicit "Not
  covered" disclosures, never silent holes. Triggering is deliberately rare
  and requires three independent signals to agree (deterministic complexity
  score >= 5, an allowlisted walkthrough-shaped query type, and 2+ validated
  sub-questions from the planner): measured trigger rate on the 25 real
  dogfood questions is 1/25 -- only the known multi-facet walkthrough fires,
  every single-topic question stays single-shot. Small-model reality,
  measured: a 7B planner told "most questions must NOT decompose" never emits
  sub-questions directly even when it simultaneously produces a perfect
  5-task decomposition in `retrievalTasks` -- so sub-questions are derived
  deterministically from 4+ distinct retrieval-task descriptions, with
  LLM-emitted `subQuestions` preferred whenever a (larger) model does emit
  them. Derived sub-questions are anchored with the master plan's
  store-validated symbol/file hints, expanded one hop through the unit store
  (an anchor's real unit content can nominate other identifiers that
  themselves resolve to real units -- never anything unvalidated): measured
  live, a lone anchor acted as a magnet converging every facet on one file,
  while the expanded pool (execute_mission + run_mission +
  MissionOrchestratorAgent) recovered the per-agent timeout facet
  (asyncio.wait_for, audit.log_error) that had degraded to an honest
  non-answer, and restored the correct agent ordering. Progress surfaces per
  part in the sidebar ("Part 2/5: ...") through the existing typed side-band,
  with real cancellation points between parts. Costs ~2.5-3.5x single-shot
  latency when it fires; kill-switch: `repoguide.decomposition.enabled`.
  Blocked sub-tasks get ONE retry with the gate's concrete rejection reasons
  in the prompt -- the retry semantics were chosen from a measured mechanism
  probe (`subTaskFlakinessProbe.ts`), not assumption: sub-task retrieval is
  bit-stable (identical packet and prompt hashes 6/6 runs) and generation
  near-deterministic on an identical prompt, so a blind re-retrieve or
  re-sample reproduces the same block; only a feedback-changed prompt flips a
  persistent failure pattern. Measured on the deterministically-blocked
  agents-roster facet: 0/6 first-try passes, 6/6 recovered with the feedback
  retry, and the recovered answer is a real grounded agent roster, not a
  pass-by-refusal. Retry output faces the same full gate -- one extra chance,
  never a lower bar.
- `AnswerGate`'s path check now also accepts a path that appears verbatim
  inside evidence CONTENT, not just among evidence file names -- data-artifact
  filenames like `mission_report.json`/`draft.json` exist only as string
  literals in the code that writes them and can never be evidence files, yet
  an answer citing where a report is written is quoting exactly what it read.
  Measured: this false positive deterministically blocked a correct
  persistence answer 6/6 runs; with the fix it passes 6/6 first-try. Claims
  about such a file's contents are still verified by the quote/fence/numeric
  checks; only the mention itself is legitimized.
- Semantic/fact-extraction (`SemanticProvider`) support for seven languages --
  TypeScript, Python, Java, C#, Go, Rust, and C++ -- registered in shadow mode
  (computed on every indexed file, not yet authoritative for query answers).
  See `REPOGUIDE_AUDIT.md` §6 and each language's own `*_SEMANTIC_PROVIDER_REPORT.md`.
- Real IVF_PQ ANN index for LanceDB with paginated internal table scans.
- Lucene-style sealed segments for BM25, replacing full-blob rewrites on every update.
- Priority-ordered file walk with a configurable budget and surfaced truncation,
  so large workspaces get the most useful files indexed first instead of an
  arbitrary subset.
- A "Capabilities" launcher section in the Orientation panel, reaching every
  other real panel-opening command from one place (see `UX_CONSOLIDATION_REPORT.md`).
- `.github/workflows/ci.yml` -- compile, lint, and headless unit tests on push/PR.
- A shared `resolveWorkspaceFilePath` helper (`src/ui/workspacePathResolver.ts`)
  enforcing that citation/navigation file paths stay inside the workspace root.

### Changed
- Removed the standalone readiness pill above the chat input ("Indexing...
  X/401 files", "Finishing up...", "Ready") -- redundant with the Index
  Health panel's "Status" row and the native VS Code status bar, both of
  which already showed the same information. The safety behavior it existed
  to protect survives independently: the textarea and send button are still
  disabled while `isIndexing` is true (never `isAnnotating` -- the evidence
  pipeline is usable once core indexing finishes, per the earlier fix), now
  surfaced minimally via the input's placeholder ("Indexing in progress --
  see Index Health for status") and the disabled send button's tooltip,
  instead of a separate prominent element. `deriveReadinessStatus` in
  `webviews/sidebar/gateStatusRendering.js` is replaced by the much smaller
  `deriveInputGatingState`, which returns only `{disabled, placeholder,
  sendTitle}` and no longer carries any text/color presentation concern --
  that stays solely in `deriveIndexHealthStatusText`.
- `CONTRIBUTING.md` now discloses that `npm run test:unit` (the exact command
  CI runs) only exercises one trivial dummy test, not the ~80 real `node:test`
  files under `src/test/` -- previously implied otherwise by omission -- and
  gives the actual command to run real coverage plus its known pre-existing
  failure baseline. Added a "Definition of Done" section mirroring `CLAUDE.md`'s
  checklist and a pointer to `LIMITATIONS.md` for known gaps before filing an
  issue or starting a fix.
- `package.json`'s `publisher` and `repository.url` fields are now explicit,
  unmistakable `TODO-SET-REAL-*` placeholders instead of values that could be
  mistaken for real (`repoguides-publisher`, `https://github.com/test/test`) --
  neither can be filled honestly yet: no git remote is configured for this
  repo (`git remote -v` returns nothing) and no Marketplace publisher is
  registered. `categories` gained `Chat`/`AI` alongside the existing
  `Programming Languages`/`Machine Learning` (RepoGuide's primary surface is
  a chat-based, LLM-backed Q&A interface, which those two didn't capture), and
  a new `keywords` array was added for Marketplace discoverability. `license`
  was already correctly `MIT`, matching the real `LICENSE` file -- untouched.
  Verified with a real `vsce package` dry run: packages cleanly, no errors
  from the new categories or the TODO-string placeholder fields (only the
  pre-existing, unrelated "bundle your extension" size warning).
- Consolidated onto a single canonical query path (removed a competing legacy
  query pipeline split).
- `explainPanel.ts` and `docReportPanel.ts` migrated to the shared `wrapHtml()`
  design-system shell instead of bespoke/duplicated CSS.
- `docs/evaluation-harness.md`'s `provenanceAccuracy` metric is now a partial,
  disclosed heuristic (citation-presence + hedge-language detection) instead of
  an unconditional `null` requiring manual review for every question.
- Bounded worker-pool concurrency for full-index embedding, fixing a lazy-init race.
- The evidence-answer system prompt (`src/prompts/evidencePrompt.ts`) is redesigned from
  a flat, quote-forbidding "strict extraction bot" framing to one that asks the model to
  synthesize related evidence items into one coherent, cross-referenced explanation
  (every factual claim still requires a citation), and evidence chunks are now grouped by
  file in the prompt instead of listed in isolation. Verified with a full 7-language
  golden-question eval suite run before/after (axios, httpx, httpclient, cpr, reqwest,
  restsharp, resty) and a synthesis-style false-positive test batch beyond the original
  single example; landed together with three `AnswerGate` fixes (see next commit) that
  closed gaps the richer synthesis style newly exercised.
- `buildLLMEvidencePlan()`'s generated `symbolHints`/`fileHints` are now validated against
  the real `LogicalUnitStore` (the same `searchBySymbol`/`getUnitsByFile` lookups
  retrieval itself performs) before being merged into the plan, discarding anything with
  no match and logging a diagnostic. The planner's prompt has zero grounding in the real
  repository -- confirmed directly: it receives only the question text and a JSON schema,
  nothing about this codebase's actual files or symbols -- so it can and does invent
  plausible-sounding hints wholesale (found dogfooding: Java Spring Boot annotations and
  file paths like `@PostMapping`/`controllers/ImageUploadController.java` generated for a
  pure-Python repo). Nothing previously checked its output before feeding it into
  high-trust injection points downstream (e.g. `HybridRetrievalFusion`'s seed-file score
  boost). `ExecutionPlanner` takes an optional `LogicalUnitStore` to enable this; callers
  without one (smoke-test scripts against a mock context) degrade to the pre-validation
  behavior rather than being forced to construct a real store.

### Fixed
- **Chat's evidence packet carried the same unit-axis duplicate facts the
  `get_facts` fix (commit 424540c5) removed -- `EvidencePacketBuilder` has its
  own fact-retrieval path (its own `findBySymbol`/`findByType` calls, separate
  from `FactStoreProvider`), flagged as a follow-up when that fix landed and
  now confirmed live against CraftConnect's real facts.db.** `buildPacket`'s
  `addItem` keys `factsMap` on `item.id` (= `factId`, which embeds `unitId`),
  so the same source line extracted once per enclosing logical unit (class +
  method) survived as separate packet entries -- measured at 122-144 true-
  duplicate groups in a 502-fact packet for `confidence_threshold`/
  `total_questions`. Fixed with a `dedupeFactItems` helper keyed on
  `(file, startLine, endLine, symbol ?? '', type, content)`, keep-first --
  the same key and semantics as the `FactStoreProvider` fix, expressed on the
  `EvidenceItem` (`content` stands in for that fix's `value`; byte-identical
  dup rows share it, and value-distinct facts on one line keep distinct content
  and are correctly NOT merged). Applied at both packet-assembly sites
  (`buildPacket` and `buildExplainSelectionPacket`). Live-verified before/after
  through the real `buildPacket` path: `confidence_threshold` 502->379 facts
  with true-duplicates 122->0 (the line now appears once per type, not four
  rows); `total_questions` 144->0; value-distinct call_sites and same-symbol-
  different-file facts both preserved. The per-unit storage and
  `factExtractor.ts`'s own extraction stay untouched (unit-scoped queries need
  per-unit rows); this is a retrieval-layer collapse, no reindex.
- **`get_facts` returned the same underlying fact 2-4 times, discovered during
  live verification: `get_facts("confidence_threshold")` against CraftConnect
  showed `self.confidence_threshold = 0.55` (customization_interview_agent.py:65)
  as two `numeric_threshold` entries AND two `assignment` entries -- a 4-slot
  result that was really 2 distinct facts, each duplicated.** Root-caused
  against the real `facts.db` (not assumption): it's a storage-layer
  duplicate. `extractFacts` runs once per logical unit, and units nest (class
  ⊃ method ⊃ line), so a line like `self.confidence_threshold = 0.55` -- which
  physically sits inside both the enclosing class unit and the `__init__`
  method unit -- is extracted for each, producing rows that differ only in
  `unitId`/`factId`/`subject_uuid` and are identical in every field a fact
  consumer sees. Measured systemic, not incidental: 4,029 such duplicate
  groups, 10.7% of all 39,328 facts, every one pure unit-axis (distinct
  `unitId` per row, zero consumer-visible field differences within a group).
  `FactStoreProvider`'s `dedupeFacts` keyed on `factId` (a hash that embeds
  `unitId`), so it treated these as distinct and let them all through. Fixed
  by keying dedup on `(filePath, startLine, endLine, symbol, factType, value)`
  instead, keep-first (preserving the higher-ranked representative from
  `rankFactsByRelevance`). Per-unit storage is deliberately left as-is (unit-
  scoped queries need a fact findable from both its method and its class);
  this is a retrieval-layer collapse, no reindex required. `value` is
  required in the key, confirmed against real data: 2,339 real groups share
  file/line/symbol/factType but carry different values (e.g. two distinct
  call_sites `str(uuid4())` and `uuid4()` on mission_coordinator.py:51) --
  dropping `value` would wrongly merge genuinely-distinct facts. Live-verified
  before/after against the real store across four queries: `confidence_threshold`
  now shows the real fact exactly once per type (no dupes; the whole result
  went from 50 to 40 distinct facts as the freed slots backfilled with real
  matches); `total_questions` 4→2; `MissionCoordinator`'s two distinct
  same-line call_sites both preserved; `AGENT_VERSION` unchanged at 50 (no
  over-collapse where there's no duplication) -- and zero true duplicates
  remain in any result at the full-key granularity. Not MCP-only, by design:
  `FactStoreProvider.retrieve()` feeds both `get_facts` and chat's evidence
  packet, and collapsing byte-identical facts is correct for both (unlike this
  week's MCP-only content trim). The identically-named `dedupeFacts` in
  `factExtractor.ts` (storage/extraction) is separate and untouched.
  `EvidencePacketBuilder`'s own separate fact-retrieval path likely carries
  the same duplication into chat independently and is flagged for a follow-up,
  not fixed here.
- **Individual `retrieve_raw_evidence`/`get_facts` items had no content length
  cap, so a single item could still overflow a response even after this
  week's item-count cap (50) and metadata trim landed.** Live-measured
  against CraftConnect's real `logical_units.db`: a `logical_unit_store` item
  can embed an entire class or object literal verbatim (up to 80,190 chars
  for one `constant_block`, i18n.ts's `englishTranslations`; 18,951 chars /
  488 lines for the `MissionCoordinator` class) with no bound at all, and
  real Lance chunks reach 42,645 chars, past the nominal 6000-char
  `MAX_CHUNK_CHARS` (the astChunker's large-non-class-node overflow branch
  doesn't enforce it). `trimEvidenceItemForMcp` (`evidenceItemTrimmer.ts`,
  the single per-item step already shared by both tools) now caps `content`
  at 1500 chars -- chosen from real measurement, not picked arbitrarily: it
  keeps ~30-40 real lines (enough to show a class/function's signature,
  docstring, and early body -- e.g. a whole `__init__` -- so a client can
  decide whether to `Read` the rest), cuts a worst-case 50-item response of
  the largest real units from 727KB to 94KB (87% smaller), and only affects
  ~9 of a realistic 50-item mix's items when most content is already small.
  The cut rounds down to the last complete line within the cap (a client
  never sees a line chopped mid-token) and appends a note naming exactly how
  much was dropped and where to `Read` the rest, e.g.:
  `... [RepoGuide truncated 669 of 702 lines (78720 of 80190 chars). Read
  craftconnect-frontend/src/i18n.ts:524-1192 for the rest.] ...` -- verified
  against the real file on disk that line 524 is genuinely the next,
  never-shown line. That check caught a real off-by-one during development
  (the resume pointer initially pointed at the last line already SHOWN, not
  the next unread one -- a client following it would have re-read content it
  already had instead of the real continuation point); both the fix and a
  dedicated regression test came from that live spot-check, not assumption.
  Deliberately simpler than chat's `truncateItemContent` (`evidencePrompt.ts`,
  untouched by this change): that function preserves control-flow structure
  (keeping term-matching lines plus their governing `if`/`else`/`try`
  ancestors) for LLM reasoning; MCP's `retrieve_raw_evidence` exists so a
  client inspects real code directly, so a contiguous head plus an explicit
  Read pointer -- reinforcing the workflow guidance already in the README --
  is the right shape here, not an attempt to reproduce chat's discontiguous,
  term-driven excerpt. Scoped to MCP serialization only: `ask_repoguide`
  doesn't carry a `content` field in its MCP output (citations are
  file/line/reason only) and was confirmed unaffected; the internal
  `EvidenceItem.content` field used by chat/answer synthesis is untouched by
  construction (only `evidenceItemTrimmer.ts` changed).
- **`get_facts` returned near-total noise for a real, live query, discovered
  by re-testing the evidence-bloat fix above against Claude Desktop after it
  shipped: `get_facts("confidence_threshold")` against CraftConnect returned
  byte-identical output before and after that fix, across a full MCP server
  restart** -- meaning the earlier fix's own live retest disproved its own
  root-cause claim ("50 real facts + 50 flow items") rather than confirming
  it. Re-investigated against the real, running `FactStoreProvider` and
  CraftConnect's real `facts.db`, not assumption: the 50 returned items were
  all `type: "constant"` (`SIDEBAR_COOKIE_NAME`, `TOAST_LIMIT`,
  `MOBILE_BREAKPOINT`, ...), only 1 of 50 even mentioning "confidence" or
  "threshold" -- and none of the 20 facts in the DB that genuinely are about
  `confidence_threshold` (including the real
  `self.confidence_threshold = 0.55` at
  `customization_interview_agent.py:65`) appeared anywhere in the result.
  Two independent, compounding causes, both fixed and both re-verified live
  against the same real query and the same real `facts.db` (not just unit
  tests, given the prior round's test-green/behavior-unchanged gap):
  1. `FactStoreProvider.retrieveFacts`'s "fact evidence" alias (used for
     `queryType: 'threshold'`, matching this exact query) expands to nearly
     every `FactType`, and each type's `findByType()` results were pushed
     into the results list unranked, ordered only by confidence/filePath --
     so whichever type iterates first (`"constant"`, first in `FACT_TYPES`'
     declared order) fills the entire `maxItems` budget with query-irrelevant
     facts before the real scored candidate pool is ever appended, and the
     final dedupe+slice keeps only that first, irrelevant batch. Fixed by
     running the bulk-fill candidates through the exact same
     `scoreFact`/`compareFacts` ranking the candidate-pool path already used
     (extracted into a shared `rankFactsByRelevance`, no new scoring
     invented) before merging them in. Verified with a real induced-failure
     test isolated specifically from fix #2 below (using a space-separated
     query so the symbol-lookup path can't mask a regression in this one) --
     confirmed failing pre-fix, passing after -- and live: re-running the
     real `FactStoreProvider.retrieve()` against CraftConnect's actual
     `facts.db` now returns the real `self.confidence_threshold` fact.
  2. `FactStore.queryFacts`'s symbol filter was exact-match only
     (`symbol = ?`), so querying `"confidence_threshold"` never matched the
     fact extractor's real stored value, `"self.confidence_threshold"` --
     a live, present, correct fact that was simply unreachable by name.
     Extended to also match a stored symbol whose dotted/qualified path ends
     with the queried name (`symbol LIKE '%.confidence_threshold'`).
     Verified with an induced-failure test plus a negative control (an
     unrelated symbol that merely shares a partial substring must not
     false-positive-match), and live against the same real `facts.db`.
- **MCP evidence-item verbosity**: even at the correct 50-item cap, a
  `retrieve_raw_evidence`/`get_facts` response was still large because every
  item's `provenance` and `canonicalSource` (added by
  `withNormalizedEvidenceFields`) each re-duplicate `file`/`startLine`/
  `endLine`/`symbol` a second and third time, plus carry fields with no
  MCP-client use (`providerId`, `sourceId`, `freshness`, `subjectUuid`/
  `objectUuid`). A new `trimEvidenceItemsForMcp`
  (`src/mcp/evidenceItemTrimmer.ts`) keeps only `file`/`startLine`/`endLine`/
  `symbol`/`type`/`content`/`score`/`confidence`/`retrieval_signal` --
  applied ONLY in `mcpServer.ts`'s serialization of these two tools' JSON
  response; the internal `EvidenceItem`/`NormalizedEvidenceItem` shape used
  everywhere else (chat, `AnswerGate`, evidence packet building) is
  untouched, confirmed by the trimmed type simply having no field for
  `provenance`/`canonicalSource` to occupy (a TypeScript object-literal
  error, not just a runtime check, if either were ever added back).
  Measured live against CraftConnect's real 50-item response: 72.9% fewer
  lines, 71.2% fewer characters, with the exact same set of items (by
  `file:line`) preserved.
- **MCP citation/evidence-list bloat, live-tested and confirmed via Claude
  Desktop: `ask_repoguide`, `get_facts`, and `retrieve_raw_evidence` all
  returned responses large enough to overflow a client's token limit on
  ordinary questions** (`retrieve_raw_evidence` returned 137 items despite
  being documented capped at 50; `get_facts` returned 100 facts for one
  term). Root-caused to three compounding, independently-fixed issues rather
  than one:
  1. `FlowContextProvider.canHandle` was the only one of eight providers
     missing the `providerIds` membership check every other provider has
     (see `factStoreProvider.ts`'s pattern) -- so `get_facts`'s
     `forceProviderIds: ['fact_store']` never actually excluded flow-context
     items; they rode along and were returned labeled `facts`. Fixed with
     the same one-line check the other providers already use, verified as a
     real induced failure (reverting the check makes the regression test
     fail again).
  2. `RetrievalOrchestrator.execute()` only dedupes evidence by id across
     providers, with no aggregate cap -- each provider independently honored
     its own 50-item limit, so N providers could union into far more than 50
     results (the confirmed 137-item case). A new `interleaveAndCapEvidence`
     (`retrievalOrchestrator.ts`) round-robins each provider's
     already-internally-ranked item list (one item per provider per pass,
     duplicate ids skipped without stalling other providers' turns) and
     truncates to `RAW_EVIDENCE_AGGREGATE_CAP` (50) -- no new cross-provider
     scoring invented, since providers already rank their own results and
     there's no shared score scale to sort by without guessing. Applied only
     inside `QueryDispatcher.retrieveRawEvidence()`, confirmed via the actual
     call sites to be used exclusively by the MCP tools
     (`retrieve_raw_evidence`/`get_dependents`/`get_facts`/`get_dependencies`)
     -- deliberately NOT folded into `execute()` itself, which
     chat/investigationEngine/planAnalyzer/doc-report also call for
     answer-synthesis packet building and must not be affected.
  3. `ask_repoguide`'s citations included dozens of single-line "Fact match:
     `<generic word>`" hits in files unrelated to the question, because
     `emitFinalAnswer` (shared by chat and MCP) maps every fact in the
     evidence packet into `file_references` uncapped and unranked. A new
     `rankAndCapCitations` (`src/mcp/citationRanker.ts`) ranks citations the
     model actually referenced (a string-containment check against the final
     answer text -- inline `___CITE___` markers are always literally present
     since they were substituted into the text; a fact's `symbol` is checked
     the same way) ahead of generic fact-matches, then caps at 25 --
     deliberately wired only into `mcpServer.ts`'s post-processing of its own
     merged `citations` array, never touching `emitFinalAnswer` itself. A
     dedicated test drives the real, shared `QueryDispatcher.query()`
     generator with 30 facts and confirms chat's `file_references` output
     stays fully uncapped and unranked -- proving the MCP-only scoping claim
     behaviorally, not just by code inspection.
- Index Health's progress numbers visibly lagged the VS Code status bar's
  real-time count during a rebuild -- confirmed via screenshot, both showing
  simultaneously: status bar "Indexing (66/401 files)...", Index Health
  "Indexing (56/401 files)...". Cause: `StatusBarManager.setIndexingProgress()`
  is a direct in-process call updated on every file, while the webview only
  learned of new counts via the existing 3s poll. `IndexManager` now records
  each progress tick through a new `recordIndexingProgress()` that also
  notifies `onIndexingStateChanged` subscribers, throttled to at most once
  per second (`PROGRESS_NOTIFY_THROTTLE_MS`) so a large repo's per-file
  ticks don't each trigger a separate webview push -- `isIndexing`/
  `isAnnotating` transitions themselves remain unthrottled, and starting a
  new run resets the throttle window so its first tick is never held back by
  whatever a previous run last did.
- Chat sidebar's readiness indicator could show "Ready" for the entire
  duration of a real rebuild -- confirmed live: the VS Code status bar
  correctly showed "Indexing (65/401 files)..." while the chat panel sat on
  "Ready" the whole time. Root cause was a stale push, not a flag-timing bug:
  `postIndexHealth()` was only ever called when the webview first opened, or
  (for the sidebar's own Rebuild button) AFTER `forceFullReindex()` had
  already resolved -- never DURING a rebuild triggered from the command
  palette, an auto-rebuild prompt, or any trigger other than the sidebar
  button, so an already-open webview kept showing whatever state it was last
  pushed. `IndexManager.isIndexing`/`isAnnotating` now go through a private
  setter that notifies subscribers on every real transition
  (`onIndexingStateChanged`), and `SidebarProvider` subscribes once in its
  constructor to push a fresh `indexHealth` message the instant either flag
  flips -- covering all four rebuild trigger paths uniformly instead of
  wiring each call site individually. The chat panel's status line and the
  Index Health panel's "Status" field now also surface the exact same
  `{current, total}` file counts the status bar's "Indexing (N/total
  files)..." text reads from (`IndexManager.getIndexingProgress()`, updated
  at the same call sites `StatusBarManager.setIndexingProgress()` already
  used), so the two can never disagree. Index Health additionally
  distinguishes "Indexing complete" (a rebuild committed during this
  extension host session, via a new in-memory-only `lastIndexCompletedAt`)
  from plain "Ready" (an index that predates this session) -- five distinct
  Status states in total, none of which silently read as more settled than
  they are.
- Index Health's "Status" field read as contradicting the status bar/chat
  input during background annotation -- confirmed via screenshot: core
  indexing was genuinely complete and the status bar/chat input correctly
  showed "Ready" (annotation never blocks input, see above), but Index
  Health's own Status field showed a bare "Finishing up..." at the same
  instant, which a user reasonably reads as something still being wrong.
  `deriveIndexHealthStatusText`'s `isAnnotating` state (`webviews/sidebar/
  gateStatusRendering.js`) now leads with "Ready -- annotating in
  background", matching the original readiness-indicator design intent that
  this state should read as ready-with-background-work, not as blocking.
  Progress numbers (`(X/Y files)`) were considered but not wired in:
  `FileAnnotationEngine.annotateFiles()` doesn't report per-file progress
  out today (only an internal log line), and `IndexManager` clears
  `indexingProgress` to `null` in the same tick `isAnnotating` flips true --
  before the background annotation `setTimeout` work even starts -- so
  there's no real number available to show without adding new tracking,
  which was out of scope for a wording fix. Ships without the numeric
  suffix rather than fabricating one.
- Orientation panel reliability, all three confirmed on a real, fully-indexed
  CraftConnect run: (1) "Key Modules" is removed entirely -- the underlying
  community-clustering data was confirmed unreliable (`color_helper.py`, a
  fully dead file with zero references anywhere in `app/`, was named as a
  live architectural module, "Color Palette Manager"); the clustering/naming
  code itself is untouched, this panel simply stops surfacing its output.
  (2) The project-synthesis empty state now says "Project synthesis: not yet
  available." instead of "No project synthesis found yet." -- `project_synthesis`
  is a declared pipeline stage with no implementation anywhere in `src/`, not
  a feature that failed to run; the old wording implied an eventual,
  automatic appearance that will never happen. (3) The Entry Points fallback
  (used when `entry_points.json`/`project.json` are absent) now filters
  annotation candidates through the real `fileRoleClassifier`, requiring role
  `'implementation'` -- the annotation's own `role` field is LLM output and
  can be wrong (confirmed live: a barrel re-export file, `index.ts`, was
  annotated `role: 'entry_point'`), and the same classifier already excludes
  test/script/legacy-directory files everywhere else structural role matters.
  Labels now show parent-directory context ("tutorial/screens/index.ts", not
  just "index.ts") so a future misclassification is visible instead of
  hidden. Every candidate is existence-checked before rendering as a link --
  a real annotation's `file` field was found matching
  `workspacePathResolver.ts`'s own corrupted-path example shape and does not
  exist on disk; `resolveWorkspaceFilePath` alone doesn't catch this on
  Windows (its existence fallback is non-Windows-only), so this checks
  explicitly regardless of platform. 7 new tests, all confirmed as genuine
  induced failures (stashed the fix, watched all 7 fail against real
  temp-workspace fixtures with real annotation files on disk; restored).
- MCP's `ask_repoguide` filtered `healthCaveat`/`answerMetadata`/
  `answerProvenance`/`shadowContext` side-band tokens out of the returned
  answer text, but not `progressUpdate` -- which the decomposed query path
  (enabled by default) yields 3+ times per query. Any MCP question that
  qualified for decomposition returned raw progress-JSON fragments spliced
  into the answer text. Verified as a genuine induced failure (temporarily
  removed the filter, confirmed the exact corruption shape reproduces;
  restored).
- `hotspot_history`/`decision_outcomes`/`validity_history` column bugs in
  incident builders.
- `adrs.created_at` plus missing `DriftStore`/`KnowledgeHotspotStore` wiring
  it had been masking.
- `LogicalUnitStore`/`FactStore` were lowercasing a file's persisted `filePath`
  at write time (originally a lookup-key normalization, mistakenly applied to
  the stored value too), silently diverging it from the same row's `id` for
  any path containing uppercase letters. Found via real-world testing against
  a repo with mixed-case directory names. Both stores now preserve real
  casing in the stored value and use a shared `normalizeFilePathForLookup()`
  helper (`src/store/pathNormalization.ts`) only for matching keys.
  **Existing on-disk indexes built before this fix still have the wrong
  casing baked into already-written rows** -- there is no schema-version
  mechanism that detects this and triggers an automatic reindex (confirmed:
  none exists for these two SQLite stores today). Run "RepoGuide: Re-sync
  Index" once after upgrading to pick up the fix; the defensive fallback
  below covers citations in the meantime.
- `EvidencePacketBuilder` now normalizes every evidence item's `.file` to one
  canonical, workspace-relative, forward-slashed form at read time -- some
  providers (symbol-index-derived items) reported absolute paths while others
  (fact/annotation-derived) reported relative ones, so the same real file
  could be cited twice under two different string forms in one answer.
- The retrieval-quality log line previously labeled "Coverage" (e.g. the
  alarming-looking "Coverage: 0.00" seen during real-world testing on broad
  "explain X" questions) is renamed to "Fact-type match ratio" and now says
  plainly that it's diagnostic-only. It measures whether the query planner's
  requested fact *types* were found -- normally and correctly 0.00 for
  questions that don't target a specific fact type -- and was never the number
  that drives the confidence badge (that's `packet.coverageScore`, a
  different, `requiredEvidence`-based metric). Both are now commented at their
  definition site to prevent re-conflating them.
- `AnswerGate`'s numeric-claim check now tolerates a specific in-function line-number
  reference (e.g. "at line 900", or one end of a hyphenated range like "900-927") when it
  falls within an already-cited evidence item's real line span, even though the number
  itself isn't a literal substring of the evidence blob (only the item's own start-end
  boundary text is). Previously any such claim triggered a whole-answer block under
  `exact`/`grounded` confidence modes -- found via the before/after eval regression check
  for the evidence-prompt redesign (previous commit), which encourages more granular,
  specific claims.
- `AnswerGate`'s fallback-chain ordering check compared each chain fact's symbol position
  via `answer.indexOf(f.symbol)` from the start of the answer every time, so a symbol that
  legitimately recurs across multiple chain facts (e.g. the same class name at several
  steps of a chain) was compared against its own static first occurrence repeatedly and
  flagged as "out of order" against itself -- confirmed in a real transcript where one
  symbol was flagged 4 times in a single answer. Now tracks a monotonically-advancing
  search cursor instead, so a repeated symbol is only compared against where the previous
  chain fact was actually found.
- The fallback-chain cursor fix above still checked every `fallback_chain` fact in a
  packet as one global chain, so two facts that merely share a generic symbol name (e.g.
  "key") but come from genuinely unrelated files/units still triggered a false "out of
  order" flag -- found dogfooding against a real project, where a frontend UI component's
  unrelated "key" facts got pulled in as noise evidence for a backend auth question and
  blocked an otherwise-correct answer. The check now groups facts by the unit (falling
  back to file) they were extracted from before checking order, and collapses duplicate
  facts for the identical (unit, symbol) pair to their first occurrence -- confirmed via
  real data that a single unit can carry several byte-identical fallback_chain records,
  which previously demanded that many separate forward mentions of the same word.
- `MentorInsightRenderer`'s four insight blocks (Architecture Insights, Change Impact
  Analysis, Recommended Learning Path, Refactoring Opportunities) rendered unconditionally
  whenever a narrative summary string was present, even when every underlying structured
  list (affected files, major components, etc.) was empty -- since the summary is a fixed
  template, it's never itself empty, just sometimes degenerate (e.g. "prioritizing 0 files
  as structural entry points"). Found dogfooding: this appended a nonsensical trailing
  sentence to an otherwise-good answer. All four render methods now share one
  `hasSubstantiveContent()` gate and return an empty string when nothing structured backs
  the block, rather than each carrying its own ad hoc trigger condition.
- `AnswerGate`'s quoted-string check compared raw substrings, so a real docstring
  quoted at 7-space indentation vs the file's 8 blocked a whole correct answer
  (found dogfooding, fc-09) -- and, the deeper mechanism behind the same block,
  the naive `"..."` regex paired across Python `"""` docstrings inside fenced
  code blocks, manufacturing giant pseudo-"quotes" mixing code and prose that
  could never match evidence. The prose-quote scan now runs on the answer with
  fenced regions removed (fence content is verified by its own dedicated check),
  and all quote/fence comparisons use a shared whitespace normalization
  (per-line trim + intra-line whitespace-run collapse) on both sides, so
  re-indented or respaced real code still verifies while fabricated content
  still blocks -- covered by fc-09-reproduction tests plus fabrication controls.
- The explain-selection prompt builder now runs the same shared token budgeter
  as the main answer path (`deriveEvidenceBudgetChars`/`truncateItemContent`
  exported from `evidencePrompt.ts`, not a second implementation): it
  previously relied on the synthesizer's `compactPacketForLLM()` slices, which
  bounded item count but not size, so a large selection plus a few big context
  items could exceed `num_ctx` and silently truncate its own rules/security
  framing. Section structure and priority order are unchanged; the user's
  selection is always included (capped generously); overflow context entries
  are dropped from the back and disclosed with the same omission NOTE, with an
  `explain-selection`-labeled `[PromptBudget]` telemetry line. With both paths
  budgeted, `compactPacketForLLM()` had no callers left and is deleted.
- Asking about a file that is real on disk but deliberately excluded from indexing
  (e.g. `mission_orchestrator.backup.py`, matching `fileWalker.ts`'s `*.backup.py`
  pattern) surfaced the raw internal gate diagnostic "Unsupported path: backup.py" --
  technically true, useless to a developer looking at that file in their editor.
  `AnswerGate` now recovers the full dotted filename from the answer text (its path
  regex stops at the last dot-segment, but exclusion globs only match the full name),
  checks it against the default indexing exclusion patterns, and explains that the
  file is deliberately not indexed and how to change that, instead of implying the
  path might be hallucinated. Genuinely-unsupported paths keep the original message.
- `LogicalUnitStore.searchByContent()`'s coarse SQL candidate filter used only the
  first tokenized word of the query text (`terms[0]`) to narrow rows before scoring,
  so a natural-language question's relevance depended entirely on which word
  happened to occur first in the sentence -- for "What happens when a user
  uploads..." that word was "happens," an almost meaningless filter, silently
  excluding units that matched every other, more relevant term. The filter now
  ORs across every tokenized term; `contentScore()`'s existing ranking (which
  already sums occurrences across all terms) is unchanged, so this widens recall
  without changing how matches are ranked once found.

### Security
- The answer prompt (`buildEvidenceMessages()`) is now token-budgeted and
  question-aware. Previously it had no size discipline (top-50 facts + top-30
  items by raw retrieval score, where a single item could be a 500-line class
  body): 7 of 12 real dogfood answer prompts reached 72-100k chars (~20-27k
  tokens) against `num_ctx=16384`, and Ollama silently keeps only the TAIL of
  an over-length prompt -- so the CRITICAL RULES block (anti-hallucination,
  citation mandate, and the untrusted-repository-content security framing) was
  the first thing destroyed on a majority of real queries, confirmed
  empirically with a head/middle/tail needle test (`contextTruncationProbe.ts`:
  only the tail marker survived). Separately, the score-only final cut dropped
  the single decisive evidence item (e.g. a 0.65-score method literally
  containing the question's terms) in favor of generic score-1.0 symbol
  matches even with 75% of the window empty. The packer now (a) derives a hard
  char budget from `num_ctx` minus an output reserve, using a deliberately
  conservative chars-per-token ratio so Ollama-side truncation is unreachable,
  (b) ranks items and facts by retrieval score blended with lexical relevance
  to the actual question (snake_case terms also match their squashed CamelCase
  spelling), (c) truncates oversized single items to head + question-matching
  lines instead of dropping or fully including them, (d) appends an explicit
  omission NOTE so the model discloses rather than guesses across cut
  evidence, and (e) logs a `[PromptBudget]` telemetry line (est tokens vs
  `num_ctx`, packed/dropped/truncated counts) on every answer call, with a
  defense-in-depth over-budget warning in `streamChat()` for any other call
  path. The main answer path's old second selection layer
  (`compactPacketForLLM`'s signal-type slices) is bypassed so selection
  happens in exactly one place; the explain-selection path keeps it until it
  gets its own budgeter. Verified end-to-end: the two dogfood questions whose
  decisive evidence never reached the model (a literal `REDIS_URL` constant, a
  "Delegates to MissionCoordinator" docstring) now produce correct, cited
  answers, and the over-budget fabrication case now passes the gate with a
  grounded answer.
- A single retrieval channel (vector, BM25, or PageRank) that errors is no
  longer silently absorbed into an unqualified "success" just because a
  sibling channel still returned evidence -- found via real-world testing
  where a Lance vector-search failure on every query in a session never
  surfaced to the user, despite a healthy-looking confidence badge on every
  answer. `HybridRetrievalProvider`/`RetrievalOrchestrator` now track
  per-channel failures and, when the failed channel was weighted meaningfully
  by the query's routed retrieval strategy, surface a real gap on the answer
  ("evidence does not determine...") instead of hiding the failure.
- A specific, recognized failure shape (a Lance manifest referencing a data
  fragment missing from disk -- `LanceError(IO): ...Not found: ....lance`) is
  now detected directly and treated as index corruption: it surfaces an
  actionable warning ("run 'RepoGuide: Re-sync Index'") instead of silently
  returning empty vector-search results for the rest of the session. The
  underlying trigger for this corruption was investigated at length but never
  conclusively reproduced (OneDrive sync and RepoGuide's own file-watcher were
  ruled out directly; a targeted concurrent read-during-write race test at
  real corpus scale did not reproduce it either) -- this detects and mitigates
  the symptom rather than a confirmed root cause.
- `AnswerGate` now verifies quoted code against the real, freshly-read file
  it's attributed to (not just "does this text appear somewhere in the
  retrieved evidence"), catching a real quote from one cited file being
  misattributed to another. A second, independent check catches false
  "these files are identical" claims by diffing the real files. See
  `HALLUCINATION_INVESTIGATION_REPORT.md`/`HALLUCINATION_FIX_REPORT.md`.
- The quote-verification above only recognized double-quoted `"..."` strings; a fenced
  ` ```code``` ` block making the same "this is real code" claim was never checked at all.
  Found while regression-testing the evidence-prompt redesign (two commits back), which
  explicitly invites short illustrative code fragments: a fabricated method with
  fabricated calls, presented as "a simplified example," passed `AnswerGate` silently.
  The same fresh-from-disk, per-citation content check now also covers fenced code blocks.
- `resolveWorkspaceFilePath()` now falls back to a case-insensitive directory
  walk on non-Windows platforms when the direct path doesn't exist --
  defense-in-depth for citations built with the wrong casing (from the
  store-layer bug above, or any future bug of the same shape), so citation
  click-through and existence checks degrade gracefully on case-sensitive
  filesystems (Linux CI, Docker, most cloud deploy targets) instead of
  silently failing.
- `.vscodeignore` now excludes vendored eval/test corpora, this tool's own
  local self-index, and dev-only virtualenvs -- a real, severe packaging bug:
  confirmed via `vsce ls` that 87,630 files (multiple gigabytes, including
  full third-party repositories) would have shipped in the `.vsix` before this
  fix, versus 9,411 after.
- Fixed an unvalidated-path-open pattern repeated across 5 files (a citation
  or note file path could, once clicked, open an arbitrary file outside the
  workspace if it originated from hallucinated or repository-embedded content).
- Added explicit untrusted-content framing to every prompt that includes
  retrieved repository content, instructing the model to never follow
  instructions embedded in code comments, strings, or docstrings.
- `fileWalker.ts` now explicitly skips symlinks during indexing (made
  self-documenting rather than an implicit fallthrough of Node's `Dirent` API).
- `IndexManager.forceFullReindex()` called `clearAll()` on Lance/BM25 (the
  chunk-level "hybrid retrieval" stores) *before* `fullIndex()`'s re-embedding
  step, with no atomicity or rollback -- found via real-world investigation of a
  live index whose chunk stores were completely empty (0 documents) while
  `logical_units.db`/`facts.db` were fully populated, the exact signature of a
  reindex that cleared the old chunks and then either got interrupted before
  re-embedding finished, or completed "successfully" while every embedding call
  silently failed (`fullIndex()` only warns and skips a chunk on embed failure,
  never throws). Either way, a real user's index could be permanently emptied by
  any interrupted reindex -- a crash, force-quit, or sleep during a rebuild, not
  just a script bug. `LanceStore`/`Bm25Store` now build into a fresh, inactive
  "generation" (a second table / segment directory) via `beginRebuild()`,
  swapping it in atomically via `commitRebuild()` only after `fullIndex()`
  succeeds -- and `commitRebuild()` itself refuses the swap (keeping the
  previous generation live) if the previous generation had real chunks and the
  new one has none, catching the silent-100%-embed-failure case too. If the
  process dies at any point before `commitRebuild()`, the previously-active
  generation was never touched. Covered by a new interruption test
  (`src/test/indexing/reindexAtomicity.test.ts`) that stages a rebuild, never
  commits or aborts it (simulating a hard kill), and confirms a freshly-opened
  store instance still sees the original data. The other stores `clearAll()`'d
  by `forceFullReindex()` (logical units/facts, PageRank, annotations, symbol
  index) are not yet covered by this generation-swap and remain a smaller,
  disclosed residual risk.
- Added `RepositoryLivenessGate` (`src/preparation/repositoryLivenessGate.ts`),
  checked at query time (TTL-cached) rather than only at extension activation --
  found that `hasValidEvidenceIndex()`'s existing empty-store detection is
  correct but only ever runs at a handful of discrete lifecycle moments
  (activation, manual resync, workspace-folder-changed), so a workspace whose
  chunk stores go empty mid-session (e.g. from an external process, or the bug
  above) went undetected until the next activation. The gate distinguishes a
  genuinely fresh, never-indexed repo from the corruption signature above
  (structural data present, chunks empty) and surfaces an actionable warning
  with a "Re-sync Index" button rather than silently answering with degraded
  evidence.
- The reindex-atomicity generation swap above (`beginRebuild()`/`commitRebuild()`) silently broke
  `repositoryReadiness.ts`'s `inspectLance`/`inspectBm25` and, transitively, `RepositoryLivenessGate`:
  both pre-checked a single hardcoded generation-0 path (`chunks.lance`, `bm25_index_segments`)
  with `fs.existsSync()` *before* ever calling the store's own generation-aware record count, so any
  workspace whose active generation was 1 (i.e. had rebuilt at least once) reported `FAILED`/0
  records and `LivenessGate status: corrupted` even with a fully healthy, real, queryable index --
  found live against CraftConnect (an independent `Bm25Store` instance against the same directory
  returned a real 2282-document count and working search results while the readiness report claimed
  0). `inspectStore()` now takes an optional generation-aware existence check; `inspectLance`/
  `inspectBm25` check both generation-0 and generation-1 paths. Covered by a regression test that
  flips a temp store onto generation 1 via the real `beginRebuild()`/`commitRebuild()` path and
  confirms `buildRepositoryReadinessReport()`/`RepositoryLivenessGate` report real counts.
- Infra/deployment files (`Dockerfile`, `*.yaml`/`*.yml`, `.env`/`.env.*`, `Makefile`) were
  structurally unindexable -- confirmed against CraftConnect's real `Dockerfile` and
  `deployment/cloud_run_config.yaml`, which had zero manifest entries no matter how good retrieval
  got, since neither `ALLOWED_EXTENSIONS` nor `detectLanguage()` recognized them. `ALLOWED_EXTENSIONS`
  gained `.yaml`/`.yml`; new basename/prefix matching covers the extension-less conventions;
  `detectLanguage()` checks basenames ahead of the extension switch (no tree-sitter grammar for any
  of these, so they fall back to plain-text chunking, same as Ruby/PHP/Swift). Verified via a real
  CraftConnect reindex (manifest 397 -> 401 entries) and direct BM25 probes confirming both files are
  now indexed and lexically retrievable. A follow-on retrieval-ranking fix (below) was needed before
  this was end-to-end verifiable against a real natural-language question.
- `HybridRetrievalFusion` searched BM25 with the raw, full question text rather than extracted
  keywords, structurally penalizing short, topically-precise files (config, infra) against long
  prose docs that incidentally contain more of a natural question's filler words ("does," "have,"
  "way") -- `Bm25Store`'s tokenizer has no stopword handling and MiniSearch's `combineWith: 'OR'`
  sums a score contribution per matched token including those filler words. `searchBm25()` keeps its
  existing raw-question pass completely unchanged (every question's previously-obtained top-ranked
  hits keep the exact same identity and order) and adds a second, keyword-only pass reusing
  `extractKeywords()` (already computed for symbol-index injection, previously unused for BM25),
  appending only chunks the primary pass missed. Verified against the real case: the honest-negative
  deployment question now returns a correct, cited answer naming `deployment/cloud_run_config.yaml`
  (previously "evidence does not determine"), gate pass, zero diagnostics. Measured, not assumed,
  against a regression risk: re-ran the full 8-question capability-audit battery before/after; 6/8
  outcomes unchanged, 1 improved (the case above), 1 (`audit-05`, a decomposed multi-part
  walkthrough) moved from a passing unified narrative to the same-content verified-sections fallback
  after investigation traced this to a pre-existing, separate gap in `AnswerGate`'s numeric-
  contradiction check being surfaced by (correctly) retrieving more real evidence -- not a new defect
  in this fix, and the delivered answer stayed safe either way (an honest disclosure, not a wrong
  claim). See `ROADMAP.md` for the disclosed follow-up on that separate gap.
- `AnswerGate`'s numeric-contradiction check under-protected compound symbols whose word tokens
  include one shorter than 4 characters -- `symbolProximityTokens()` filtered word tokens to
  `length >= 4` before requiring ALL of them present nearby a numeric claim, so a symbol like
  `min_words` dropped `min` (3 chars) and left only `words` -- a maximally generic English word --
  as the sole requirement, letting an unrelated markdown numbered-list item that merely mentioned
  "words" falsely collide with a real `min_words = 95` fact from an unrelated mock backend. Fixed by
  lowering the per-word floor to 3 chars (preserving distinctive short prefixes like `min`/`max`)
  plus a small stoplist of generic short English words, so lowering the floor can't let two filler
  words substitute for one. Verified with a real induced-failure test using the real fact.
- React state values (hook initializers, or fields of an object literal passed to a React setter)
  were emitted as `numeric_threshold` facts the same as real configurable thresholds, letting a UI
  placeholder (e.g. `confidence_score: 0` inside `setMissionReport({...})` in a real
  `StudioContext.tsx`) collide with an unrelated claim whose phrasing happened to mention nearby
  words. `factExtractor.ts` now walks a numeric literal's AST ancestors (bounded to real
  containment) and excludes `numeric_threshold` specifically (other fact types are unaffected) when
  the value sits inside an argument of a React-hook-shaped (`use[A-Z]...`) or React-setter-shaped
  (`set[A-Z]...`) call, TS/JS only. Verified with real induced-failure tests reproducing both the
  exact `setMissionReport({..., confidence_score: 0, ...})` shape and a direct
  `useState({ confidence_score: 0.5 })` object initializer.
- Task-derived sub-question anchoring for query decomposition had no concept of "the same
  architectural layer as the rest of the question" -- on a full-stack question, the anchor pool
  locked onto frontend TypeScript symbols for a question actually about a backend Python flow, and
  every derived sub-question inherited that bias. `filterAnchorsForLayerCoherence()` now filters
  the validated anchor pool toward a dominant language using two store-validated signals in
  priority order (the master plan's own file hints across all tasks, falling back to the anchor
  pool's own majority language), never guessing on a genuine tie and never emptying the pool
  completely. Verified with a real induced-failure end-to-end test using a mixed real
  Python/TypeScript unit store.
- `AnswerGate`'s numeric-contradiction check read markdown ordered-list markers ("1. ", "2. ",
  "3. ") as bare numeric claims -- a severe over-blocking regression found via a fresh 15-question
  real-world eval against CraftConnect (4/14 correct, 8/14 hard abstentions), with gap messages
  almost all shaped like "Numeric claim 1 contradicts...", "Numeric claim 2 contradicts...". Root
  cause: `numberRegex` has no awareness of markdown syntax, so a numbered list's own digit ("1. "
  in "1. **submitAnswer**: ...") was checked as a bare numeric claim like any other, against
  whatever `numeric_threshold` fact happened to be textually proximate regardless of relevance.
  `isListMarkerContext()` (mirrors the existing `isLineNumberContext()` pattern) now excludes a
  digit occurrence from the numeric-claims check when it's immediately followed by the ordered-list
  punctuation (`.`/`)` + whitespace) AND is the first non-whitespace content on its line, so
  `"1. **X**"` is excluded but a genuine claim like `"reduce retries to 1. This fixes..."` is not.
  Excluded per-occurrence, not per number value, since the same digit can be a genuine claim
  elsewhere in the same answer. Verified with a real induced-failure test (a minimal 3-item
  numbered list plus one unrelated fact: confirmed blocking pre-fix, passing after) and two
  controls confirming genuine claims -- including a real wrong number inside a list item's own
  text, not just its marker -- are still caught exactly as before.
- `AnswerGate`'s quote/fence attribution checks blocked 3 real, fully correct answers as "likely
  fabricated" or "misattributed" -- found re-running the same CraftConnect eval after the
  list-marker fix, using a raw-answer capture probe since the gate discards the pre-gate text on
  block. All 3 had every line individually verbatim-real in the claimed file, but the block as a
  whole was non-contiguous: a quote resolved a real f-string placeholder (the per-file check lacked
  the template tolerance the evidence-wide check already had); a fence flattened a real multi-line
  f-string concatenation using literal `\n` as a separator and elided two intervening real lines; a
  fence had three verbatim, correctly-ordered real lines with one intervening structural line
  (`try:`) omitted. `matchesTemplateInContent` is now also applied in the quote- and
  fence-attribution branches (non-anchored for fences, since a fence's raw text is more than just
  the resolved literal). `fenceLinesMatchInOrder()` is a new fallback for the whole-block contiguous
  check, requiring every normalized fence line present in order with at least one non-generic line
  >= `CODE_QUOTE_MIN_LENGTH` -- the safety valve against a genuinely fabricated block passing via
  fragmentation. A 4th question in the same batch (a real string assigned to the wrong field) was
  confirmed as a genuine, correct catch and is unaffected. Verified with real induced-failure tests
  for all 3 fixed cases plus a control for the genuine catch, two isolation tests for the
  attribution-branch-specific code paths, and a disclosed-residual test confirming an
  all-generic-lines fence still correctly blocks.
- `npm install` on a fresh clone used to reliably fail: `postinstall` tried to rebuild
  `better-sqlite3` for VS Code's Electron ABI and hit a C++20/MSVC toolchain mismatch. Root cause:
  `better-sqlite3` was dead weight -- `npm ls better-sqlite3` reported it `extraneous`, and the
  codebase migrated to Node's built-in `node:sqlite` (94 files) long ago without removing the old
  dependency or its rebuild scripts (`scripts/install-electron-sqlite.js`,
  `scripts/rebuild-better-sqlite3.js`, the `postinstall`/`rebuild:native` npm scripts). Removed all
  of it and regenerated `package-lock.json`. Verified as a pure subtraction: compile, lint, the full
  real test suite (239 tests, same 229 pass/10 pre-existing-fail split as before), and
  `vsce package` all produce identical results before and after, and a genuine fresh clone now runs
  `npm install` to completion with zero errors.

### Removed
- The Orientation panel (`repoguide.orientationPanel`, `phase10Panels.ts`'s
  `showOrientationPanel`/`buildOrientationHtml`/`maybeShowOrientationOnOpen`)
  is gone, along with its auto-open-on-first-workspace-open hook and its
  `package.json` command contribution. After this week's fixes it was down
  to a duplicate of the Entry Points section: Key Modules was already
  removed as dead-code-cited-as-architecture, and Project Synthesis was
  never implemented by any real code path (`project.json` is never
  produced). Confirmed via a full trace of every annotation-data consumer
  before removing anything: the annotation pipeline itself is untouched and
  stays fully load-bearing for evidence-packet enrichment, retrieval
  seeding, the Investigation engine, Plan Tracker, and community summaries
  -- none of which route through Orientation. `isAnnotating`/
  `getIsAnnotating()`, the Index Health "Finishing up..." state, and the
  background annotation trigger in `indexManager.ts` are all untouched.
  The Investigation and Plan Tracker panels/commands, which shared
  `phase10Panels.ts` with Orientation, are unaffected. Also dropped, as
  direct consequences of removing Orientation's only callers: the
  `buildCapabilitiesSection` launcher, `readEntryPoints`/
  `readProjectSummary`/`fileExistsInWorkspace`/`entryPointDisplayPath`/
  `readJson`/`unwrap` helpers, and the now-unreachable `'runCommand'`
  webview-message branch in `phase10Panels.ts`'s `handleMessage`.

## [0.0.1]

- Initial scaffold.
