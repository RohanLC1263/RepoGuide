# Work split: Claude Desktop vs Claude Code — remaining STRICT_AUDIT_2026-08-04 items

P0-1 is closed. This divides everything still open by **which environment can produce the
evidence**, not by difficulty. Every item here is implementable by Claude Desktop; the question in
each case is whether Desktop can *prove it works*.

## The dividing line, measured not assumed

Four hard blockers in the Claude Desktop sandbox, each verified on 2026-08-05:

| Blocker | Probe | Result |
|---|---|---|
| No local model | `command -v ollama`, `curl localhost:11434` | absent, unreachable |
| No Extension Host | `ls node_modules/vscode` | absent — `vscode` is injected at runtime by VS Code, only `@types/vscode` is installed |
| No native index binding **on Linux** | `ls node_modules/@lancedb/` | only `vectordb-win32-x64-msvc` present |
| No git writes | `touch .git/_probe` | `Operation not permitted` (mount is read-only to bash; file tools write source fine) |

**The third row matters more than it looks, and it cuts in RepoGuide's favour.** The 11 suites that
fail in my sandbox are not broken and are not missing a dependency — `node_modules` is the user's
Windows install shared through the mount, so it carries the *win32* LanceDB binding and my Linux
sandbox asks for `vectordb-linux-x64-gnu`. Consequence:

- **Claude Code, on the user's Windows machine, can run all 11 today.** They are not blocked work.
- **GitHub Actions on `ubuntu-latest` will also run them**, because `npm ci` there installs the
  Linux binding.

So the CI exclusion list must **not** be authored from my sandbox's failure profile — it would
wrongly exclude 11 suites that CI can run, including four `queryDispatcher*` suites and
`subAnswerMerger`, which are exactly the gate-adjacent coverage the audit says is missing. This is
called out again under P0-4 because it is the single easiest way to get that fix wrong.

The 11:

```
indexing/indexManagerReadinessState      query/gateStatus
indexing/reindexAtomicity                query/hybridRetrievalFusion.bm25Keyword
preparation/repositoryLivenessGate       query/queryDispatcherEvidenceExport
query/branchBypassChatPathIntegration    query/queryDispatcherFileReferencesUnaffected
query/confidenceFromGate                 query/queryDispatcherRawEvidenceCap
                                         query/subAnswerMerger
```

---

## Bucket A — Claude Desktop, end to end

Deterministic, pure-logic, provable in the sandbox. No live model, no VS Code, no index rebuild.
Same loop as P0-1: reproduce → root-cause → fix → test that fails first → re-run the original repro.

| Item | Why it lands here |
|---|---|
| **P1-1** path traversal at `readFileFresh` | Pure path arithmetic. The audit's repro (`../../../../etc/secrets/config.py`) is deterministic and I already execute this module directly. |
| **P1-5** doc report skips the gate contract | Routing change through the existing `emitFinalAnswer`/`renderWithheldAnswer` tail, pinned by extending `canonicalAnswerTail.test.ts`. Same shape as defect #11, already done this way once. |
| **P1-6** `evidencePacketBuilder.test.ts` 0/5 (4 of 5) | The four `TypeError`s are a stale hand-rolled mock missing `findByType`/`findBySymbols`. Platform-independent. |
| **P2-1** `THIN_GROUNDING_MIN_SOURCES` not shared | One import. |
| **P2-2** doc comment cites a non-existent test file | One line. |
| **P2-3** "cheap indexed lookup" comment is wrong | Comment correction only — the audit's finding is the false claim, not the scan. |
| **Claim #2** stale "68 real importers" in shipped source | Two comments in `importResolver.ts` / `programGraphBuilder.ts`. ROADMAP already records the correct figure; the source never got the correction. |
| **P2-7** CLAUDE.md orphan list stale both directions | Reachability analysis is static grep/AST work I can do. *Deciding what to delete is a user call, not mine.* |

---

## Bucket B — Desktop implements, Claude Code must verify

The fix is mine; the *proof* is not. For each, the specific evidence Claude Code has to produce is
named — without it the item is implemented, not done.

### P0-2 — empty-index guard doesn't reach `logicalUnitBm25Store`
- **Desktop:** generation-swap on `logicalUnitBm25Store`, `expectedNonEmpty` at `indexManager.ts`
  and `extension.ts:628`, unit tests extending `emptyIndexGuard.test.ts` (SegmentedMiniSearchIndex
  is pure JS — runs here).
- **Claude Code must produce:** a real full reindex of CraftConnect where logical-unit extraction
  yields zero units while chunking succeeds, showing the reindex now **fails loudly** instead of
  reporting success. This is the whole point of the fix and it cannot be faked with a unit test —
  the failure mode is an interaction between two pipeline stages. Also re-run
  `indexing/reindexAtomicity` and `indexing/indexManagerReadinessState` (win32 binding present).

