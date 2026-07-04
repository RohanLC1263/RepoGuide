# Contributing to RepoGuide

## Development setup

```bash
npm install
npm run compile
# Press F5 in VS Code to launch an Extension Development Host
```

## Before opening a PR

```bash
npm run compile      # tsc must be clean
npm run lint         # eslint must be clean (0 errors)
npm run test:unit    # headless unit tests
```

CI (`.github/workflows/ci.yml`) runs the same three checks on every push and
pull request against `main`.

The full jest suite (`npx jest`) covers most of the codebase but currently has
pre-existing, unrelated flaky failures from worker-process resource
contention -- see `RELEASE_ENGINEERING_REPORT.md` for the documented baseline.
If your change adds new jest failures beyond that baseline, that's a real
regression; if it doesn't change the failure count or set, it's the existing
flakiness, not your change.

## Changelog discipline

Every user- or contributor-visible change (new command, behavior change, bug
fix, security fix) gets a `CHANGELOG.md` entry under `[Unreleased]` in the
same PR — not as a follow-up. See `CHANGELOG.md`'s own "Discipline going
forward" section for the exact convention.

## Commit messages

Explain *why*, not just *what* — a one-line summary is fine for small changes,
but the reasoning should be recoverable from `git log` without needing to ask
whoever wrote it.

## Architecture context

Read `ARCHITECTURE_FREEZE.md` and `REPOGUIDE_AUDIT.md` before making
architectural claims about what exists — several past investigations have
found stale assumptions in docs versus the real code; re-verify with grep
rather than trusting a prior report at face value.
