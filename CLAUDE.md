# CLAUDE.md

Guidance for Claude Code (and any other agent) working in this repository.

## Project

RepoGuide is a privacy-first, local-first VS Code extension for codebase understanding (see `README.md`, `VISION.md`). Architecture contracts are frozen in `ARCHITECTURE_FREEZE.md`. Current alignment against both is tracked in `docs/engineering-log/REPOGUIDE_AUDIT.md` and `docs/engineering-log/ARCHITECTURE_CONFORMANCE_REPORT.md` — read those before making architectural claims about what exists.

## Definition of Done

A task is not complete just because code was written and it compiles. Before marking any task done, confirm all of the following:

1. **Tests pass.** `npm run compile && npm run lint` succeeds, and the relevant test suite (`npm run test:unit`, or the specific `test:*` script for the area touched) passes. A feature with no test coverage is not done — add coverage as part of the task, not as follow-up.
2. **The code is called from a real production entry point.** Not just from its own unit test. Trace the import chain back to `src/extension.ts` (or `src/mcp/mcpServer.ts` for MCP-facing work) and confirm it. Code that only test files import is not shipped — it's orphaned, regardless of how well-tested it is. (This repo has a documented history of building whole subsystems — `src/intent/`, `src/evolution/`, `src/drift/`, the `src/causal/` chain — that were fully implemented and tested but never wired into anything that runs. Don't add to that pile.)
3. **No orphaned imports remain.** If the task replaced or superseded something, the old code path is removed, not left running in parallel "just in case." Two implementations of the same capability (see: the legacy vs. evidence query pipeline split documented in `docs/engineering-log/ARCHITECTURE_CONFORMANCE_REPORT.md` #1) is a liability, not a safety net — it means fixes silently don't propagate to one of the paths.
4. **Scratch artifacts are cleaned up.** No debug scripts, log dumps, JSON dumps, or one-off validation docs left at repo root or anywhere outside `test/`, `scripts/`, or an explicit `archive/`. If you generated a report while investigating, either fold its conclusion into a real doc or delete it — don't leave it sitting as a file for someone to mistake for documentation later. (Root previously accumulated 500+ such files before the 2026-07-02 baseline cleanup — see that commit and `/archive`.)
5. **Relevant docs are updated.** If behavior, an API surface, or an architectural decision changed, the doc that claims to describe it (`README.md`, `ARCHITECTURE_FREEZE.md`, `VISION.md`-adjacent audits, or inline comments where the WHY isn't obvious) is updated in the same change, not deferred.

Reference this checklist explicitly before marking any future task complete. If a task can't satisfy all five, say so plainly and state which ones are outstanding — don't report it as done anyway.
