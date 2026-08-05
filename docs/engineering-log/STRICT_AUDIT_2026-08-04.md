# Strict production-readiness audit — 2026-08-04

Independent adversarial audit against `CLAUDE.md`'s five-point Definition of Done. Every item
below was verified by reading the code and, where marked **[reproduced]**, by executing the
compiled artifact in `out/`. Nothing here is inferred from a comment.

**Environment / baseline checks run for this audit**

| Check | Result |
|---|---|
| `npx tsc --project ./ --noEmit` | exit 0, no diagnostics |
| `npx eslint src` | exit 0, **0 errors**, 965 warnings (pre-existing, not a finding) |
| The 11 suites named in the 2026-08-04 ROADMAP entries | all pass — withheldAnswer 8/8, answerStreamTokens 13/13, canonicalAnswerTail 10/10, relationClaimVerifier 18/18, numericClaimSymbols 7/7, importResolver 10/10, emptyIndexGuard 5/5, logicalUnitExtractor 16/16, answerGate.contentVerification 73/73, answerGateFileUsage 12/12, modelProse 6/6 |

So: **the eight defects fixed today are genuinely fixed at the level they were fixed at.** I could
not reproduce any of them. What follows is what those fixes did not reach, plus what was already
broken underneath them.

---

## Verdict

**Not production grade.** The verification layer that is this product's entire value proposition
can be switched off by an answer containing the word "missing" — one word, five common phrases in
total, disabling every blocking check in `AnswerGate` including the technology-fabrication block
that today's own work relies on (P0-1, reproduced by execution). The index guard shipped today
protects the two stores the query pipeline does *not* read from and leaves the one it *does*
(`logicalUnitBm25Store`) cleared in place with the new `expectedNonEmpty` flag never passed by any
production caller — the same accepted-and-dropped shape caught during the work, one layer up
(P0-2). The "fully local" promise is enforced by a default value, not by code: `repoguide.ollamaUrl`
is workspace-overridable and unvalidated, so a `.vscode/settings.json` committed into a repo
redirects every embedding and every synthesis prompt — verbatim source code — to an arbitrary host
(P0-3). And the gate now reads whatever file path the model writes, `..` segments included: a
model-authored `../../../../etc/secrets/config.py` resolves and is read off disk (P1-1, reproduced).
Underneath all of it, CI runs `npm run compile`, `npm run lint`, and one test that asserts
`true` — 154 real test files, including every regression test written today, run in zero automated
pipelines, and at least one core suite (`evidencePacketBuilder.test.ts`, 0/5) has silently rotted
against production signatures that changed under it. The engineering discipline visible in the
ROADMAP is real and unusual; the shipping discipline around it is not there yet.

---

## P0 — must fix before any release

### P0-1. Five common English phrases disable every blocking check in `AnswerGate` — **FIXED 2026-08-05**

> **Status: closed.** Fix, evidence and before/after in ROADMAP.md, "Gate bypass: one English word
> disabled every blocking check (P0-1, 2026-08-05)". Both the A/B pair below now `block`, and all
> five phrases × four independently-reachable blocking checks are pinned by
> `src/test/query/gateBypassScope.test.ts` (35 tests; 24 of them fail against the pre-fix
> behaviour).
>
> **A second root cause was found while verifying the fix**, and the audit did not have it:
> `technologyClaimVerifier` tested its negation guard over a ±120-char window that crossed sentence
> boundaries, so a negation in a *neighbouring* sentence suppressed the fabrication flag. Fixing
> `AnswerGate` alone left three of the five phrases still bypassing the flagship technology check
> through that path. Same defect class — an unscoped suppression region — in a second module.
> Both now share one sentence-splitting primitive (`src/query/sentenceSpans.ts`).
>
> The "fix direction" suggested below was followed, with one deliberate departure: the technology
> check was given **no** abstention exemption rather than a narrowed one, because
> `detectFabricatedTechnologyClaims` already declines to flag mentions inside a negation window,
> which is precisely the abstaining shape.

*Original finding, preserved:*


**What.** `answerGate.ts:549-558` computes `hasGapPhrase` from a plain substring scan of the
lowercased answer:

```ts
const hasGapPhrase = lowerAnswer.includes('does not determine') ||
                     lowerAnswer.includes('cannot determine') ||
                     lowerAnswer.includes('missing') ||
                     lowerAnswer.includes('not explicitly stated') ||
                     lowerAnswer.includes('does not specify');
const skipStrictBlocking = hasGapPhrase;
```

`skipStrictBlocking` then guards **eight** `result.outcome = 'block'` sites —
`answerGate.ts:718, 729, 797, 824, 857, 884, 1080, 1104` — covering numeric contradiction,
fabricated quotes, fabricated code fences, fabricated file paths, citation verification, and the
technology-fabrication check. The new check 6d (`:1232`) is gated on `!hasGapPhrase` too, and
`withheldAnswer.ts` never runs because nothing blocks.

