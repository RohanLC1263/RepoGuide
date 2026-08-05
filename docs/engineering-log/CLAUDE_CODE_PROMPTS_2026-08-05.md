# Remaining STRICT_AUDIT_2026-08-04 items — priority ranking + Claude Code prompts

P0-1 is closed (ROADMAP.md, "Gate bypass: one English word disabled every blocking check"). This
document ranks everything still open and hands off every item that needs Claude Code's live
capabilities (Extension Host, a resident Ollama model, `git`, GitHub Actions) as a self-contained
prompt. Bucket A items (Claude Desktop, deterministic, provable without a live environment) are
listed for completeness and tracking only — no prompt needed, they're worked in-session the same
way P0-1 was.

## Priority ranking

| # | Item | Bucket | Why this position |
|---|---|---|---|
| **0** | **P2-6 — commit the uncommitted work** | C | Not a defect ranking — a standing risk to everything else. 14 files across two days of work exist only in the working tree. Done before anything below is touched. |
| 1 | **P0-3 — `ollamaUrl` privacy invariant** | B | Highest trust leverage per line changed; the product's headline promise is currently a default, not an invariant. |
| 2 | **P0-2 — empty-index guard doesn't reach `logicalUnitBm25Store`** | B | Directly negates the #7 fix already shipped; the store that's wrong is the one the query pipeline actually reads. |
| 3 | P1-1 — path traversal at `readFileFresh` | A | No prompt — Desktop implements and verifies this turn. |
| 4 | **P0-4 — CI runs nothing** | C | Everything from here down should land with a CI run behind it, not a hand-run test log. |
| 5 | **P1-6b — the one `evidencePacketBuilder.test.ts` failure needing Windows adjudication** | C | The other four are Bucket A (stale mock, fixed alongside). This one specific assertion needs a real Windows path. |
| 6 | **P1-2 — `presentTechnologies` cache never invalidated** | B | Reintroduces a false-block class the project has already reverted twice; needs a live reindex-without-restart to prove. |
| 7 | **P1-3 / P1-4 — Stop is a no-op; `explainSelection` drops its signal** | B | Needs a resident Ollama model and an actual generation to abort; cannot be simulated. |
| 8 | P1-5 — doc report skips the gate contract | A | No prompt — Desktop implements and verifies this turn. |
| 9 | **P2-4 — no CSP on webview HTML** | B | Small fix, but CSP silently breaks webviews; must be verified live before shipping. |
| 10 | **P2-5 — `ProgramGraphBuilder.build` per-unit round trip** | B | Perf-only; needs before/after timing on a real large corpus, not a guess. |
| 11 | P2-1 / P2-2 / P2-3 / claim #2 (stale "68 importers") | A | No prompt — one hygiene sweep, Desktop, end of the current queue. |
| 12 | P2-7 — orphan census update | A | No prompt — deliberately deferred until the queue above clears (the import graph is still moving). |
| 13 | **P2-8 — should the adversarial suite run in CI?** | C | Product decision bundled into the CI prompt below, not a separate task. |

**Bucket A — no prompt, tracked for completion alongside this queue:** P1-1, P1-5, P1-6 (4 of 5
tests), P2-1, P2-2, P2-3, claim #2, P2-7.

Everything below is a standalone prompt for Claude Code. Each is self-contained — written to be
pasted into a fresh Claude Code session with no dependency on this conversation's context — and
each is idempotent: it opens by checking whether Claude Desktop already implemented the fix
(ROADMAP.md + `git log`/`git status`), and either verifies what's there or implements it first.
None may be marked done on a green compile. Each ends with a mandatory update to ROADMAP.md and
`STRICT_AUDIT_2026-08-04.md` recording the live evidence obtained.

---

## Prompt 0 — P2-6: commit the work (run this first, before anything else)

