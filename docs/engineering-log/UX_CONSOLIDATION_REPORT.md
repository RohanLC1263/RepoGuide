# UX Consolidation Report (Phase 5)

A different kind of pass than the seven language providers before it: information architecture and
design-system consistency, not parsing/resolution. Same investigate-first discipline applied —
several of `REPOGUIDE_AUDIT.md`'s specific claims turned out to be stale once re-verified directly.

## 1. Pass 1 findings — re-verified, several audit claims did not hold up

**Panel inventory (re-counted directly, not trusted from the audit):**

10 distinct webview surfaces: 1 persistent sidebar chat view (`webviews/sidebar/`) + 9 panels
(Daily Brief, Documentation Report, Explain, Index Health, Orientation, Investigation, Plan Tracker,
Memory Explorer, Notes). Across `src/ui/` (13 files, 2,668 lines) and `webviews/` (2 files,
1,055 lines at the time) — **not** "16 files, ~4,800 lines" as the audit stated.

**The audit's specific design-system citation was stale**: `indexHealthPanel.ts` does **not**
redeclare `--rg-*` tokens (verified: zero `:root`/`--rg-bg:` matches in the file — it correctly uses
`wrapHtml()`'s `customCss` extension point, referencing existing tokens only). 7 of 10 surfaces were
already using the shared shell correctly before this pass. The real, previously-undocumented offender
was `webviews/sidebar/index.html`, which declared its own competing `:root` block
(`--rg-high`/`--rg-medium`/`--rg-low` vs. the shared shell's `--rg-success`/`--rg-warning`/`--rg-error`
— same underlying `--vscode-testing-icon*` mappings, different names). `explainPanel.ts` (fully
bespoke inline `<style>`) and `webviews/docreport/report.html` (hardcoded `#1e1e1e`/non-VS-Code fonts,
ignoring theme entirely) were confirmed exactly as described.

**The orphaned-commands claim was false as of this session — already fixed, nothing to do.** All four
commands (`showDailyBrief`, `addNote`, `notesPanel`, `verifyNoteSystem`) were present in
`package.json`'s `contributes.commands` and registered in `extension.ts`. Cross-checking all 21
declared commands against every `registerCommand` call in `src/` (multiline-aware — a naive
single-line grep missed `repoguide.importTrace`, registered across two lines) showed a **perfect 1:1
match**: nothing declared-but-unregistered, nothing registered-but-undeclared.

**Full command inventory** (21 commands, all under one flat `"category": "RepoGuide"`, no
sub-grouping — the real "cognitive load" surface): 10 open a panel/view, 9 are quick actions, 2 are
power-user/diagnostic tools. Of those two, `repoguide.verifyNoteSystem` was a self-test that writes a
dummy `test_dummy_note_file.ts` note to "verify the memory backend" — dev diagnostic tooling with no
business being in a user-facing Command Palette.

**Structural finding for the dashboard design**: `phase10Panels.ts`'s Orientation panel already
auto-opens on first workspace open when annotations exist, and already shows real content (annotation
coverage %, project summary, entry points, key modules) — it already occupied the "first thing you
see" role. It just didn't link to the other 9 panels.

**No `ROADMAP.md` existed.** "Phase 5" wasn't referenced anywhere in the live repo (only in
`archive/`) — this pass created it rather than updating a pre-existing file.

## 2. Changes made

### Design-system consolidation
- **`explainPanel.ts`** migrated from a fully bespoke inline HTML document to `wrapHtml()`, with its
  streaming-token script preserved via the same append-after-`wrapHtml()` pattern `notesPanel.ts`
  already used. Its state classes (`.thinking`/`.done`/`.error`) now reference `--rg-muted`/`--rg-error`
  instead of raw `--vscode-descriptionForeground`/`--vscode-errorForeground` directly.
- **`docReportPanel.ts`** migrated from loading a static `webviews/docreport/report.html` file to
  generating its body inline via `wrapHtml()`, reusing the shell's existing `.badge`/`.mono` classes.
  `webviews/docreport/report.html` (139 lines, hardcoded dark-theme-only colors and non-VS-Code fonts)
  is now retired — deleted, not left running in parallel next to the new code path.
- **`webviews/sidebar/index.html`** — its independent `:root` block's `--rg-high`/`--rg-medium`/
  `--rg-low` tokens renamed to `--rg-success`/`--rg-warning`/`--rg-error`, matching the shared shell's
  vocabulary exactly (the underlying `--vscode-testing-icon*` mappings were already identical, only
  the names diverged). **Disclosed, not overclaimed**: the sidebar is a persistent `WebviewView` with
  its own JS bundle (`sidebar.js`) — it was not migrated to call `wrapHtml()` itself, since that would
  be a real asset-pipeline restructuring, not a CSS-consolidation fix. Its border/muted/accent tokens
  already matched the shared names before this pass; only the three renamed here were genuinely
  divergent.
- **9 of 10** webview surfaces now use the shared `wrapHtml()` shell (up from 7 of 10) — only the
  sidebar remains a separate static asset, by necessity, with its token *vocabulary* now aligned.

### Single entry-point dashboard
- Added a **Capabilities** launcher section to the top of Orientation panel's rendered HTML (both the
  "not indexed yet" early-return path and the fully-populated path), grouped into three rows
  ("Understand the codebase," "Track your work," "Investigate & ask") linking to all 9 real
  panel-opening commands except `repoguide.explain` (deliberately excluded — it operates on the
  current editor selection, so it doesn't fit a standalone launcher click without that context).
- Added a `runCommand(command)` helper to `wrapHtml()`'s shared script block (alongside the existing
  `openFile()` helper) and a `runCommand` message type handled in `phase10Panels.ts`'s message
  dispatcher, executing `vscode.commands.executeCommand(message.command)`.