**Why it matters.** "missing" is not a hedging marker. It is one of the most common words in
genuine code explanation — "handles a missing key", "the missing dependency", "missing config
value". Any answer that happens to contain it passes the gate unconditionally, regardless of what
it fabricated. The failure is silent and invisible: `gateStatus` reports `pass`, the trust chip is
green, and the user is told the answer was verified.

**[reproduced]** Executed against the compiled gate, identical 4-item packet, `presentTechnologies
= {Django}`:

```
A  "The project uses Redis for caching."                                       -> block
B  "The project uses Redis for caching. Error handling for a missing key is
    elsewhere."                                                                -> pass
```

Same fabrication. One extra clause containing "missing". `block` → `pass`.

Second reproduction, isolating check 6d on a 2-source packet:
`"Some answer with no gap phrase at all here."` → `revise` + thin-evidence caveat;
`"The config value is missing from the loader."` → `pass`, no caveat.

**Root cause.** A conservatism intended for *one* narrow case — the model restating the question
inside an abstention ("I cannot determine if 0.85 is...", per the comment at `:556-557`) — was
implemented as an unanchored substring test over the whole answer and then wired as a global
kill-switch for every blocking check rather than scoped to the specific check it was reasoning
about. The other four phrases are at least sentence-shaped; `'missing'` is a bare word and is the
one that makes this trivially reachable.

**Fix direction.** Anchor detection to an abstention *sentence* (this repo already has
`detectAbstention` in `abstentionVerifier.ts` and uses it at `queryDispatcher.ts:307`), and scope
the suppression per-check rather than globally — a hedged answer should still not be allowed to
fabricate a technology or a code fence.

---

### P0-2. The first-run empty-index guard does not cover the store the query pipeline actually reads — **FIXED 2026-08-05**

> **Status: closed.** Fix, live before/after evidence and the two-gap breakdown are in
> ROADMAP.md, "Empty-index guard extended to the store the query pipeline actually reads
> (P0-2, 2026-08-05)".
>
> **This was two distinct gaps, not one bug in two places**, and they compounded:
>
> - **Full reindex (severe).** No generation swap at all -- `clearAll()` ran unconditionally
>   before `fullIndex()` had done anything, so a reindex producing nothing left the store
>   empty with no rollback. Closed by a real `beginRebuild()`/`commitRebuild()`/
>   `abortRebuild()` triple at the population site inside `fullIndex()`.
> - **Incremental refresh (milder).** The swap was already correct; only `expectedNonEmpty`
>   was missing, so it had the relative guard but never the absolute one. Closed by passing
>   `allLogicalUnits.length > 0`.
>
> They compounded because a full reindex that silently zeroed the store made
> `previousUnitCount` 0 on the next incremental run, leaving the relative guard structurally
> unable to fire.
>
> **The plumbing was never broken.** `SegmentedMiniSearchIndex.commitRebuild` and
> `LogicalUnitBm25Store`'s forwarding were both already correct; the defect was entirely at
> the call sites.
>
> **Partial existing backstop, credited:** `hasValidEvidenceIndex()` already treats a zero
> `logical_unit_bm25` count as not-READY and triggers a reindex, so this fix is not the first
> line of defence at startup. It does not help mid-session, and `repositoryLivenessGate`
> ignores this store entirely -- recorded as a separate, smaller finding.

**What.** Today's fix threaded `expectedNonEmpty` into four store classes. It is passed by a
production caller into exactly two of them:

- `indexManager.ts:384` — `this.store.commitRebuild(previousChunkCount, expectedNonEmpty)` (Lance)
- `indexManager.ts:385` — `this.bm25Store.commitRebuild(previousBm25Count, expectedNonEmpty)` (chunk-level BM25)

The evidence pipeline does not query either of those. `EvidencePacketBuilderStores.bm25Store` is
typed `LogicalUnitBm25Store` (`evidencePacketBuilder.ts:47`) and is wired to `luBm25Store`
(`extension.ts:739`). That store:

1. is **cleared in place** during a full reindex — `indexManager.ts:357`,
   `await this.logicalUnitBm25Store.clearAll()` — with no `beginRebuild`/`commitRebuild` generation
   swap at all, so the guard cannot fire on the reindex path; and
2. on the incremental-refresh path, which *does* stage a rebuild, is committed without the new
   flag — `extension.ts:628`, `await luBm25Store.commitRebuild(previousUnitCount)`.

Grep confirms it: `expectedNonEmpty` appears at `logicalUnitBm25Store.ts:126` in the signature and
at `:127` in the forward to the underlying index, and at **no call site anywhere in `src/`**. The
parameter is dead on that store.

**Why it matters.** `forceFullReindex()` reports success on the strength of Lance and chunk-BM25
chunk counts. Logical-unit extraction is a *separate* pipeline stage from chunking. If unit
extraction produces zero units while chunking succeeds — which is precisely the failure mode fixed
earlier today (`logicalUnitExtractor.ts` routing `script`-role files to zero units, ROADMAP
"Script-role files produced ZERO logical units") — the reindex is reported as successful, the guard
never fires, and every subsequent query retrieves from an empty logical-unit index. That is the
exact "false success" class defect #7 was opened to close, still open on the store that matters
most.