```
You are working in the RepoGuide repo. Before touching any of the audit remediation items, secure
the work that already exists only in the working tree.

CONTEXT
`docs/engineering-log/STRICT_AUDIT_2026-08-04.md` (P2-6) and
`docs/engineering-log/WORK_SPLIT_2026-08-05.md` both flag this: two days of fixes — six-plus new
modules, all their regression tests, and the P0-1 fix landed 2026-08-05 — exist only in the working
tree. One `git checkout` loses all of it. Nothing else in this queue should be started until this
is done.

DO, IN ORDER
1. `git status --porcelain` — get the full, current list of untracked and modified files. Do not
   assume the list from the audit is still accurate; re-derive it.
2. Read `.gitignore`. Add `tmp/` (contains `resume_review/`, `wisdomai_pdf_review/` — untracked,
   not ignored, one `git add .` from being committed) and any `out/test/mock_workspace_*` scratch
   directories `runtimeIngestion.test.js` leaves behind (check whether that test already cleans up
   after itself before assuming it needs a gitignore entry rather than a test fix — if it's supposed
   to clean up and doesn't, that's a separate, smaller defect worth a one-line note in ROADMAP.md,
   not silently gitignoring test pollution).
3. Run `npx tsc --project ./ --noEmit` and `npx eslint src` — confirm both are clean BEFORE
   committing. Do not commit on a red compile.
4. Run the full available test sweep (`node --test` over the `out/test` suites that don't need
   jest or the native LanceDB binding — on your Windows machine both should be available, so you
   should be able to run closer to the full 154+ suite set, not the ~130 Desktop's sandbox manages).
   Record the pass/fail counts.
5. Stage and commit. Use a real commit message describing what's in it (not "wip" / "checkpoint") —
   this repo's own convention is descriptive commits (`git log --oneline -5` to see the pattern).
   Split into logically separate commits if the diff mixes unrelated concerns (e.g., the P0-1 gate
   fix vs. earlier 2026-08-04 defect fixes vs. doc-only changes) — do not force one mega-commit if
   the history would read better split, but do not over-split either; use judgment the way a senior
   engineer preparing a clean PR history would.
6. Push, if a remote is configured and you have write access. If not, say so explicitly rather than
   silently stopping.

DO NOT
- Do not delete or rewrite any of the changed files to "clean them up" as part of this task — that
  is scope creep. This task is exclusively about getting existing, already-reviewed work under
  version control safely.
- Do not squash or rebase existing history.

REPORT BACK
State exactly what was committed (file list + commit hashes), what test sweep you ran and its
result, and whether the push succeeded. If tsc or eslint were NOT clean, stop and report that
instead of committing broken code — do not "fix it forward" inside this task without flagging it.
```

---

## Prompt 1 — P0-3: `ollamaUrl` privacy invariant

