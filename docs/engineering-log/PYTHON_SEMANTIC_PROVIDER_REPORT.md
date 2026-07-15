# Python Semantic Provider + httpx Eval Corpus

Closes the Phase 4 scope gap documented in `REPOGUIDE_AUDIT.md` §6 ("the deeper
semantic/fact extraction layer... has exactly one provider: `typescript/`")
and the benchmark-diversity gap ("real-world eval corpora are JS/TS-only").
This is genuinely new code — a repo-wide search before starting confirmed no
Python semantic-extraction code existed anywhere, built-but-unwired or
otherwise.

## What was built

- `src/indexing/semantic/providers/python/` — a full second `SemanticProvider`
  implementation (`PythonSemanticProvider`), structured to mirror
  `providers/typescript/` file-for-file wherever a TypeScript counterpart
  applies: `pythonSemanticProvider.ts`, `internalModels.ts`,
  `declarationVisitor.ts`, `relationshipVisitor.ts`, `semanticAstWalker.ts`,
  `repositoryEntityAssembler.ts`, `astHelpers.ts`, `mappers/*`, `resolution/*`
  (`moduleResolver.ts` and `nameResolver.ts` have no TS counterpart — Python
  needed a real dotted-module-path resolver and a scope-based name lookup in
  place of `ts.TypeChecker`).
- `src/indexing/semantic/providers/shared/` — thin re-export shims
  (`internalModels.ts`, `canonicalIdentityFactory.ts`,
  `observationAccumulator.ts`, `repositoryRelationshipAssembler.ts`) so the
  Python provider imports the already-language-neutral TS assembler code from
  a language-neutral-looking path, without physically relocating files out of
  `typescript/` (avoids touching import paths 3 existing TS tests depend on).
- `entityKind` widened to include `'module'` — needed because IMPORTS and
  top-level DECLARES have no other valid source entity. Not anticipated in
  the plan; confirmed as genuinely required once implementation exposed the
  gap, and confirmed trivial blast radius (all consumers already treat
  `entityKind` as a generic string) before adding it.
- `ObservationAccumulator` gained an optional `evidenceType` constructor
  param (default `'compiler'`, so the existing TS call site is unaffected).
  The Python provider uses two accumulator instances per file — one seeded
  `'ast'` for DECLARES/IMPORTS/EXTENDS, one seeded `'heuristic'` for
  CALLS/INSTANTIATES — so evidence provenance is never mislabeled as
  compiler-verified.
- Wired into production: `PythonSemanticProvider` is registered in
  `indexManager.ts` next to `TypeScriptSemanticProvider`. Also fixed
  `ExtractionCoordinator.extractFile` to actually forward `workspaceRoot`
  into `dispatcher.extract(...)` as `projectContextToken` — previously it was
  computed but silently dropped, which never mattered for TS (single-file,
  no cross-file resolution) but Python's module-path/import resolution
  genuinely needs it.
- `eval_repos/httpx` — a real, moderate-scale Python HTTP client (~5,300
  lines across its core module), shallow-cloned as a held-out corpus.
- `src/test/evaluation/eval_questions_httpx.json` — 19 hand-written golden
  questions (3 orientation / 5 location / 4 flow / 3 explanation / 3
  uncertainty / 1 staleness, matching the documented axios/yarn minimums),
  written from reading httpx's actual source (`_client.py`, `_api.py`,
  `_auth.py`, `_exceptions.py`, `_models.py`, `_transports/`) — not generated
  by running the new provider and back-filling questions that happened to
  score well.
- `src/test/indexing/semantic/providers/python/pythonSemanticProvider.test.ts`
  — 8 tests against real files on disk (a temp package with `__init__.py`,
  a base module, and a subclass/import/call scenario), covering `canHandle`,
  dispatcher registration, structural entity extraction with correct AST
  nesting and docstrings, real relative-IMPORTS resolution to a file on disk,
  the cross-file EXTENDS case correctly becoming a `KnownUnknown` instead of
  a guess, same-class CALLS, same-file INSTANTIATES, and `async def` handling.

## Honest capability tier (Python vs. TypeScript)

Python has no embeddable equivalent of `ts.TypeChecker`, so this is a real,
disclosed ceiling — not an oversight:

| Relationship | TypeScript (today) | Python (this provider) |
|---|---|---|
| DECLARES | Full confidence | Full confidence |
| IMPORTS | Resolves to a file | Resolves to a file (via a dotted-module-path resolver handling both absolute and relative imports); does **not** resolve the imported *name* to a symbol inside the target file — the plan proposed this as "one hop, worth doing," but it was cut during implementation because it requires parsing a second file mid-resolution, and wasn't worth the added complexity given everything else in scope. Disclosed scope reduction, not a silent gap. |
| EXTENDS | Same-file only (TS's own `ts.Program` is single-file) | Same-file/same-module only — same tier as TS today, not a downgrade. Cross-file base classes correctly become `KnownUnknown`s (verified directly: httpx's `Dog(Animal)`-style cross-file cases in `_exceptions.py`/`_transports/` produced 10 such `KnownUnknown`s across 7 real files, zero silent guesses). |
| CALLS / INSTANTIATES | Same-file, type-checker-resolved | Same-file, name-lookup heuristic reusing the existing uppercase-callee convention from `symbolExtractor.ts`/`factExtractor.ts`. Only unresolved *uppercase* (instantiation-shaped) calls become `KnownUnknown`s — unresolved lowercase calls (likely builtins/external functions) are silently skipped to avoid noise. |
| REFERENCES | Implemented (same-file) | **Not implemented at all in v1.** Python's dynamic attribute access (`getattr`, `**kwargs` dispatch, monkeypatching) would make a heuristic version markedly worse than TS's; an empty relationship set here is a stated limitation, not a bug. |
| Signature hash | Type-resolved | Syntactic only (param name : raw type-hint text : has-default : kind, decorators, binding). Disclosed: `List[int]` vs `list[int]` vs a same-meaning alias hash differently — no type checker to normalize them. |