**Root cause.** The guard was scoped to "the chunk-level stores that were found to go empty"
(`indexManager.ts:352-354`), which is a scoping inherited from the earlier generation-swap work.
That scoping was correct for the failure that motivated it and is wrong for the failure the
absolute guard was added to catch, because the absolute signal (`files walked > 0, artifacts
produced == 0`) is meaningful for *every* derived store, not just chunk-level ones.

**Claim affected.** ROADMAP: *"Threaded through all four stores: `lanceStore`, `bm25Store`,
`logicalUnitBm25Store`, `segmentedMiniSearchIndex`."* True of the signatures; false of the wiring
for two of the four.

---

### P0-3. "Fully local" is enforced by a default value, not by code — **FIXED 2026-08-05**

> **Status: closed.** Fix, live before/after evidence and the corrected finding are in
> ROADMAP.md, "`repoguide.ollamaUrl` privacy invariant: enforced, not just warned about
> (P0-3, 2026-08-05)".
>
> **Correction to this entry as originally written.** The claim below that "there is no
> validation of the resulting URL anywhere" was **wrong at the time it was written**.
> `src/health/ollamaUrlSafety.ts` (`isLoopbackOllamaUrl`) and its startup warning in
> `startupCheck.ts` already existed, were already unit-tested, and already ran before any
> indexing or Ollama traffic. What was genuinely missing was **enforcement**: the validator
> gated one dismissible warning and nothing else, while every call site read the setting
> independently and used it unchecked. The `no scope` and `no capabilities block` claims
> were both accurate and are both now fixed.
>
> Two further corrections from re-deriving the facts on 2026-08-05: the call-site list below
> conflates *reads* with *uses* -- there were **7** places that read the setting, not the ~13
> implied; the rest (`intentClassifier`, `strategyRouter`, `comprehensionQAGenerator`,
> `synonymNormalizer`, `modelManager`) receive the URL as a parameter and are downstream of
> those reads. And `extension.ts:1262` is a *use* of the variable read once at `:190`.
>
> The gap was real and was reproduced live before being fixed: a workspace
> `.vscode/settings.json` pointing `ollamaUrl` at a listener on 127.0.0.1:47913 drew three
> recorded hits, **two of them from RepoGuide's own startup health check** -- i.e. traffic
> left for an attacker-chosen host before the warning could be read.

**What.** Every network call in `src/` goes to `${ollamaUrl}` — `ollama/embedder.ts:25`,
`ollama/inferencer.ts:111`, `ollama/ollamaClient.ts:21`, `query/intentClassifier.ts:134`,
`query/strategyRouter.ts:77`, `cache/comprehensionQAGenerator.ts:158,233`,
`comprehension/synonymNormalizer.ts:98`, `performance/modelManager.ts:45`,
`health/startupCheck.ts:37,47`, `extension.ts:1262`. `ollamaUrl` is read via
`vscode.workspace.getConfiguration('repoguide')` (`context/vscodeContext.ts:20-23`).

In `package.json`, `repoguide.ollamaUrl` carries **no `scope`**, so it defaults to `window` scope —
overridable by workspace (`.vscode/settings.json`) and folder settings. There is no validation of
the resulting URL anywhere, and `package.json` declares no `capabilities` block at all.

**Why it matters.** The product's headline promise is that code never leaves the machine. A repo
that ships `.vscode/settings.json` with `"repoguide.ollamaUrl": "http://collector.example.com"`
silently redirects (a) every embedding request, which contains raw source chunks, and (b) every
synthesis prompt, which contains the assembled evidence packet — verbatim source code — to that
host. Nothing in the UI shows the endpoint in use, nothing logs a warning, and the user's only
signal is that it still works.

The absence of a `capabilities.untrustedWorkspaces` declaration means VS Code disables the
extension in an *untrusted* workspace, which covers the drive-by case. It does not cover the
realistic one: a repo from a colleague or a public repo the user trusts to open in order to
*use RepoGuide on it* — which is the entire use case.

**Root cause.** The local-only property was treated as a documentation claim rather than an
invariant with an enforcement point.

**Fix direction (one line each).** Set `"scope": "machine"` on `repoguide.ollamaUrl` so workspace
settings cannot override it; reject non-loopback hosts unless the user has explicitly opted in
through a separate machine-scoped setting; surface the resolved endpoint in the status bar or
startup check. Declaring `capabilities.untrustedWorkspaces` explicitly would also make the current
implicit protection a decision rather than a default.

---

### P0-4. CI verifies nothing. 154 test files, including every regression test written today, run in no automated pipeline — KNOWN in shape, understated in severity

**What.** `.github/workflows/ci.yml` runs `npm run compile`, `npm run lint`, and `npm run test:unit`.
`test:unit` is `mocha out/test/extension.test.js`. That file, in full:

```ts
suite("Extension Tests", () => {
    test("dummy", () => { assert.ok(true); });
});
```

`find src -name "*.test.ts"` → **154 files**. `find out -name "*.test.js"` → 159 compiled. The jest
suite is excluded by a comment in the workflow. None of `withheldAnswer.test.ts`,
`emptyIndexGuard.test.ts`, `canonicalAnswerTail.test.ts`, `answerStreamTokens.test.ts`,
`relationClaimVerifier.test.ts`, `importResolver.test.ts`, `numericClaimSymbols.test.ts` —
every regression test written today — runs on any push or PR.

**Why it matters, concretely, not theoretically.** The rot has already happened.
`src/test/evidencePacketBuilder.test.ts` — the unit test for the core evidence-assembly component
— is **0 pass / 5 fail** when run:

```
error: 'this.stores.factStore.findByType is not a function'      (evidencePacketBuilder.js:263)
error: 'stores.factStore.findBySymbols is not a function'         (factExpansion.js:42)   x3
AssertionError: expected 'src/gadget.ts', got 'C:/workspace/src/gadget.ts'
```

The first four are stale-stub rot: production started calling `findByType` and `findBySymbols` on
`FactStore` and the test's hand-rolled mock was never updated, because nothing ever ran it to
notice. The `canonicalAnswerTail.test.ts` drift guard written today is a genuinely good idea —
it is the right technique — and it is worth exactly as much as the pipeline that runs it, which
is currently zero.

**Root cause.** The jest flakiness problem (documented, real) was allowed to block *all* automated
testing rather than being routed around. The ~120 `node:test` files that do not need jest could run
under `node --test` in CI today — I ran 55 of them in parallel in this sandbox in under 40s.

**Note on the sandbox.** Of the failures I swept, the large majority are environment limits, not
defects: `Cannot find module '@lancedb/vectordb-linux-x64-gnu'` (native binding absent) and
`Do not import '@jest/globals' outside of the Jest test environment` (jest-syntax files run under
`node --test`). I verified the cause of each before counting it. `evidencePacketBuilder.test.ts`
is not one of these — its failures are platform-independent `TypeError`s from missing mock methods.

---

## P1 — should fix

### P1-1. The gate reads any file path the model writes, `..` segments included — NEW

**What.** `answerGate.ts:1195`:

```ts
for (const violation of verifyRelationClaims(answer, p => readFileFresh(path.resolve(workspaceRoot ?? '', p)))) {
```

`p` comes from `relationClaimVerifier.ts`'s `FILE_IN_CLAIM` regex (`:78`),
`((?:[\w.-]+[/\\])+[\w.-]+\.(?:py|ts|...))`. `[\w.-]+` matches `..`, so a traversal path is a valid
match. `path.resolve` then walks out of the workspace, and `readFileFresh` (`:535-547`) does an
unbounded `fs.readFileSync` on the result.

**[reproduced]** Against the compiled module:

```
input : "The module in `../../../../../../etc/secrets/config.py` calls the `token` helper."
claim : { file: "../../../../../../etc/secrets/config.py", symbol: "token" }
resolve('/home/user/project', claim.file) -> /etc/secrets/config.py
```

**Why it matters.** File *contents* are not echoed back — the violation message carries only the
path (already in the answer) and the symbol — so this is not a direct exfiltration primitive. It
is still an arbitrary local-file read driven by untrusted model output, in a product whose stated
boundary is the workspace, with an unbounded `readFileSync` behind it (a large matched file is read
whole into memory per verify() call). `answerGate.ts:1065` has the same shape via `path.join`.