```
You are working in the RepoGuide repo (a privacy-first, local-first VS Code extension —
CLAUDE.md's stated architecture contract). Fix and prove, with live evidence, that the "code never
leaves the machine" promise is enforced by code, not by a default value.

BACKGROUND — READ FIRST
`docs/engineering-log/STRICT_AUDIT_2026-08-04.md`, finding P0-3. Full detail there; summary:
`repoguide.ollamaUrl` (read via `vscode.workspace.getConfiguration('repoguide')` in
`context/vscodeContext.ts:20-23`) carries no `scope` in `package.json`, so it defaults to `window`
scope — a workspace's own `.vscode/settings.json` can silently redirect it. Every embedding call
and every synthesis prompt (raw source code) goes to `${ollamaUrl}`. There is no validation of the
resulting URL, and `package.json` declares no `capabilities` block. The realistic attack is not a
malicious drive-by workspace (VS Code already disables extensions there) — it's a colleague's repo,
or any public repo, that the user opens specifically TO USE REPOGUIDE ON IT, carrying a committed
`.vscode/settings.json` that quietly points every request at a remote host.

STEP 0 — CHECK CURRENT STATE FIRST
`git log --oneline -20` and `ROADMAP.md` (search for "ollamaUrl" or "P0-3"). Claude Desktop may
already have implemented this. If so, skip to STEP 3 (verification) — do not re-implement. If the
implementation is partial or you disagree with an approach taken, say so explicitly in your report
rather than silently overwriting it.

STEP 1 — REPRODUCE THE VULNERABILITY AS IT STANDS, BEFORE CHANGING ANYTHING
In a scratch test workspace, write `.vscode/settings.json` with
`"repoguide.ollamaUrl": "http://127.0.0.1:9" ` (an unreachable but syntactically valid host you
control the meaning of) or better, stand up a tiny local HTTP listener on an unusual port and point
`ollamaUrl` at it. Open the workspace in a real Extension Development Host (F5), trigger an
embedding or query, and confirm — by observing the listener receive the request, or via a network
log — that the extension really does honor the workspace override today. Do not skip this: a fix
with no prior reproduction is a guess at a problem, and this whole audit's discipline (see
CLAUDE.md's Definition of Done and every 2026-08-04/05 ROADMAP entry) is "prove the failure before
claiming the fix."

STEP 2 — IMPLEMENT (if not already done, or to correct a partial implementation)
1. `"scope": "machine"` on `repoguide.ollamaUrl` in `package.json` — this is the load-bearing
   change; VS Code will then refuse to let workspace/folder settings override it at all.
2. At the single point `ollamaUrl` is read (`context/vscodeContext.ts`), add validation: reject
   any non-loopback host (not `localhost`/`127.0.0.1`/`::1`) UNLESS the user has explicitly opted
   in via a SEPARATE, also machine-scoped setting (e.g. `repoguide.allowRemoteOllama`, default
   false). Decide the exact failure behavior yourself (fall back to the loopback default with a
   visible warning is the safer default; do not silently swallow a misconfiguration).
3. Add `capabilities.untrustedWorkspaces` to `package.json` explicitly, with a decision recorded in
   a comment or ROADMAP.md for WHY (currently implicit — VS Code disables the extension by default
   in untrusted workspaces, which is fine, but the audit's point is that this should be a stated
   decision, not an unexamined default).
4. Surface the resolved endpoint somewhere the user can actually see it — status bar item, or the
   existing startup-check output (`health/startupCheck.ts`) — so "it still works" is never the
   user's only signal about where their code is going.
5. Add unit tests for the validator (pure logic, this part IS testable without a live host —
   Desktop may have already written these; check first).

STEP 3 — VERIFY LIVE, THE THING DESKTOP CANNOT
Repeat STEP 1's exact reproduction against the FIXED extension:
- Confirm the same malicious `.vscode/settings.json` no longer changes which host receives
  requests — the listener you controlled must NOT receive the request post-fix.
- Confirm a LEGITIMATE machine-level override (set via VS Code's User settings, not workspace)
  still works, so you haven't broken the setting for someone who genuinely runs Ollama on another
  machine on their LAN.
- Confirm the resolved-endpoint UI surface actually renders and shows the real value.
- Confirm normal chat/MCP functionality against the default local Ollama endpoint is unaffected —
  run a real query end to end.

DEFINITION OF DONE (CLAUDE.md, all five, applied to this task)
tsc + lint clean; the relevant test suite passes; the fix is on the real activation path (not just
its own test); no duplicate validation logic left elsewhere; no scratch files left in the tree;
ROADMAP.md AND `docs/engineering-log/STRICT_AUDIT_2026-08-04.md`'s P0-3 entry are updated in the
same change with the live reproduction (before) and live verification (after) evidence — screenshots
or terminal transcripts of the listener test, not just "verified manually."

Do not mark this done without the live before/after evidence from steps 1 and 3. A green unit test
suite alone is insufficient for this specific finding — the whole point is that VS Code's settings
resolver, which no unit test exercises, is the actual enforcement mechanism.
```

---

## Prompt 2 — P0-2: empty-index guard doesn't reach `logicalUnitBm25Store`

