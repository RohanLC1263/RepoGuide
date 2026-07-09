# Contributing to RepoGuide

RepoGuide is not yet published to the VS Code Marketplace (see `package.json`'s
`publisher`/`repository` fields, both explicitly flagged TODOs) — for now,
"contributing" means working against this repo directly.

## Development setup

```bash
npm install
npm run compile
# Press F5 in VS Code to launch an Extension Development Host
```

You'll also need [Ollama](https://ollama.com) running locally with the
embedding/inference models pulled — see the Prerequisites table in
`README.md`. RepoGuide is local-first: nothing it does requires network
access beyond talking to your own Ollama instance (and by default, that
instance is `http://localhost:11434` — if you point `repoguide.ollamaUrl` at
a remote endpoint, RepoGuide will warn you once at startup, since that
endpoint receives your indexed repository content).

## Before opening a PR

```bash
npm run compile      # tsc must be clean
npm run lint         # eslint must be clean (0 errors -- warnings alone don't fail this)
npm run test:unit    # what CI actually runs
```

CI (`.github/workflows/ci.yml`) runs exactly these three steps on every push
and pull request against `main`.

**Important nuance if you're used to `npm run test:unit` meaning "the test
suite":** here it doesn't. That script runs a single trivial dummy test via
mocha — it exists to keep CI's headless job simple, not as real coverage.
The actual regression-relevant tests are the ~80 `node:test` files under
`src/test/**/*.test.ts` (compiled to `out/test/**/*.test.js`). Run them with:

```bash
npm run compile
node --test --test-isolation=none $(find out/test -name "*.test.js")
```

This suite has pre-existing, unrelated failures (jest-globals imported
outside a jest environment in a couple of files, some worker/resource
contention) — around 43 out of ~320 tests as of this writing. If your change
doesn't shift that count or the specific failing files, that's the existing
baseline, not a regression from your change; diff the failing-file list
before/after if you want to be sure. The full jest suite (`npx jest`) has a
similar, separately-tracked flaky baseline — see `RELEASE_ENGINEERING_REPORT.md`.

## Definition of Done

Before calling any change complete (this applies whether you're a human
contributor or an AI agent working in this repo — see `CLAUDE.md` for the
full version other agents are held to):

1. **Tests pass** — compile/lint clean, and real test coverage exists for
   what you built, not just a passing build.
2. **It's called from a real entry point.** Trace the import chain back to
   `src/extension.ts` (or `src/mcp/mcpServer.ts` for MCP-facing work). Code
   only a test file imports is orphaned, however well-tested — this repo has
   a documented history of exactly that (`src/intent/`, `src/evolution/`,
   `src/drift/`, others — see `REPOGUIDE_AUDIT.md`).
3. **No orphaned imports left behind** if you replaced something — two
   implementations of one capability is a liability, not a safety net.
4. **No scratch artifacts** committed outside `test/`, `scripts/`, or
   `archive/` — no debug scripts, log dumps, or one-off validation docs at
   repo root.
5. **Docs updated in the same PR** if behavior, an API surface, or an
   architectural decision changed — not deferred to a follow-up.

## Changelog discipline

Every user- or contributor-visible change (new command, behavior change, bug
fix, security fix) gets a `CHANGELOG.md` entry under `[Unreleased]` in the
same PR — not as a follow-up. See `CHANGELOG.md`'s own "Discipline going
forward" section for the exact convention.

## Commit messages

Explain *why*, not just *what* — a one-line summary is fine for small
changes, but the reasoning should be recoverable from `git log` without
needing to ask whoever wrote it.

## Architecture context

Read `ARCHITECTURE_FREEZE.md` and `REPOGUIDE_AUDIT.md` before making
architectural claims about what exists — several past investigations have
found stale assumptions in docs versus the real code; re-verify with grep
rather than trusting a prior report at face value.

Read `LIMITATIONS.md` before assuming something is broken, unsupported, or
untried — it's the maintained, root-caused map of known gaps (grouped by
whether each is an architectural gap, a tunable bug, or a model-capability
ceiling), with a real-world-frequency estimate and current status for each.
If you're about to file an issue or start a fix, check there first: it may
already be diagnosed, deliberately deferred with a stated reason, or fixed
since the doc's last update (cross-check against `git log`, since like any
doc it can drift).