### P0-3 — `ollamaUrl` privacy invariant
- **Desktop:** `"scope": "machine"` in `package.json`, loopback validation at the single read point
  in `vscodeContext.ts`, explicit `capabilities.untrustedWorkspaces`, unit tests for the validator.
- **Claude Code must produce:** proof that a workspace `.vscode/settings.json` setting
  `repoguide.ollamaUrl` to a remote host **no longer changes the URL the extension uses**. This is
  enforced by VS Code's settings resolver, not by our code — I cannot test it at all, only write it.
  Highest-leverage single verification in this whole list: it is the product's headline promise, and
  it is currently a default rather than an invariant.

### P1-2 — `presentTechnologies` cached for the extension's lifetime
- **Desktop:** invalidation hook on reindex completion + a unit test that the hook clears the cache.
- **Claude Code must produce:** the audit's scenario end to end — add a real dependency to a repo,
  reindex **without restarting VS Code**, ask about it, confirm the correct answer is no longer
  hard-blocked. The bug is precisely that the process survives the reindex, so only a live session
  shows it.

### P1-3 / P1-4 — Stop is a no-op; `explainSelection` drops its signal
- **Desktop:** thread the `AbortSignal` through `generateForPlan` →
  `EvidenceAnswerSynthesizer.synthesize` (which currently hard-codes `undefined` into a
  `streamSynthesize` that already accepts and forwards it correctly), fix the single-slot
  `activeAbortController`, register `panel.onDidDispose`.
- **Claude Code must produce:** press Stop mid-generation and confirm the **Ollama generation
  actually terminates** and the model does not stay resident, plus a `cancelled` message posted.
  The most model-dependent item here — I have no way to start a stream, let alone abort one.
  Also: submit a second question while one is in flight and confirm the first is still cancellable.

### P2-4 — no Content-Security-Policy on webview HTML
- **Desktop:** add the CSP `<meta>` in `wrapHtml`.
- **Claude Code must produce:** confirmation that **all three panels still render** — sidebar,
  explain, doc report. CSP silently breaks webviews (inline scripts/styles, resource URIs) and the
  failure is invisible until a panel is opened. Do not ship this one on a green compile.

### P2-5 — `ProgramGraphBuilder.build` per-unit round trip
- **Desktop:** batch the query.
- **Claude Code must produce:** before/after reindex timing on a large corpus. A perf fix with no
  measurement is a guess; deferred in the remediation plan for exactly this reason.

---

## Bucket C — Claude Code (or Rohan) owns outright

| Item | Why Desktop can't own it |
|---|---|
| **P0-4** CI: push, watch a real run, confirm a deliberately-broken assertion fails the workflow | Requires git push + GitHub Actions. I can write `ci.yml` and the npm script; I cannot run the pipeline. |
| **P0-4** authoring the *exclusion list* | Must be derived on a Linux runner with `npm ci`, **not** from my sandbox — see the binding trap above. Safer: Claude Code runs the full `node --test` sweep on Windows first (11 LanceDB suites included) to get a true green baseline. |
| **P1-6** the 5th test (`'src/gadget.ts'` vs `'C:/workspace/src/gadget.ts'`) | Suspected Windows-fixture-on-Linux artifact. Needs adjudicating **on Windows**, which is the user's real platform. I'd be guessing. |
| **P2-6** git hygiene: `.gitignore` `tmp/`, remove `out/test/mock_workspace_*`, commit the untracked 2026-08-04 + 2026-08-05 work | `.git` is not writable from my sandbox. **This is the most urgent non-P0 item on the list** — six modules and eight test files, including every regression test written across both days, exist only in the working tree. One `git checkout` and two days of work is gone. |
| **P2-8** should the adversarial suite run automatically? | Product decision, and running it needs a live model. |
| **P2-7** deleting ~121 orphaned production modules | Product decision. I can measure and document; I should not delete subsystems unasked. |

---

## Suggested order given the split

1. **P2-6 commit the work** (Claude Code, minutes). Everything else is at risk until this is done.
2. **P1-1** (Desktop, self-contained) — closes the last reproduced-by-execution finding.
3. **P0-3** (Desktop implements → Claude Code verifies) — biggest trust delta per line changed.
4. **P0-4 CI** (both) — after which everything below is self-verifying.
5. **P0-2** (Desktop implements → Claude Code reindexes CraftConnect).
6. **P1-2 / P1-3 / P1-4 / P1-5**, then the P2 sweep.

P0-4 sits at 4 rather than 2 only because the CI exclusion list is safest to author *after* Claude
Code has produced a true full-sweep baseline on a machine with the right native binding.