```
You are working in the RepoGuide repo. Close the gap in today's own first-run empty-index guard: it
protects two stores the query pipeline doesn't read from, and leaves the one it does read from
(`logicalUnitBm25Store`) with the flag never wired to any production call site.

BACKGROUND — READ FIRST
`docs/engineering-log/STRICT_AUDIT_2026-08-04.md`, finding P0-2, and ROADMAP.md's "First-run
false-success: empty-index guard made absolute (2026-08-04)" entry (the original #7 fix this
extends). Summary: `expectedNonEmpty` is threaded into `lanceStore`, `bm25Store`,
`logicalUnitBm25Store`, and `segmentedMiniSearchIndex`'s `commitRebuild()` signatures, but is only
PASSED by a production caller for the first two (`indexManager.ts:384-385`).
`EvidencePacketBuilderStores.bm25Store` — the one the actual evidence retrieval pipeline reads
(`evidencePacketBuilder.ts:47`, wired to `luBm25Store` at `extension.ts:739`) — is `clearAll()`ed
in place on the full-reindex path with NO generation-swap at all (`indexManager.ts:357`), and
committed WITHOUT the flag on the incremental-refresh path (`extension.ts:628`).

STEP 0 — CHECK CURRENT STATE FIRST
`git log --oneline -20`, ROADMAP.md (search "P0-2" / "logicalUnitBm25Store"). If Desktop has already
implemented this, go straight to STEP 2 (live verification). If partial, say so in your report.

STEP 1 — CONFIRM THE GAP AS DESCRIBED, BEFORE CHANGING ANYTHING
`grep -rn "expectedNonEmpty" src/` — confirm for yourself that it appears in
`logicalUnitBm25Store.ts`'s signature and forward call, and at NO other call site. This takes two
minutes and turns "the audit said so" into something you've verified yourself, which is the
standard this whole project holds itself to.

STEP 2 — IMPLEMENT (if not already done)
1. Give `logicalUnitBm25Store` the same `beginRebuild()`/`commitRebuild()` generation-swap the
   other three stores already have, ON THE FULL-REINDEX PATH specifically — `indexManager.ts:357`
   currently does `await this.logicalUnitBm25Store.clearAll()` with no swap at all. That is the
   deeper part of the root cause; wiring the flag onto a `clearAll()` call site fixes nothing,
   because there's no old generation left to fall back to if the new one comes up empty.
2. Pass `expectedNonEmpty` at BOTH the full-reindex call site and the incremental-refresh call site
   (`extension.ts:628`, currently `await luBm25Store.commitRebuild(previousUnitCount)` with no
   second argument).
3. Extend `src/test/store/emptyIndexGuard.test.ts`'s existing pattern to `LogicalUnitBm25Store`
   directly, mirroring the tests already there for the other three stores.

STEP 3 — VERIFY LIVE AGAINST A REAL REPO, THE THING DESKTOP CANNOT DO
This is the load-bearing verification and it CANNOT be satisfied by a unit test alone — the failure
mode is an interaction between two separate pipeline stages (chunking vs. logical-unit extraction)
that only shows up on a real reindex.
1. Open CraftConnect (or another real multi-language repo you have locally) in the Extension
   Development Host.
2. Engineer a real condition where chunking succeeds but logical-unit extraction produces zero
   units for at least one walked file — the exact failure class ROADMAP already documents once
   under "Script-role files produced ZERO logical units." If that specific bug is already fixed,
   find or construct another way to make extraction legitimately yield zero units for some file
   (e.g., a temporarily malformed/edge-case file), so you have a REAL positive case, not a
   mocked one.
3. Run a full reindex. Confirm — BEFORE your fix, if you haven't already applied it, then AFTER —
   that the reindex now reports FAILURE (or at minimum a loud, actionable warning) instead of
   silent success when this condition occurs, and that a subsequent query against the corpus
   correctly reports "no evidence" / triggers the guard, rather than silently answering from an
   empty logical-unit index.
4. Separately, run an INCREMENTAL refresh (edit one file, save, let the background index update
   run) and confirm the flag reaches that path too.
5. Run the two suites that could only be verified on a machine with the real LanceDB native
   binding: `indexing/reindexAtomicity.test.js` and `indexing/indexManagerReadinessState.test.js`.
   Record pass/fail.

DEFINITION OF DONE
tsc + lint clean; `emptyIndexGuard.test.ts` extended and passing; `reindexAtomicity` and
`indexManagerReadinessState` passing on your machine; the live CraftConnect repro from step 3
documented with the actual before/after behavior (what the UI/logs showed); ROADMAP.md and
`STRICT_AUDIT_2026-08-04.md`'s P0-2 entry updated with this evidence, including an explicit
statement of which of the four stores now have BOTH the signature AND a real production call site
passing the flag (all four, this time — say so only once you've grepped and confirmed it, the same
way the audit did).
```

---

## Prompt 3 — P0-4: get real test coverage into CI

