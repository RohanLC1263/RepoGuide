# Remediation plan — STRICT_AUDIT_2026-08-04 findings

Plan only. No code changed by this document. Each item is executed one at a time, using the same
loop as every defect fixed on 2026-08-04: **reproduce → root-cause → smallest fix that removes the
cause, not the symptom → regression test that would have caught it → re-verify against the original
repro → update ROADMAP/LIMITATIONS.** Nothing here is marked done until that loop closes.

## How this plan is sequenced, and why

A checklist ordered "P0 before P1" is not a plan — severity tells you what to fix, not what to fix
*first*. The ordering below optimizes for what senior engineering orgs actually optimize for when a
verification-heavy system is found to have a hole in its own verification layer: **stop trusting
green checkmarks, get a real safety net under the codebase, then fix in order of blast radius.**

1. **Fix the thing that invalidates every other check first.** P0-1 (`skipStrictBlocking`) means the
   gate can be silently defeated by the word "missing." Until it's fixed, every other verification
   claim in this codebase — including the ones already shipped — is unfalsifiable by the product's
   own logic. This is item 1 regardless of what else is broken.

2. **Get CI actually running the 154 tests before making more changes, not after.** The audit's own
   suggested order puts this fifth. That's the wrong call for how this specific remediation should be
   executed: everything from item 3 onward is a source change to a security- or correctness-critical
   path, and right now none of those changes get an automatic regression check — a human has to
   remember to run `node --test` by hand, which is exactly the discipline gap that let
   `evidencePacketBuilder.test.ts` rot to 0/5 unnoticed. Moving this to position 2 means items 3+ are
   self-verifying from the moment they land, and it's a low-risk, mechanical change (point
   `test:unit` at `node --test` over the ~120 non-jest files instead of the one-test dummy suite) —
   cheap, and it de-risks everything after it. This is the one deliberate reorder versus the audit's
   closing list.