**Root cause.** `relationClaimVerifier.ts`'s doc comment reasons carefully about a *semantic*
safety property ("the file to read comes from the answer itself, so there is no resolution
ambiguity") and does not consider the *filesystem* safety property. The module is correctly written
to take `readFile` as an injected callback; the call site simply did not constrain it.

**Fix direction.** Reject any resolved path not under `workspaceRoot` (`path.relative(root, abs)`
must not start with `..` and must not be absolute), and cap the read size. One guard, at the
`readFileFresh` boundary, covers checks 6a2, 6b and 6c at once.

---

### P1-2. `presentTechnologies` is cached for the extension's lifetime and never invalidated, so a correct answer can be hard-blocked for the rest of the session — NEW

**What.** `queryDispatcher.ts:279-284`:

```ts
private async getPresentTechnologies(): Promise<Set<string>> {
    if (!this.presentTechnologies) {
        this.presentTechnologies = await resolvePresentTechnologies(this.textIndex);
    }
    return this.presentTechnologies;
}
```

`presentTechnologies` is assigned in exactly one place (`:281`) and cleared nowhere. The
`QueryDispatcher` is constructed once, during `activate()` (`extension.ts:736`), and is never
rebuilt — the reindex path re-inits stores but reuses the same dispatcher instance.

The consumer is unforgiving: `answerGate.ts` (technology-fabrication check) sets
`result.outcome = 'block'` — a hard withhold, not a caveat — for any of the 50 terms in
`KNOWN_TECHNOLOGY_TERMS` (`technologyClaimVerifier.ts:28-37`) not in the set.

**Why it matters.** Add Redis to a project, reindex without restarting VS Code, ask about it. The
cache still says Redis is absent, so a *correct* answer saying "the project uses Redis" is blocked
and the user is shown a refusal. This is the false-block class the project has explicitly reverted
checks for twice, reintroduced through a cache-invalidation gap rather than through the matcher.

**Root cause.** The value was correctly identified as "a property of the repo rather than of any
query" (`:236-238`) and therefore cached — but a property of the repo changes when the repo is
reindexed, and there is no invalidation hook.

---

### P1-3. Stop does not stop anything on the normal chat path — NEW

**What.** `SidebarProvider` creates an `AbortController`, passes its signal into
`pipeline.query(...)` (`sidebarProvider.ts:110-114`), and calls `.abort()` on the `cancel` message
(`:186-188`). The signal reaches `runEvidenceQuery` (`queryDispatcher.ts:413`) and is forwarded to
`runDecomposedQuery` (`:450`) — and to nothing else. The single-shot path calls
`generateForPlan(question, executionPlan, history, telemetry, onConfidence)` (`:454`) without it,
and `generateForPlan` synthesizes via `this.synthesizer.synthesize(packet, inferenceModel, history)`
(`:772`). `EvidenceAnswerSynthesizer.synthesize` has **no signal parameter at all**
(`evidenceAnswerSynthesizer.ts:16-23`) and hard-codes `undefined` into `streamSynthesize`:

```ts
const generator = this.streamSynthesize(packet, model, undefined, history);
```

`streamSynthesize` does accept a signal (`:36`) and does forward it to `streamChat`. It is simply
never given one on this path.

**Why it matters.** Single-shot is the default and dominant path (decomposition requires two
independent triggers to agree, `:652-659`). Pressing Stop aborts a controller nobody is listening
to; the Ollama generation runs to completion, the model stays resident, the answer is then
delivered as if nothing happened, and no `cancelled` message is ever posted. With
`determinism.resetModelBeforeSynthesis` on by default (which drops and reloads the resident model
per answer), a leaked in-flight generation is not free.

**Secondary, same file.** `this.activeAbortController` is a single slot
(`sidebarProvider.ts:26`). A second question submitted while one is in flight overwrites it, and
the first request's `finally` (`:183`) then nulls it — so the second request becomes permanently
uncancellable.

---

### P1-4. `explainSelection` accepts `abortSignal` and drops it — NEW (the exact bug class from today's work)

`queryDispatcher.ts:991-1037`. The signature declares `abortSignal?: AbortSignal` at `:997`; the
identifier appears nowhere in the body. `synthesizeExplainSelection` (`:1004`) takes no signal
parameter either (`evidenceAnswerSynthesizer.ts:66`). The public interface at `:118` advertises it.
`streamExplain` (`ui/explainPanel.ts`) additionally never registers `panel.onDidDispose`, so closing
the panel mid-stream does not stop the generation.

This is the *same shape* as the store bug caught during today's work — a parameter that compiles,
reads correctly, passes review by eye, and does nothing.

---

### P1-5. The documentation report skips the entire post-gate delivery contract — NEW

**What.** `queryDispatcher.ts:1087-1095`:

```ts
for await (const chunk of this.synthesizer.streamSynthesizeDocumentation(packet, inferenceModel, abortSignal)) {
    answer += chunk;
    yield chunk;              // raw model output, streamed straight to the user
}
const gateResult = this.answerGate.verify(answer, packet, ...);
if (gateResult.outcome === 'block') {
    yield '\n\n[RepoGuide: documentation report could not be fully validated against retrieved evidence. '
        + gateResult.diagnostics.join(', ') + ']';
}
```

Three problems, all verified:

1. **Every gate caveat is computed and discarded.** All the gate's corrections live in
   `gateResult.finalAnswer` (thin-evidence caveat `:1235`, relation-contradiction caveat `:1202`,
   dead-code caveat `:1169`, conceptual-coverage prefix `:1250`). This path streams the raw
   `answer` and never reads `finalAnswer`. A `revise` outcome produces **nothing at all** for the
   user.
2. **No `gateStatus` token.** `emitFinalAnswer`'s comment at `:508-511` states *"The 'Unverified'
   chip that `deriveGateChipInfo` falls back to when the token is absent is now purely defensive:
   no production path skips it."* `runDocumentationReport` is a production path
   (`ui/docReportPanel.ts:67`, reached from `extension.ts:18`) and skips it.
3. **Raw diagnostics dumped to the user.** `gateResult.diagnostics.join(', ')` is exactly the
   pattern `withheldAnswer.ts:16-18` documents as removed today: *"Four near-duplicate messages
   also existed across the block sites in queryDispatcher, each concatenating
   `gateResult.diagnostics.join(', ')` — internal checker jargon — directly into user-facing text."*
   A fifth site was not updated.

`canonicalAnswerTail.test.ts` asserts `runDocumentationReport`'s tail exemption as a *deliberate
decision*. The history/evidence-export exemption is defensible. Streaming ungated, uncaveated prose
with no verification signal is not the same decision, and is not what was reasoned about.

---

### P1-6. `evidencePacketBuilder.test.ts` is 0/5 and has been rotting silently — NEW

Covered under P0-4 for the CI framing; recorded separately because the suite itself needs fixing.
The two distinct causes:

- The test's hand-rolled `mockFactStore` (`src/test/evidencePacketBuilder.test.ts:30-40`) implements
  only `findBySymbol`. Production now calls `findByType` (`evidencePacketBuilder.js:263`) and
  `findBySymbols` (`factExpansion.js:42`). Four of five tests die on `TypeError` before asserting
  anything.
- Test 3 ("normalizes retrievalResult-sourced items too") fails on
  `expected 'src/gadget.ts', actual 'C:/workspace/src/gadget.ts'`. This one may be a
  Windows-path-fixture-on-Linux artifact rather than a product bug; I did not confirm either way and
  am not claiming it as a defect — but it needs adjudicating, not ignoring.

---

## P2 — quality / maintainability

### P2-1. `THIN_GROUNDING_MIN_SOURCES` is not actually shared — NEW

`answerGate.ts:41` declares `export const THIN_GROUNDING_MIN_SOURCES = 3`.
`mcp/gatherEvidenceResponseBuilder.ts:121` hard-codes `const sparse = totalFound < 3;`.

`answerGate.ts:1223-1226` says: *"this check deliberately reuses that module's validated signal —
actual grounding VOLUME — and its threshold, so the Chat gate and the MCP evidence card cannot
disagree about what 'thin' means."* They can disagree the moment either literal is changed. Only
`withheldAnswer.ts:2` actually imports the constant. One-line fix: import it in
`gatherEvidenceResponseBuilder.ts`.

### P2-2. `queryDispatcher.ts:578` points at a test file that does not exist — NEW

The doc comment on `finalizeApprovedAnswer` cites `src/test/explainSelectionCanonicalTail.test.ts`.
That path does not exist; the guard is `src/test/query/canonicalAnswerTail.test.ts`. Written today.
DoD #5.

### P2-3. `fetchSupplementalNumericFacts` is a full table scan, described as "one cheap indexed lookup" — NEW

`factStore.ts:152-184`, `findBySymbols`, issues `SELECT * FROM facts WHERE 1=1` and filters in JS.
The `idx_fact_symbol` index created at `factStore.ts` init is not used. This is a deliberate,
documented design in `factExpansion.ts:70` ("scans once and matches in memory"), so the scan itself
is not the finding — the finding is that `numericClaimSymbols.ts:20` justifies over-collecting
symbols on the basis that *"Returning a symbol that has no `numeric_threshold` fact costs one cheap
indexed lookup that returns nothing"*, and the ROADMAP repeats it. The real cost is a full scan of
the entire facts table, on every answer containing a number and a symbol-shaped token, added on top
of the scan `factExpansion` already performs during packet build. On a large repo that is a
per-query latency and memory cost the reasoning explicitly assumed away.

### P2-4. Webview HTML sets no Content-Security-Policy — NEW

`ui/htmlUtils.ts` `wrapHtml` emits no CSP `<meta>` while every consumer sets `enableScripts: true`
(`explainPanel.ts:29-33`, `docReportPanel.ts`, `sidebarProvider.ts`). Both panels I read render
model output via `textContent`, so this is defence-in-depth rather than a live injection path, and
`localResourceRoots` is correctly scoped in `explainPanel.ts:31` — but only when `extensionUri` is
supplied.

### P2-5. `ProgramGraphBuilder.build` does one awaited store round-trip per logical unit

`programGraphBuilder.ts:79-81`: `for (const unit of allUnits) { const fullUnit = await unitStore.getUnit(unit.id); ... }`,
after already loading every unit index with `limit: Number.POSITIVE_INFINITY` at `:29`. Sequential,
one query per unit, whole-repo scale. Pre-existing, not from today's work, but it sits directly in
the reindex path.

### P2-6. Scratch artifacts inside the tree — DoD #4

- `out/test/mock_workspace_*` — 8 directories created by `runtimeIngestion.test.js` and not cleaned
  up. Tests should not write scratch into the build output.
- `tmp/` at repo root (`resume_review/`, `wisdomai_pdf_review/`) is untracked and **not** in
  `.gitignore` — it will show up in every `git status` and is one `git add .` from being committed.
- All six new modules and all seven new test files from today are still untracked (`git status`
  shows `??` for `relationClaimVerifier.ts`, `withheldAnswer.ts`, `numericClaimSymbols.ts`,
  `answerStreamTokens.ts`, `importResolver.ts`, `modelProse.ts` and their tests). Today's work
  exists only in the working tree.

### P2-7. Orphaned subsystems — KNOWN class, but the documented list is out of date in both directions

Import-reachability closure from `src/extension.ts` + `src/mcp/mcpServer.ts` (resolving relative
specifiers, including the `.js`→`.ts` form `mcpServer.ts` uses): **419 of 605** non-test production
`.ts` files reachable, **186 unreachable**. Excluding `src/evaluation/` (65 files, standalone
harnesses — legitimate), that is ~121 orphaned production modules.

**Entirely unreachable, and *not* named in CLAUDE.md** — these are new to the documented record:

| Directory | Orphaned / total |
|---|---|
| `src/runtime/` | 18 / 20 |
| `src/indexing/semantic/` (shadow graph + fact evaluation) | 25 |
| `src/impact/` | 5 / 5 |
| `src/review/` | 4 / 4 |
| `src/incident/` | 2 / 2 |
| `src/diagnostics/` | 1 / 1 |
| `src/registry/` | 6 / 10 |

Spot-verified by grep, not just by the script: `runtimeIntelligenceBuilder`,
`reviewIntelligenceEngine`, `intentAwareBlastRadiusEngine`, `incidentStore`, `diagnosticsEngine`
have **zero** non-test importers anywhere. `shadowGraphBuilder`'s only importer is
`src/test/scripts/validateCP3E.ts`.

**Conversely, CLAUDE.md's list is partly stale in the good direction** — `src/orchestrator/` (0/3
orphaned), `src/intent/` (15/32), `src/evolution/` (2/8), `src/drift/` (2/5), `src/causal/` (1/4)
are now substantially wired. Worth correcting so the warning stays credible.