```
You are working in the RepoGuide repo. `.github/workflows/ci.yml` currently runs `npm run compile`,
`npm run lint`, and `npm run test:unit` — which is `mocha out/test/extension.test.js`, a single
file containing one test that asserts `true`. 154+ real test files run in zero automated pipelines.
Fix this properly — not by re-enabling the flaky jest suite (a separate, real, already-documented
problem), but by getting the ~120+ `node:test`-based suites running in CI today.

BACKGROUND — READ FIRST
`docs/engineering-log/STRICT_AUDIT_2026-08-04.md`, finding P0-4, and
`docs/engineering-log/WORK_SPLIT_2026-08-05.md` (the section on the LanceDB binding trap — READ
THIS CAREFULLY, it changes what the exclusion list must look like).

THE TRAP TO AVOID
Claude Desktop's sandbox is Linux and lacks the `@lancedb/vectordb-linux-x64-gnu` native binding,
so ~11 suites fail there for a purely environmental reason. GitHub Actions' `ubuntu-latest` runner
WILL have the correct Linux binding once `npm ci` installs it fresh — so those 11 suites are NOT
actually blocked in CI, only in Desktop's sandbox. Do not copy Desktop's failure list into the CI
exclusion config. Build the exclusion list from a REAL RUN ON A REAL LINUX RUNNER (or your own
Windows machine as a proxy, cross-checked against what `npm ci` on ubuntu-latest would install),
not from any document produced by an environment with the wrong native binding.

DO
1. First, on your own machine (which has the correct binding for its platform), run the full
   `node --test` sweep across every `out/test/**/*.test.js` file that doesn't use jest syntax
   (`@jest/globals` imports). Get a true baseline: which suites pass, which fail and why.
   For any failure, determine root cause before excluding it — "fails in my environment" is not
   sufficient justification; distinguish real defects from environment gaps the way the audit did
   (it names its criteria: verify each failure's cause before counting it, not just noting the
   count).
2. Update `.github/workflows/ci.yml` to run `node --test` over that suite set (excluding only
   genuinely jest-dependent files, by explicit glob or file list, with a comment explaining why
   each exclusion exists — not a blanket "skip anything that fails").
3. `evidencePacketBuilder.test.ts`: confirm whether Claude Desktop has already fixed the four
   `TypeError` failures there (stale hand-rolled mock missing `findByType`/`findBySymbols` — check
   ROADMAP.md/git log first). The FIFTH failure — `expected 'src/gadget.ts', got
   'C:/workspace/src/gadget.ts'` — needs YOUR adjudication specifically, because it's suspected to
   be a Windows-path-fixture-on-Linux artifact and you're the one positioned to tell. Determine on
   your own Windows machine whether this is a real path-normalization defect in production code or
   a fixture that hardcodes a POSIX-style path where a Windows one is produced. Fix whichever it
   actually is — do not paper over it by loosening the assertion without understanding which side
   is wrong.
4. Add a step that deliberately breaks one assertion in a suite that will now run (temporarily, in
   a scratch branch or locally — do not merge this), push, and confirm the workflow actually FAILS.
   This is the verification that CI is really wired, not merely configured — a CI config that looks
   right but silently green-passes everything is worse than no CI, because it manufactures false
   confidence. Revert the deliberate breakage before finishing.
5. Push the real fix, watch an actual GitHub Actions run complete, and record the run URL/result.
6. Decide and record (in ROADMAP.md, as an explicit decision, not left implicit) whether the
   adversarial suite (`npm run eval:adversarial`, currently only reachable via manual invocation —
   see `STRICT_AUDIT_2026-08-04.md` P2-8, `src/evaluation/modelProse.ts`) should run in CI as a
   scheduled job. This needs a resident Ollama model, so it can't run on a standard GH Actions
   runner without self-hosting — weigh that cost against the value (it's what caught the
   fabrication-scoring-as-PASS bug once already) and write down the decision and why, even if the
   decision is "not yet, because X."

DO NOT
- Do not attempt to fix jest flakiness as part of this task. That is real, documented, and
  deliberately out of scope here — routing around it (via `node --test`) is the whole point of this
  fix, not re-litigating it.
- Do not silently widen the exclusion list beyond what step 1's real run justifies.

REPORT BACK
The true pass/fail baseline from step 1 with causes attributed per failure, the final CI config,
the GitHub Actions run URL confirming both a real pass and (during testing) a real fail-on-breakage,
the `evidencePacketBuilder.test.ts` fifth-test adjudication and fix, and the P2-8 decision recorded
in ROADMAP.md. Update `STRICT_AUDIT_2026-08-04.md`'s P0-4 and P1-6 entries to closed with this
evidence.
```

---

## Prompt 4 — P1-2: `presentTechnologies` cache invalidation