3. **Then the two P0s that are independent of each other and of everything else** — P0-3 (privacy
   invariant: `ollamaUrl` must not be workspace-overridable) and P0-2 (the guard #7 shipped doesn't
   reach the store that's actually queried). Neither blocks the other; do the smaller, more
   mechanical one first (P0-3 is a package.json scope change plus a loopback check) so P0-2 — which
   touches the reindex lifecycle and needs a real A/B rebuild against CraftConnect to trust, same as
   #7 did — gets full attention on its own.

4. **P1-1 immediately after P0-2**, not batched with the other P1s: it's in the same file
   (`answerGate.ts`), the same call boundary (`readFileFresh`), and the same subsystem
   (relation-claim verification) that P0-2 and #10/#11 already touched today. Fixing it separately
   from its neighbors would mean re-loading the same context twice.

5. **Remaining P1s, grouped by the subsystem they actually live in**, not by ticket number — this is
   the difference between "close 4 tickets" and "fix the dispatcher's lifecycle handling once":
   - P1-2 (cache never invalidated) + P1-3 (Stop doesn't stop) + P1-4 (`explainSelection` drops its
     signal) are all instances of one root problem — `QueryDispatcher` is a long-lived singleton with
     mutable state and half-threaded cancellation, and every one of them is a plumbing gap in the
     same object. Fix them as one unit with one shared understanding of the dispatcher's lifecycle,
     not three unrelated patches.
   - P1-5 (doc report skips the gate contract) is genuinely separate — a missing call to
     `renderWithheldAnswer`/`emitFinalAnswer`, same shape as #6 already fixed elsewhere. Fast,
     isolated, done alone.
   - P1-6 (`evidencePacketBuilder.test.ts` 0/5) gets fixed as part of item 2 (CI), because a test
     that's about to start running in CI for the first time has to be green before it lands there —
     landing it red would mean CI is broken on day one.

6. **P2s last, batched as a single hygiene sweep**, because every one of them is small, independent,
   and low-risk (import a shared constant, fix a doc-comment path, add a CSP meta tag, correct two
   stale source comments, `.gitignore` two directories). Batching them is the right call *because*
   they're this small and this independent — bundling them costs nothing and doing seven separate
   investigate-fix-verify loops for one-line changes would be process for its own sake, which is the
   opposite of engineering discipline, not an instance of it.

This is also, not incidentally, how Anthropic/OpenAI/DeepMind engineers actually approach a report
like this in practice: **the finding that undermines trust in the verification system itself outranks
everything, a regression harness is infrastructure and gets built before more surface area is added
to what it needs to cover, and the rest is sequenced by shared blast radius, not by list position.**
No finding gets "fixed" by changing behavior until there's a test that fails first without the fix and
passes after it — the test is the artifact that proves the root cause was understood, not the code
change.

---

## Execution queue

### 1. P0-1 — `skipStrictBlocking` gate bypass — **DONE 2026-08-05**

> Closed. Full record in ROADMAP.md ("Gate bypass: one English word disabled every blocking check").
> New: `src/query/sentenceSpans.ts`, `abstentionScope()` in `abstentionVerifier.ts`,
> `src/test/query/gateBypassScope.test.ts` (35 tests, 24 fail against pre-fix behaviour).
>
> **The loop ran twice, as intended.** The first fix passed its own tests and still left the
> reproduction alive for three of the five phrases — a second, independent instance of the same
> defect class (unscoped suppression region) in `technologyClaimVerifier`. Found only because the
> re-verification step re-ran the ORIGINAL repro rather than trusting the new tests. Recorded here
> because it is the concrete justification for the plan's "no item is done until its own repro is
> re-run" rule.


- **Invariant to establish:** a hedging phrase may suppress the *specific* check it is reasoning
  about (numeric self-contradiction inside an abstention sentence); it must never suppress an
  unrelated check (technology fabrication, fabricated quotes/fences/paths, citations).
- **Fix direction:** replace the whole-answer substring scan with `detectAbstention` (already exists,
  already used at `queryDispatcher.ts:307`) scoped to the *sentence* containing the hedge, and remove
  the single `skipStrictBlocking` flag in favor of per-check suppression — only the numeric-contradiction
  check may consult it.
- **Test-first:** extend the existing repro (`"...caching. Error handling for a missing key is
  elsewhere." → pass`) into a regression test asserting it still `block`s. Add cases for all 5 phrases
  crossed with all 8 previously-bypassable block sites — this is the test that should have existed
  before `hasGapPhrase` was wired as a global switch.
- **Verify:** re-run the audit's exact repro pair (A/B) and confirm A and B both `block`; confirm the
  one legitimate case the flag was built for (genuine abstention sentence) still suppresses only the
  numeric check.
- **Blast radius:** `answerGate.ts` only. No store, no schema, no wiring changes elsewhere.

### 2. CI — run the 154 `node:test` files; land `evidencePacketBuilder.test.ts` green first

- **Fix direction:** `evidencePacketBuilder.test.ts` first — fix the hand-rolled `mockFactStore` to
  implement `findByType`/`findBySymbols` (production's real shape), adjudicate the path-separator
  assertion (confirm Windows-fixture-on-Linux vs. real bug before touching it). Then change
  `.github/workflows/ci.yml`'s `test:unit` step to run `node --test` over the ~120 non-jest suites
  (excluding the ones that require the native LanceDB binding or jest globals, both confirmed
  environment-only failures in the audit — exclude by pattern, not by silently skipping) instead of
  the one-test dummy suite. Jest suites stay out of CI until the documented flakiness is separately
  resolved — that's a real, distinct problem, not silently absorbed into this fix.
- **Test-first:** N/A in the usual sense — the "test" here is CI itself going from green-by-vacuity to
  green-by-actually-running-something. Verify by deliberately breaking one assertion in a suite that
  will now run and confirming the workflow fails.
- **Verify:** push a CI run, confirm the failing-suite count is 0 and the executed-file count matches
  `find src -name '*.test.ts' ! -name '*jest*'` minus the LanceDB-dependent set (documented by name).
- **Note:** ROADMAP's Phase 6 currently claims release engineering, including CI, is "Done." That
  claim is false per this audit and gets corrected in the same change, not left standing.

### 3. P0-3 — `ollamaUrl` privacy invariant

- **Fix direction:** `"scope": "machine"` in `package.json` for `repoguide.ollamaUrl` (removes
  workspace/folder override entirely — the fastest, most direct way to make the invariant true by
  construction rather than by convention). Add a loopback/allow-list validation at the single point
  `vscodeContext.ts` reads it, reject and fall back to `http://localhost:11434` with a visible warning
  otherwise. Add `capabilities.untrustedWorkspaces` explicitly (currently implicit) so the decision is
  recorded, not inferred. Surface the resolved endpoint somewhere the user can see it (status bar or
  startup check output) — the audit's specific complaint was "nothing shows the endpoint in use."
- **Test-first:** a workspace-scope settings override attempting to set `ollamaUrl` must not change
  the value the extension actually uses; a non-loopback URL must be rejected at the validation point.
- **Verify:** reproduce the audit's exact scenario — `.vscode/settings.json` with a remote
  `ollamaUrl` in a test workspace — and confirm the extension does not honor it.
- **Blast radius:** `package.json`, `context/vscodeContext.ts`, one new validation module. No query
  pipeline changes.

### 4. P0-2 — first-run guard doesn't reach `logicalUnitBm25Store`

- **Fix direction:** give `logicalUnitBm25Store` the same `beginRebuild()`/`commitRebuild()`
  generation-swap the other three stores already got, on the reindex path (`indexManager.ts:357`
  currently calls `clearAll()` in place with no swap at all — that's the deeper part of this root
  cause, not just the missing flag). Pass `expectedNonEmpty` at both call sites that currently omit it
  (`indexManager.ts` full-reindex path, `extension.ts:628` incremental-refresh path).
- **Test-first:** extend `emptyIndexGuard.test.ts`'s pattern to `LogicalUnitBm25Store` directly —
  "files walked > 0, zero logical units extracted" must be refused, matching the existing tests for
  the other three stores.
- **Verify:** the same class of real A/B rebuild against CraftConnect used to originally prove defect
  #7 — force a run where `logicalUnitExtractor` produces zero units for a walked file set, confirm the
  reindex now reports failure instead of silent success, and confirm a query against the corpus
  correctly reports "no evidence" rather than returning against a stale/empty index.
- **Blast radius:** `logicalUnitBm25Store.ts`, `indexManager.ts`, `extension.ts` (two call sites).
  Directly re-touches today's #7 work, which is why it's sequenced right after CI is in place.

### 5. P1-1 — path traversal in `readFileFresh` via relation-claim file paths

- **Fix direction:** one guard at the `readFileFresh` boundary in `answerGate.ts` — resolve the path,
  reject if `path.relative(workspaceRoot, resolved)` starts with `..` or is absolute, cap read size.
  Covers checks 6a2, 6b, and 6c at once because they all route through the same function.
- **Test-first:** the audit's exact repro (`../../../../../../etc/secrets/config.py`) as a unit test
  asserting the resolved read is refused; a legitimate in-workspace relative path still resolves.
- **Verify:** re-run the audit's reproduction against the compiled module, confirm it no longer
  escapes `workspaceRoot`.
- **Blast radius:** `answerGate.ts`, single function. Same file just modified for P0-2's neighbor
  work is why this is sequenced immediately after it.

### 6. P1-2 + P1-3 + P1-4 — `QueryDispatcher` lifecycle: cache invalidation and cancellation

Treated as one unit — same root cause (long-lived singleton, mutable/half-wired state), one shared
fix pass:

- **P1-2:** invalidate `presentTechnologies` on reindex completion (the dispatcher already survives
  reindex as a singleton; add the invalidation hook where reindex signals completion, rather than
  rebuilding the dispatcher — smaller blast radius).
- **P1-3:** thread the existing `AbortSignal` through the single-shot path — `generateForPlan` →
  `EvidenceAnswerSynthesizer.synthesize` needs the signal parameter it currently lacks, replacing the
  hard-coded `undefined` passed into `streamSynthesize` (which already accepts and forwards it
  correctly — the gap is one call site, not the streaming plumbing). Fix the single-slot
  `activeAbortController` overwrite in `sidebarProvider.ts` so a second in-flight request doesn't
  silently make the first uncancellable.
- **P1-4:** either wire `explainSelection`'s declared `abortSignal` into
  `synthesizeExplainSelection`/`streamExplain`, or remove the unused parameter from the public
  interface — decide which based on whether Stop is expected to work from the explain panel (product
  call, not an engineering one; default to wiring it, since the public interface already advertises
  it).
- **Test-first:** a synthesis in progress with an aborted signal must stop and post `cancelled`, on
  the single-shot path specifically (the decomposed path already has coverage per the audit). A second
  concurrent request must not strand the first request's controller.
- **Verify:** manual Stop-button test via Claude Code (live Extension Host, same split of
  responsibility used throughout — Claude Desktop implements, Claude Code verifies live model/UI
  behavior) plus the new automated tests for the plumbing.

### 7. P1-5 — `runDocumentationReport` skips the gate contract

- **Fix direction:** this is the fifth instance of the pattern #6 already fixed four times — route
  through `renderWithheldAnswer`/`emitFinalAnswer`'s existing tail instead of the hand-rolled
  raw-diagnostics-dump-and-stream. Same shape as the `explainSelection` rewiring already done today for
  defect #11; reuse that pattern.
- **Test-first:** extend `canonicalAnswerTail.test.ts` (already asserts this path's tail as a
  deliberate exemption) to assert the *correct* thing instead — `gateStatus` present, `finalAnswer`
  (with caveats) used instead of raw `answer`, no raw `diagnostics.join(', ')` in user-facing output.
- **Verify:** replay a `revise`-outcome documentation report and confirm the user sees the caveat, not
  nothing.

### 8. P2 hygiene sweep — batched, one PR

- Import `THIN_GROUNDING_MIN_SOURCES` in `gatherEvidenceResponseBuilder.ts` instead of the hard-coded
  `3` (P2-1).
- Fix the doc-comment test path in `queryDispatcher.ts:578` (P2-2).
- Correct the "cheap indexed lookup" comment in `numericClaimSymbols.ts` to describe the real cost
  (full table scan), and note it as a known, accepted cost, not a claim to keep repeating (P2-3).
- Add a CSP `<meta>` to `ui/htmlUtils.ts`'s `wrapHtml` — defence-in-depth even though no live
  injection path was found (P2-4).
- Correct the two shipped source comments still asserting the disproven "68 real importers" figure
  (`importResolver.ts:11`, `programGraphBuilder.ts:283`) — the ROADMAP record is already correct; the
  source comments are the last place the wrong number survives (claim-mismatch #2).
- `.gitignore` `tmp/` and `out/test/mock_workspace_*`; `git add` the six untracked modules and seven
  test files from 2026-08-04 so today's work isn't sitting only in the working tree (DoD #4).
- P2-5 (`ProgramGraphBuilder.build`'s per-unit round trip) and P2-7/P2-8 (orphaned-code census,
  `modelProse.ts` reachability) are **not** in this sweep — they're real but not defects with a
  one-line fix, and bundling a performance change or an orphaned-code decision into a hygiene PR is
  how a hygiene PR stops being reviewable. Logged as separate follow-up items below.

---

## Explicitly deferred, not forgotten

- **P2-5** (sequential per-unit store round-trip in `ProgramGraphBuilder.build`) — a real perf issue
  on large repos, needs its own before/after timing on a large corpus, not a drive-by fix.
- **P2-7** (orphaned-code census) — CLAUDE.md's known-orphan list needs updating in both directions
  (six new orphaned directories not listed; five previously-listed directories now substantially
  wired). This is a documentation-accuracy task, not a code fix, and should happen as its own pass
  once the P0/P1 queue is clear — doing it now would mean re-running the same reachability analysis
  twice as more of this queue lands and changes the import graph.
- **P2-8** (`modelProse.ts` only reachable from a manual eval script) — a product decision (should the
  adversarial suite run automatically, e.g. in CI as a scheduled job) more than an engineering defect;
  flagged for the user, not silently resolved either way.

## Definition of Done, applied to this queue

Per CLAUDE.md, none of the above is "done" on compile+lint alone. For each item: tests pass
(`npm run compile && npm run lint` plus the relevant suite), the fixed code is traced to a real
production entry point (already true for everything above — these are all fixes to code already on
the `extension.ts`/`mcpServer.ts` reachable path, not new subsystems), no orphaned duplicate is left
running in parallel, no scratch artifacts survive the change, and ROADMAP.md / LIMITATIONS.md /
STRICT_AUDIT_2026-08-04.md are updated in the same change — including marking this plan's items
closed only when their own re-verification step, not just the fix, is complete.