Note: import-reachability is a *lower* bar than invocation. A module can be imported and never
called. Treat these numbers as an upper bound on how much is live.

### P2-8. `src/evaluation/modelProse.ts` is not reachable from a production entry point

Its only importer is `evaluation/adversarialSuiteRunner.ts`, which is a manual `npm run
eval:adversarial` script. That is defensible — it is scoring infrastructure for the regression
suite, not product code — but it means the fix for ROADMAP finding "the permanent regression suite
was scoring the fabrication as a PASS" is itself only exercised when someone remembers to run the
suite by hand. Recording it so it is a decision, not an oversight.

---

## Claims that don't match the code

Spot-checked against the 2026-08-04 ROADMAP entries.

| # | Claim | Reality | Where |
|---|---|---|---|
| 1 | *"Threaded through all four stores: lanceStore, bm25Store, logicalUnitBm25Store, segmentedMiniSearchIndex."* | Signatures yes; **wiring no** for `logicalUnitBm25Store`. `expectedNonEmpty` has zero call sites for that store, and it is `clearAll()`ed in place on the reindex path. | P0-2. `indexManager.ts:357`, `extension.ts:628`, `logicalUnitBm25Store.ts:126` |
| 2 | *"`app/agents/__init__.py` has 68 real importers"* | ROADMAP.md:1670 itself records this number as **wrong** ("an artefact of a regex... The true direct count is 0"), and rightly flags it as something that "would otherwise look like supporting evidence". The corrected-away figure is still asserted in two shipped source files. | `graph/importResolver.ts:11-12`, `graph/programGraphBuilder.ts:283` |
| 3 | *"Returning a symbol that has no `numeric_threshold` fact costs one cheap indexed lookup that returns nothing"* | It costs a full `SELECT * FROM facts` table scan filtered in JS, once per answer. | P2-3. `factStore.ts:157`, `numericClaimSymbols.ts:20` |
| 4 | *"reusing the `sparse` threshold already validated in `gatherEvidenceResponseBuilder.ts` so the Chat gate and the MCP evidence card cannot disagree"* | Two independent literal `3`s. Only `withheldAnswer.ts` imports the constant. | P2-1. `answerGate.ts:41` vs `gatherEvidenceResponseBuilder.ts:121` |
| 5 | *"The 'Unverified' chip... is now purely defensive: no production path skips it."* | `runDocumentationReport` is a production path (`docReportPanel.ts:67`) and emits no `gateStatus`. | P1-5. `queryDispatcher.ts:508-511` vs `:1087-1095` |
| 6 | *"Wired at ALL THREE production gate call sites... so Chat and MCP `ask_repoguide` are both covered"* (supplemental numeric facts) | Three dispatcher sites, correct. But `subAnswerMerger.ts:75` and `subTaskRetry.ts:46` are also production gate calls and receive neither supplemental facts, nor `graphLookup`, nor `presentTechnologies` — so the merged answer of a *decomposed* question is gated more weakly than a single-shot one. Sub-answers individually do get the full gate, which limits the blast radius; the claim is still broader than the wiring. | `queryDispatcher.ts:779, 1005, 1092` vs `subAnswerMerger.ts:75` |
| 7 | *"the same revise + caveat tier"* / check 6d messaging | Accurate. Verified by execution. | — |
| 8 | Referenced test `src/test/explainSelectionCanonicalTail.test.ts` | Does not exist. | P2-2. `queryDispatcher.ts:578` |