```
You are working in the RepoGuide repo. `QueryDispatcher.getPresentTechnologies()`
(`queryDispatcher.ts:279-284`) caches which technologies exist in the repo for the lifetime of the
singleton `QueryDispatcher` instance, and nothing ever invalidates it. Reindexing (without
restarting VS Code) does not refresh it. The consumer — `AnswerGate`'s technology-fabrication check
— HARD BLOCKS any answer naming a technology not in the cached set. Net effect: add a real
dependency, reindex, ask about it, and a CORRECT answer gets refused.

BACKGROUND — READ FIRST
`docs/engineering-log/STRICT_AUDIT_2026-08-04.md`, finding P1-2. Note the framing there: "This is
the false-block class the project has explicitly reverted checks for twice, reintroduced through a
cache-invalidation gap rather than through the matcher." Read `technologyClaimVerifier.ts`'s own
doc comment on why this check exists and why it's precision-tuned — your fix must not touch the
matcher itself, only the cache lifecycle around it.

STEP 0 — CHECK CURRENT STATE FIRST. If Desktop already implemented the invalidation hook, go to
STEP 2.

STEP 1 — IMPLEMENT (if not already done)
Add an invalidation hook fired when a reindex completes (full or incremental — both change what
technologies are present) that clears `this.presentTechnologies` on the live `QueryDispatcher`
instance, rather than rebuilding the dispatcher itself (smaller blast radius, and the dispatcher is
constructed once at `activate()` — rebuilding it would be a bigger, riskier change than this defect
warrants). Decide where the reindex-completion signal already exists in the codebase (there should
be one, since the extension already reacts to reindex completion for other UI updates) rather than
inventing a new one.

STEP 2 — VERIFY LIVE, THE THING DESKTOP CANNOT DO
In the Extension Development Host, against a real workspace:
1. Index a repo that does NOT use one of the ~50 terms in `KNOWN_TECHNOLOGY_TERMS`
   (`technologyClaimVerifier.ts:28-37`), e.g. Redis.
2. Ask RepoGuide something that would make it (correctly, per your judgment reading the code)
   assert Redis is used, if it were used. Confirm the ordinary "not present" response.
3. WITHOUT restarting VS Code, add real Redis usage to the repo (an import + a call site is
   enough — it doesn't need to be a full integration).
4. Trigger a reindex (either wait for the incremental watcher or run the manual reindex command).
5. Ask the same question again, same session. BEFORE your fix: confirm the answer is wrongly
   blocked (reproduce the bug for real). AFTER your fix: confirm the correct "yes, Redis is used"
   answer now passes the gate.
6. Also confirm the reverse doesn't regress: a technology that's genuinely absent is still
   correctly blocked in the same live session, so you haven't just disabled the check.

DEFINITION OF DONE
tsc + lint clean; a unit test for the invalidation hook itself (this part is testable without a
live model — check whether Desktop already wrote one); the live 6-step reproduction above with
explicit before/after outcomes; ROADMAP.md and `STRICT_AUDIT_2026-08-04.md`'s P1-2 entry updated
with this evidence.
```

---

## Prompt 5 — P1-3 / P1-4: Stop button and `explainSelection` abort signal