Both providers currently run under the framework's global `ExtractionMode.ShadowMode` — results are computed but not authoritative for any language yet (`SemanticOnly` mode still throws). Registering Python was purely additive; it does not change what the query pipeline returns today.

## Real-corpus verification (not synthetic)

Ran `PythonSemanticProvider` directly against 7 real httpx files and all 5
`test/fixtures/python-fastapi` files (12 files total, all `status: SUCCESS`,
0 diagnostics):

| Corpus | Entities | Relationships | KnownUnknowns |
|---|---|---|---|
| httpx (7 core files, ~5,300 lines) | 334 (221 methods, 53 classes, 21 functions, 32 variables, 7 modules) | 477 (296 DECLARES, 101 CALLS, 37 IMPORTS, 30 EXTENDS, 13 INSTANTIATES) | 164 (107 unresolved instantiations, 47 unresolved imports, 10 cross-file base classes) |
| python-fastapi fixture (5 files, 122 lines) | 37 | 25 | 25 |

The httpx `_exceptions.py` run is a good concrete illustration of the tier:
its 28-class, single-file, multi-level exception hierarchy
(`HTTPError → RequestError → TransportError → TimeoutException → ...`)
produced 24 real EXTENDS edges with 0 diagnostics, while the file's one
cross-file base-class reference correctly surfaced as a `KnownUnknown`
instead of being silently dropped or guessed.

### Bug found and fixed during verification

The first verification pass against `httpx/_client.py` (2,020 lines) and
`_models.py` (1,278 lines) — the two largest, most important files in the
corpus — came back `status: FAILED` with `Provider catastrophically failed:
Invalid argument`. Root-caused via direct binary search on input length: the
underlying `node-tree-sitter` package's string-input parse path defaults to
a 32KB internal read buffer and throws past that exact boundary (confirmed:
failure begins at byte 32,768). This is a real, pre-existing limitation of
`parser.parse(content)` shared by every other call site in the codebase
(`staticAnalyzer.ts`, `astChunker.ts`, `symbolExtractor.ts`,
`logicalUnitExtractor.ts` all call it the same way, and `astChunker.ts`
already documents "parser.parse() throws" as an expected fallback trigger)
— not something introduced by this task, but real code in a repository
of httpx's scale would hit it constantly. Fixed *for this new provider* by
passing an explicit `bufferSize` option sized to the content length.
**Update:** the other four pre-existing call sites were investigated and
fixed in a follow-up pass — see `TREESITTER_BUFFER_BUG_REPORT.md`.
`staticAnalyzer.ts` turned out to be a live, silently-broken bug (empty
`FileStructure` for any TypeScript/JavaScript file over 32KB, miscounted as
a successful analysis), not just a theoretical risk. All 5 call sites
(including this provider) now share one `parseSourceSafely()` helper in
`src/indexing/treeSitterParse.ts`.

## Held-out discipline

Per the explicit instruction to avoid repeating `LANGUAGE_HACK_CLEANUP_REPORT.md`'s
history (hardcoded `eval_repos/yarn/` path checks, axios-shaped synthetic
edges): the 19 httpx golden questions were written from reading httpx's
source directly, before the final verification run in this report, and were
not adjusted afterward based on what the provider actually extracted. The
provider's heuristics (uppercase-callee convention, same-file resolution
scope) were fixed before httpx was read for question-writing. This corpus
should be treated as a genuine held-out check going forward — not iterated
against the way axios/yarn were.

## Verification against CLAUDE.md's Definition of Done

1. **Tests pass.** `npx tsc --noEmit` clean. `npm run lint`: 0 errors (937
   pre-existing style warnings repo-wide, 9 attributable to new/touched
   files, all `curly`-brace style matching pre-existing convention). Full
   `npx jest`: 222/276 passing (was 214/268 before this change) — the same
   35 pre-existing failing suites, plus 1 new suite (8 tests) that all pass.
   No regressions.
2. **Called from a real production entry point.** `PythonSemanticProvider`
   is registered in `indexManager.ts`'s real constructor path, reachable the
   same way `TypeScriptSemanticProvider` is — not just from its own test.
3. **No orphaned imports.** Nothing superseded; this is additive.
4. **Scratch artifacts cleaned up.** The direct-verification script used to
   produce the real-corpus counts above ran from the session scratchpad
   (outside the repo) and was deleted after use; nothing left at repo root.
5. **Docs updated.** `REPOGUIDE_AUDIT.md` §6 updated in place (struck through
   the now-stale "exactly one provider"/"JS/TS-only corpora" claims with
   inline corrections pointing here) rather than left to silently rot.

## Known limitations carried forward (not fixed here, disclosed for the next pass)

- IMPORTS resolves to a file, not to the specific imported symbol inside it
  (scope reduction from the plan, see table above).
- ~~`node-tree-sitter`'s 32KB string-input buffer limit still affects 4 other
  call sites in the codebase.~~ Fixed — see `TREESITTER_BUFFER_BUG_REPORT.md`.
- REFERENCES is unimplemented for Python by design.
- Only one third-party Python repo (httpx) and one small fixture
  (python-fastapi) back this — a second real corpus would strengthen
  confidence that the design generalizes beyond an HTTP-client-shaped
  codebase.