Also noted: `LIMITATIONS.md` §2.5's correction of its own earlier false claim, and ROADMAP's
recording of the "68 importers" measurement error, are exactly the kind of self-correction this
project's value proposition rests on. Both are good. The gap is that the correction landed in the
narrative documents and not in the source comments that carry the same number (#2).

---

## False alarms checked and cleared

Recorded so these are not re-investigated.

1. **Windows path separators breaking `importResolver`.** `resolveImportToFiles` builds candidates
   with `/`, while `ProgramGraphBuilder` keys file nodes as `` `file::${unit.filePath}` ``. Not a
   bug: `logicalUnitStore.ts:109` and `factStore.ts:95` normalize `filePath` to forward slashes on
   persist. Node ids and candidates agree on both platforms.

2. **Check 6c (relation claims) missing on the decomposed path.** It is present.
   `subAnswerMerger.ts:75` passes `workspaceRoot` as the 4th argument, which is all 6c needs.
   The ROADMAP's claim that 6c covers the decomposed path is accurate. (What *is* missing there is
   `graphLookup` / `presentTechnologies` / supplemental facts — see claim #6.)

3. **Checks 6c and 6d being conditional on `confidence_mode` or `VerificationPlan`.** They are not.
   `answerGate.ts:1195` and `:1232` are unconditional inside `verify()`, exactly as §2.5 states.
   (Line numbers have drifted from the ones quoted in ROADMAP — 1173/1210 → 1195/1232.)

4. **Legacy `HybridQueryPipeline` fallback.** Confirmed gone. No such file, no `legacyPipeline`
   identifier, no `repoguide.queryArchitecture` setting. §2.5's correction is right.

5. **`explainSelectionResult()` still present.** Confirmed deleted;
   `queryDispatcher.ts:1039-1050` carries the removal record and no definition remains.

6. **Conversation history growing unbounded.** Bounded twice — `MAX_MESSAGES = 10` and
   `MAX_HISTORY_CHARS = 4000` with `trimToCharBudget()` (`conversationHistory.ts:17-77`). The
   char-cap reasoning there is well documented and correct.

7. **Timers leaked.** `IdleDetector.dispose()` clears its interval (`idleDetector.ts:58-61`);
   `sidebarProvider.healthPollTimer` clears itself at `:269-271`; `indexHealthPanel.autoRefreshTimer`
   is cleared at `:527`, `:578` and `:582`. No leak found.

8. **Empty `catch {}` blocks.** ~15 exist. All the ones I traced in production paths are
   defensible: `answerGate.ts:542` (unreadable file → treat as no evidence, correct direction),
   `answerStreamTokens.ts:56` (malformed control token → render as text, deliberately the safe
   direction), `pageRankGraphBuilder.ts:135-138` (cache-file unlink). The concentrations in
   `src/changeImpact/` and `src/comprehension/communityClustering.ts` are in orphaned or
   partially-orphaned code (P2-7) and are not on a live path. Not reporting these individually.

9. **`node --test` failures across the suite sweep.** Verified per-file before counting: the
   dominant causes are `Cannot find module '@lancedb/vectordb-linux-x64-gnu'` (sandbox lacks the
   native binding) and `Do not import '@jest/globals' outside of the Jest test environment`
   (jest-syntax files). Neither is a defect. `evidencePacketBuilder.test.ts` was checked
   specifically and is *not* in this category (P1-6).

10. **`fs.readFileSync` in `AnswerGate` as a blocking-I/O concern.** It is memoized per `verify()`
    call (`answerGate.ts:534-547`) and bounded by the number of distinct files an answer cites. Not
    a hot-path problem. (The traversal and unbounded-size aspects *are* — P1-1.)

---

## Summary of what to fix, in order

1. ~~**P0-1** — scope `hasGapPhrase` to a real abstention and stop it globally disabling blocking.
   One-word gate bypass; everything else in the trust story depends on this.~~
   **DONE 2026-08-05.** Plus a second root cause the audit missed (`technologyClaimVerifier`'s
   cross-sentence negation window), without which three of the five phrases still bypassed the
   flagship check.
2. **P0-3** — `"scope": "machine"` on `repoguide.ollamaUrl` + loopback validation. One line for the
   scope, a few for the check, and the local-only claim becomes true by construction.
3. **P0-2** — give `logicalUnitBm25Store` the generation-swap + absolute guard on the reindex path,
   and pass `expectedNonEmpty` at `extension.ts:628`.
4. **P1-1** — workspace-boundary check + size cap at `readFileFresh`.
5. **P0-4** — put the ~120 `node:test` files in CI. They run today, in seconds, without jest.
6. **P1-2 / P1-3 / P1-4 / P1-5** — cache invalidation, abort threading, doc-report tail.