```
You are working in the RepoGuide repo. Two related findings, same root defect shape — a plumbed
`AbortSignal` that compiles, reads correctly, passes review by eye, and does nothing:

1. **P1-3.** The single-shot chat path (the default, dominant path —
   `queryDispatcher.ts:454`, `generateForPlan`) never threads its `AbortSignal` into
   `EvidenceAnswerSynthesizer.synthesize`, which has no signal parameter at all
   (`evidenceAnswerSynthesizer.ts:16-23`) and hard-codes `undefined` into a `streamSynthesize` call
   that DOES accept and forward a signal correctly when given one. Pressing Stop aborts a
   controller nobody is listening to. Secondary bug, same file: `sidebarProvider.ts`'s
   `activeAbortController` is a single slot — a second question submitted mid-generation overwrites
   it, and the first request's `finally` then nulls it, making the FIRST request permanently
   uncancellable.
2. **P1-4.** `queryDispatcher.ts:991-1037`'s `explainSelection` declares `abortSignal?: AbortSignal`
   in its signature and never references the identifier in its body.
   `synthesizeExplainSelection` takes no signal parameter either. `ui/explainPanel.ts`'s
   `streamExplain` additionally never registers `panel.onDidDispose`, so closing the panel mid-
   stream doesn't stop generation either.

BACKGROUND — READ FIRST
`docs/engineering-log/STRICT_AUDIT_2026-08-04.md`, findings P1-3 and P1-4 in full.

STEP 0 — CHECK CURRENT STATE FIRST. If Desktop already implemented the threading, go to STEP 2.

STEP 1 — IMPLEMENT (if not already done)
1. Give `EvidenceAnswerSynthesizer.synthesize` a signal parameter, thread it from
   `generateForPlan` through to the `streamSynthesize` call that already knows how to use it
   (replace the hard-coded `undefined`).
2. Fix the single-slot `activeAbortController` in `sidebarProvider.ts` so a second in-flight
   request doesn't strand the first's controller — decide the right concurrency model yourself
   (queue, reject-the-second, or a map keyed by request id) and document the choice.
3. Wire `explainSelection`'s `abortSignal` into `synthesizeExplainSelection` /
   `EvidenceAnswerSynthesizer`'s explain path. Register `panel.onDidDispose` in
   `ui/explainPanel.ts`'s `streamExplain` to abort generation when the panel closes.
4. Post a `cancelled` message on abort where the UI expects one (check what the sidebar webview
   currently listens for on cancellation, if anything, and match it).

STEP 2 — VERIFY LIVE, THE ONE THING THIS DEFECT CLASS ABSOLUTELY REQUIRES
This cannot be verified by a unit test in any meaningful way — the bug is specifically that a real,
running Ollama generation doesn't stop. You need a resident local model for this.
1. Start a real chat query against a nontrivial question (something that generates for several
   seconds, not an instant response).
2. Press Stop mid-generation. Confirm — with the actual Ollama process/logs, not just the UI going
   quiet — that generation TERMINATES rather than running to completion in the background. If
   `determinism.resetModelBeforeSynthesis` is on by default (check), also confirm the model doesn't
   get needlessly reloaded by a leaked in-flight generation.
3. Confirm a `cancelled` state reaches the UI (not just silence).
4. Submit two questions back to back, abort the FIRST while the second is starting, confirm the
   first is actually cancellable and the second isn't accidentally killed too (or vice versa,
   depending on the concurrency model you chose in step 1.2 — confirm it behaves as designed).
5. Open the explain-selection panel, start a generation, close the panel mid-stream, confirm
   generation stops (again, check the actual Ollama process, not just that the UI disappeared).

DEFINITION OF DONE
tsc + lint clean; whatever unit-testable plumbing exists is covered (check first); the live 5-step
verification above with explicit pass/fail per step; ROADMAP.md and
`STRICT_AUDIT_2026-08-04.md`'s P1-3 and P1-4 entries updated together (they're one fix pass, per
the remediation plan's grouping — don't split the writeup).
```

---

## Prompt 6 — P2-4: Content-Security-Policy on webview HTML

```
You are working in the RepoGuide repo. `ui/htmlUtils.ts`'s `wrapHtml` emits no
Content-Security-Policy `<meta>` tag, while every consumer (`explainPanel.ts`, `docReportPanel.ts`,
`sidebarProvider.ts`) sets `enableScripts: true`. The audit found no live injection path (both
panels it read render model output via `textContent`, not `innerHTML`), so this is defence-in-depth,
not an active vulnerability — but it needs a live check before shipping, because CSP is exactly the
kind of change that silently breaks legitimate inline scripts/styles/resource loads with no error a
unit test would catch.

BACKGROUND — READ FIRST
`docs/engineering-log/STRICT_AUDIT_2026-08-04.md`, finding P2-4.

STEP 0 — CHECK CURRENT STATE FIRST. If Desktop already added the CSP meta tag, go to STEP 2.

STEP 1 — IMPLEMENT (if not already done)
Add a CSP `<meta>` in `wrapHtml` scoped as tightly as the actual webview needs — read what each of
the three consumer panels actually loads (inline `<script>`, inline `<style>`, local resource URIs
via `localResourceRoots`) before choosing the policy, rather than pasting a generic restrictive CSP
and hoping. `explainPanel.ts:31` scopes `localResourceRoots` correctly only when `extensionUri` is
supplied — check whether that's always the case at every construction site, and if not, fix that
too as part of getting this right, since a CSP fix built on an inconsistently-scoped resource root
will fail intermittently.

STEP 2 — VERIFY LIVE, THE THING A COMPILE CANNOT CATCH
In the Extension Development Host:
1. Open the sidebar chat panel. Confirm it still renders and functions — send a real query,
   confirm the answer streams in, confirm any interactive elements (buttons, the trust chip, gate
   status rendering) still work.
2. Open the explain-selection panel on a real code selection. Confirm it renders and streams.
3. Open the documentation report panel. Confirm it renders.
4. Open the browser/webview dev tools (VS Code: "Developer: Open Webview Developer Tools") for
   each panel and check the console for CSP violation warnings. Zero is the target; any violation
   means the policy is either too strict (breaking something legitimate) or something in the panel
   genuinely needs tightening on the code side rather than loosening the policy — diagnose which
   before changing anything.
5. Confirm the gate-status chip and any other dynamically-inserted UI (which the audit notes is
   rendered via `textContent`, not `innerHTML`) still displays correctly — CSP changes sometimes
   interact with dynamically constructed style attributes even when there's no injection risk.

DEFINITION OF DONE
tsc + lint clean; all three panels confirmed working live with zero unexpected CSP console
violations; ROADMAP.md and `STRICT_AUDIT_2026-08-04.md`'s P2-4 entry updated with this evidence.
Do not merge this if any panel fails to render — revert and re-scope the policy rather than
shipping a broken UI for a defence-in-depth hardening change.
```