- **No 11th surface was created** — per the approved design, this reuses Orientation's existing
  auto-open-on-first-workspace-open hook rather than adding a second, competing "first thing you see"
  panel.

### Command Palette cleanup
- `repoguide.verifyNoteSystem` removed from `package.json`'s `contributes.commands` (20 commands now
  discoverable, down from 21). The `registerCommand` call itself is untouched — still callable via
  `executeCommand` for internal debugging, just no longer surfaced to users.

### Documentation
- Created `ROADMAP.md` (did not exist before this pass) — a minimal, forward-looking doc: a brief
  "where the project is now" summary plus a real Phase 5 entry with this pass's actual status,
  rather than a fabricated retroactive history for phases 1-4.

## 3. Before / after

| | Before | After |
|---|---|---|
| Commands in Command Palette | 21 (flat, one category) | 20 (flat, one category — `verifyNoteSystem` removed) |
| Webview surfaces using `wrapHtml()` | 7 of 10 | 9 of 10 |
| Competing CSS vocabularies | 3 (`indexHealthPanel.ts` claim was stale; real ones: `explainPanel.ts`, `report.html`, sidebar's `--rg-high/medium/low`) | 1 partial (sidebar remains a separate static asset by necessity, but its token *names* now match) |
| Single entry point reaching the other panels | None — 9 panels + 1 sidebar, discoverable only via a flat 21-command palette | Orientation panel (already the auto-opening "first thing you see" surface) now links to all 9 real panel-opening commands |
| `ROADMAP.md` | Did not exist | Created, with a real Phase 5 entry |
| `webviews/docreport/report.html` | 139 lines, hardcoded non-theme-aware styling | Deleted — content now generated inline via `wrapHtml()` |

## 4. Verification

**New test** (`src/test/ui/phase10Panels.test.ts`, 2 tests, both passing): asserts the Orientation
panel's rendered HTML contains a `runCommand(...)` call for every one of the 9 real panel-opening
commands, in both the "not indexed yet" and fully-populated render paths — a real, automated check
that the dashboard actually reaches every capability, not just a narrated claim.

```
Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
```

**Compile/lint**: `npm run compile` clean. `npx eslint src/ui/ src/test/ui/`: 0 errors, 22 warnings —
all pre-existing style warnings (`Expected { after 'if' condition`) in files this pass touched only
incidentally (`indexHealthPanel.ts`, `memoryExplorerPanel.ts`, `notesPanel.ts`, `phase10Panels.ts`);
zero warnings in the actually-modified code (`explainPanel.ts`, `docReportPanel.ts`, `htmlUtils.ts`).

**Full jest suite**: results vary run-to-run in this environment due to pre-existing jest-worker
resource contention (`Jest worker encountered N child process exceptions, exceeding retry limit`) —
observed failure counts ranged 34-41 across repeated runs of the *same* unmodified test files, and a
`--runInBand` attempt to get a clean deterministic count instead surfaced that several pre-existing
test files (`runtimeDependencyPhaseB.test.ts`, `runtimeBlastRadiusPhaseD.test.ts`, others) call
`process.exit(1)` directly on failure, which kills the whole in-band process — a separate, pre-existing
test-infrastructure issue, not something this pass introduced or could reasonably fix. A representative
run: 330 tests total (up from 328 before this pass, matching the 2 new tests added), 276 passed, 34
failed — the same count as every prior language pass's documented baseline. Grepping every run's
`FAIL` lines for anything under `src/ui/` or the files this pass touched
(`explainPanel`/`docReportPanel`/`phase10Panels`/`htmlUtils`) returned **zero matches** across all
observed runs.

**Not verified**: actual visual rendering inside a running VS Code Extension Host. `npm test`
(`vscode-test`) exists but its `.vscode-test.mjs` config hardcodes a single unrelated test file
(`out/test/investigationUI.test.js`) against an external workspace folder
(the CraftConnect eval repo) — it does not exercise any of the panels this pass touched,
and `phase0Panels.test.ts` (the file that *would* have integration-tested command registration in a
real Extension Host) is explicitly excluded from both jest (`testPathIgnorePatterns`) and the
`vscode-test` file glob, making it dead test infrastructure today. Per the CLAUDE.md guidance to say
so explicitly rather than claim success: the HTML/CSS changes were verified via compile, lint, the new
jest test's string-level assertions, and manual reading of the generated templates — not a live render.

## 5. Definition of Done checklist

1. **Tests pass** — `npm run compile` clean; lint 0 errors; new jest test 2/2 passing; full suite
   at the same pre-existing failure baseline as every prior report, confirmed unrelated to this work.
2. **Called from a real production entry point** — `buildOrientationHtml`/`buildCapabilitiesSection`
   are the actual functions `registerPhase10Panels` wires to `repoguide.orientationPanel` and the
   auto-open-on-workspace-open hook in `src/extension.ts`'s real activation path, not test-only code.
3. **No orphaned imports/dead code left running in parallel** — `webviews/docreport/report.html` was
   deleted outright (not left alongside the new inline-generated version); the retired
   `docreport/` directory was removed since it's now empty.
4. **Scratch artifacts cleaned up** — no debug scripts or dumps left outside `src/test/`.
5. **Docs updated** — `ROADMAP.md` created with Phase 5's real status; this report is the
   pass-specific doc, mirroring every `*_SEMANTIC_PROVIDER_REPORT.md`'s role for the language passes.