---

## Prompt 7 — P2-5: `ProgramGraphBuilder.build` per-unit round trip

```
You are working in the RepoGuide repo. `programGraphBuilder.ts:79-81` does one AWAITED store round
trip per logical unit inside a loop (`for (const unit of allUnits) { const fullUnit = await
unitStore.getUnit(unit.id); ... }`), AFTER already loading every unit's index entry in one call with
`limit: Number.POSITIVE_INFINITY` at `:29`. This sits directly in the reindex path. It's pre-existing
(not introduced by 2026-08-04/05 work) and the remediation plan deliberately deferred it pending a
real before/after measurement rather than a drive-by fix — that measurement is this task.

STEP 0 — CHECK CURRENT STATE FIRST. If Desktop already batched this, go straight to STEP 2
(measure).

STEP 1 — MEASURE BEFORE CHANGING ANYTHING
On a real, reasonably large local repo (CraftConnect, or something larger if you have one handy —
the finding specifically calls out "whole-repo scale" as the concern, so test at a scale where a
per-unit sequential round trip would plausibly matter; a 50-file toy repo will not show the effect),
time a full reindex, isolating this stage specifically if you can instrument it (a
`console.time`/`console.timeEnd` around the loop is sufficient, doesn't need to be committed).
Record the unit count and the wall-clock time for this loop specifically, not just total reindex
time — you need to know how much of the total this stage is actually responsible for before
deciding the fix is worth the risk of touching a reindex-path data-loading function.

STEP 2 — IMPLEMENT, ONLY IF STEP 1 JUSTIFIES IT
If the measurement shows this loop is a meaningful fraction of reindex time at realistic scale,
batch the query — replace the per-unit `await unitStore.getUnit(unit.id)` calls with a single
batched fetch (check what `unitStore` already exposes for bulk reads before adding a new method;
if nothing suitable exists, add the minimal one that serves this call site). If the measurement
shows this loop is NOT a meaningful cost at realistic scale (e.g., single-digit percent of total
reindex time), say so explicitly and recommend NOT fixing it — a correct "this isn't worth the
risk" conclusion, backed by a real number, is a better outcome than a speculative optimization, and
is exactly the kind of judgment call this remediation plan asks for rather than blind execution of
every listed item.

STEP 3 — VERIFY, IF YOU IMPLEMENTED A FIX
Re-run the same timing on the same corpus. Confirm the program graph produced is IDENTICAL in
content (same node/edge counts, same data) before and after — this is a data-loading change, not a
logic change, and a batched fetch that silently drops or reorders units would be a correctness
regression far worse than the performance problem it was meant to fix. Run any existing
program-graph tests and confirm they still pass.

DEFINITION OF DONE
The before measurement, the decision (fix or don't, with the number that justified it), and — if
fixed — the after measurement and a data-integrity check, all recorded in ROADMAP.md and
`STRICT_AUDIT_2026-08-04.md`'s P2-5 entry. A recorded decision not to fix, backed by real numbers,
counts as this item being DONE — it does not need to end in a code change to be closed correctly.
```

---

## What "production grade and publishable" means when this queue is empty

For your own tracking, not part of any single prompt: CLAUDE.md's Definition of Done applies
per-item, but the AGGREGATE bar for "ready to publish" is everything in the P0/P1 rows above closed
with live evidence (not just green unit tests), CI actually gating merges, the git tree clean and
everything committed, and `STRICT_AUDIT_2026-08-04.md` showing zero open P0s and zero open P1s in
its own status annotations. The P2 items and the Bucket A hygiene sweep matter for maintainability
but are not release blockers on their own — say so explicitly if you reach a point where every P0
and P1 is closed and P2 work remains, rather than treating the list as one undifferentiated backlog.
