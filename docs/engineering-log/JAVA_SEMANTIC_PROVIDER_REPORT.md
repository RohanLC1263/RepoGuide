# Java Semantic Provider + Apache HttpClient Eval Corpus

The third `SemanticProvider` implementation, and the first real test of
whether the interface generalizes to a second implementation beyond
Python's proof-of-concept. Closes the remaining part of `REPOGUIDE_AUDIT.md`
§6's "extend semantic/fact extraction beyond the single TypeScript provider"
recommendation. Genuinely new code — a repo-wide search before designing
confirmed nothing Java-related exists anywhere in `src/`, built-but-unwired
or otherwise (only one unrelated false-positive match, a JS test fixture
whose name happens to contain the substring "java").

## What was built

- `src/indexing/semantic/providers/java/` — `JavaSemanticProvider`,
  structured to mirror `providers/python/` (the more relevant precedent now
  than TypeScript) wherever a counterpart applies: `internalModels.ts`,
  `astHelpers.ts`, `declarationVisitor.ts`, `relationshipVisitor.ts`,
  `semanticAstWalker.ts`, `repositoryEntityAssembler.ts`, `mappers/*`,
  `resolution/{signatureHasher,identityDescriptorBuilder,nameResolver,relationshipResolver}.ts`,
  plus `resolution/sourceRootResolver.ts` (Java's counterpart to Python's
  `moduleResolver.ts` — see below for why it's simpler, not just different).
  Reuses `providers/shared/*` as-is. **No `entityKind` schema change was
  needed this time** — Python's earlier addition of `'module'` was already
  sufficient, a real signal the abstraction is generalizing rather than
  accreting one-off changes per language.
- Wired into production: `dispatcher.registerProvider(new JavaSemanticProvider())`
  in `indexManager.ts`, alongside the TS and Python providers.
- `eval_repos/httpclient` — Apache HttpClient (httpcomponents-client), a
  real, moderate-to-large, definitively pure-Java (no Kotlin-migration risk,
  unlike OkHttp) HTTP client library. 424 Java files under its core
  `org.apache.hc.client5.http` package.
- `src/test/evaluation/eval_questions_httpclient.json` — 19 hand-written
  golden questions (3/5/4/3/3/1, same schema/minimums as axios/httpx),
  written from reading `HttpClient`, `CloseableHttpClient`, `HttpRoute`,
  `RouteTracker`, `AuthScope`, and `HttpRequestRetryStrategy` directly —
  before the final verification run in this report, per the held-out
  discipline now established across all three corpora.
- `src/test/indexing/semantic/providers/java/javaSemanticProvider.test.ts`
  — 10 tests against real files on disk: structural entities with correct
  javadoc extraction, real cross-directory `import` resolution to a file on
  disk, cross-file EXTENDS/IMPLEMENTS correctly becoming `KnownUnknown`s,
  same-class CALLS, unambiguous same-file INSTANTIATES, overload identity
  distinctness, anonymous/local-class pruning, and `this(...)` constructor
  delegation's honest (non-)resolution — see below.

## What transferred from Python vs. what's genuinely different (confirmed via direct tree-sitter-java AST dumps, not assumed)

- **Adapter shape, KnownUnknown-over-guessing discipline, syntactic-only
  signature hashing**: transferred directly, third time confirmed.
- **Package resolution is a genuine simplification over Python, not a
  parallel design.** Python's `moduleResolver.ts` must *infer* a namespace
  by walking for `__init__.py` markers, with an `isAuthoritative` flag since
  it can guess wrong (namespace packages, flat scripts). Java's `package`
  declaration is explicit and authoritative — `JavaSourceRootResolver` just
  reads the file's own declared package and walks `path.dirname()` once per
  segment to find the source root. No confidence flag needed at all.
- **No synthetic top-level-function problem, but the synthetic module entity
  is still needed.** Java has no module-level functions/variables outside a
  class, so DECLARES never needed a fallback source the way Python's
  top-level `def`s did. The `'module'` entity is still required as IMPORTS'
  source (imports are file-scoped, not class-scoped) — reusing the exact
  schema addition Python made, unmodified.
- **INSTANTIATES is unambiguous, a real tier improvement over Python.**
  Python detects instantiation via an uppercase-first-letter heuristic
  (`Foo()` vs `foo()`). Java's `new Foo(...)` is `object_creation_expression`
  with an explicit `type` field — no heuristic needed. This is reflected
  honestly in evidence typing: Java's INSTANTIATES uses `'ast'` evidence
  (structurally certain), while CALLS still uses `'heuristic'` (bounded
  resolution scope) — verified directly against real httpclient files (see
  counts below), not asserted.
- **REFERENCES exclusion needed independent justification, not a copy-paste
  rationale.** Python's reasoning was dynamic attribute access (`getattr`,
  monkeypatching). Java has neither, but has interface/virtual-dispatch
  polymorphism and reflection/dynamic proxies (confirmed as a real concern,
  not hypothetical — `Retrofit.java`'s own `create()` uses
  `Proxy.newProxyInstance`, one of the alternatives considered for the eval
  corpus). Different mechanism, same conclusion: excluded.
- **A genuinely new discovery, not present in Python: anonymous class
  bodies.** `new Runnable() { public void run() {...} }` parses its body as
  a plain `class_body` — structurally identical to a real named class's
  body, distinguishable only by its parent being `object_creation_expression`
  rather than `class_declaration`. Detected and pruned entirely (no stable
  name/identity to assign) — verified directly via AST dump before writing
  any extraction code, and covered by a dedicated test.
- **Local classes get the same treatment as Python's local variables, via
  the same general rule.** A class declared inside a method body
  (`void foo() { class Helper {...} }`) has no stable identity outside that
  method's execution. Rather than a special case, this falls out of the same
  "is this node inside a method/constructor body?" pruning check already
  used for locals — extended to also catch `class_declaration` nodes, not a
  parallel mechanism.
- **Method overloading needed verification, not just a claim.** Two
  overloads share a `qualifiedName` (`Dog.process`) but each has its own
  `formal_parameters`, hashed independently — `signatureHash` differs,
  keeping `CanonicalSymbolIdentity` distinct. A dedicated test
  (`gives overloaded methods distinct CanonicalSymbolIdentity values`)
  proves this rather than leaving it asserted.
- **Static vs. instance nested classes: in scope, distinguished only by a
  modifier flag.** Both have a stable `class_body` parent and a real
  `qualifiedName` (`Foo.Inner`) — no reason to exclude either; Java's
  static/instance distinction is a runtime-binding detail irrelevant to pure
  structural extraction.

## A real, disclosed limitation found and partially fixed during implementation: overload collision in name resolution

Writing a golden-fixture test for `this(...)` constructor delegation (a
common real Java pattern — `RouteTracker(HttpRoute route) { this(route.getTargetHost(), ...); }`
appears in the real corpus) surfaced a genuine bug, not a hypothetical edge
case: the original `JavaNameResolver.methodsByClass` indexed one node per
method/constructor *name*, so two overloaded methods (or, unavoidably,
*any* class with 2+ constructors, which all share the class's name) would
silently collide — the last-declared one would win, and a call resolving to
"the constructor" could report the *wrong* overload as a CALLS target
without any indication it might be wrong.

**Fixed**: `methodsByClass` now indexes a *list* per name, and
`resolveMethodOnEnclosingClass` only returns a match when exactly one
candidate exists — an ambiguous name (2+ same-named declarations) resolves
to `null`, the same "don't guess" treatment as any other unresolved call.
This is a real, broadly-applicable improvement (it also protects regular
overloaded method calls, not just constructor delegation), verified via a
dedicated test before it was folded into the implementation, not added
speculatively.

**One consequence of this fix disclosed honestly, not hidden**:
`this(...)` constructor delegation is *structurally* recognized (a real
`explicit_constructor_invocation` case in the relationship resolver) but
will **almost never produce a positive CALLS edge in real code**, because
`this(...)` only appears in classes with 2+ constructors by construction (a
single-constructor class calling `this(...)` on itself would be a compile
error) — which means the target name is *always* ambiguous under a
no-overload-resolution design. This isn't a bug to chase further; it's the
correct, tested consequence of refusing to guess which overload was meant.
`super(...)` is not attempted at all, for the same reason EXTENDS is
same-file-only: the superclass is frequently declared in a different file.

## Real-corpus verification (not synthetic)

Ran `JavaSemanticProvider` directly against 8 hand-picked real files
(`HttpClient.java`, `CloseableHttpClient.java`, `HttpRoute.java`,
`RouteTracker.java`, `AuthScope.java`, `HttpRequestRetryStrategy.java`,
`HttpClientBuilder.java`, `DigestScheme.java`) — **all 8 succeeded, 0
diagnostics**:

| File | Entities | Relationships | KnownUnknowns |
|---|---|---|---|
| HttpClient.java (interface, 289 lines) | 11 | 10 (all DECLARES) | 8 (unresolved imports — every referenced type is a JDK/sibling-module type) |
| CloseableHttpClient.java (267 lines) | 13 | 22 (11 DECLARES, 3 IMPORTS, 8 CALLS) | 19 |
| HttpRoute.java (484 lines) | 40 | 34 (31 DECLARES, 3 CALLS) | 23 |
| RouteTracker.java (409 lines) | 36 | 29 (27 DECLARES, 2 CALLS) | 12 |
| AuthScope.java (273 lines) | 21 | 15 (all DECLARES) | 8 |
| HttpRequestRetryStrategy.java (interface, 107 lines) | 6 | 5 (all DECLARES) | 7 |
| HttpClientBuilder.java (1,136 lines) | 111 | 88 (62 DECLARES, 14 IMPORTS, 10 INSTANTIATES, 2 CALLS) | 80 |
| DigestScheme.java (722 lines) | 48 | 42 (31 DECLARES, 3 IMPORTS, 8 CALLS) | 73 |

Then ran it against **every one of the 424 real `.java` files** under
`org.apache.hc.client5.http` (not a curated subset) to check the design
holds at real scale, not just on hand-picked examples: **424/424 succeeded,
0 diagnostics** — 5,542 entities (3,193 methods, 1,437 variables, 395
classes, 61 interfaces, 32 enums), 4,902 relationships (3,681 DECLARES, 521
CALLS, 458 IMPORTS, 238 INSTANTIATES, 4 EXTENDS), 5,013 `KnownUnknown`s. The
low EXTENDS count (4 out of hundreds of real subclass relationships in this
codebase) and the complete absence of resolved IMPLEMENTS in this run are
expected and consistent with the design, not a bug: in a well-organized
codebase, an interface and its implementations are almost always in
different files, and this tier is explicitly same-file-only.

## Verification against CLAUDE.md's Definition of Done

1. **Tests pass.** `npx tsc --noEmit` clean. `npm run lint`: 0 errors (942
   pre-existing style warnings repo-wide, 5 attributable to the new Java
   files, all pre-existing `curly`-brace style). Full `npx jest`: 232/286
   passing (was 222/276 before this change) — the same 35 pre-existing
   failing suites, plus 1 new suite (10 tests) that all pass. No
   regressions.
2. **Called from a real production entry point.** `JavaSemanticProvider` is
   registered in `indexManager.ts`'s real constructor path, reachable the
   same way the TS and Python providers are.
3. **No orphaned imports.** Additive; nothing superseded.
4. **Scratch artifacts cleaned up.** The direct-verification script used to
   produce the real-corpus counts above ran from the session scratchpad and
   was deleted after use.
5. **Docs updated.** `REPOGUIDE_AUDIT.md` §6 and its recommendation #8
   updated in place to reflect three providers and three real held-out
   corpora, rather than left describing a now-stale two-provider/two-corpus
   state.

## Known limitations (disclosed, not fixed here)

- IMPORTS resolves to a file, not to the specific imported symbol inside it
  (same scope reduction as Python's tier).
- CALLS/`this(...)` resolution has no overload/arity disambiguation — an
  ambiguous name resolves to nothing rather than a guess, which in practice
  means many real overloaded-method call sites produce no edge at all. This
  is the same "don't guess" tradeoff Python made for MRO/inheritance, applied
  to Java's overloading instead.
- EXTENDS/IMPLEMENTS are same-file only, which in a well-organized real
  codebase (interfaces and implementations typically in separate files)
  means most of them resolve to nothing — confirmed empirically in the
  424-file run (4 EXTENDS, 0 IMPLEMENTS), not just theorized.
- REFERENCES unimplemented, by design.
- Only one real Java repo (Apache HttpClient) backs this — a second, less
  interface-heavy real corpus (e.g. a concrete-class-heavy codebase) would
  strengthen confidence the design generalizes beyond an interface-driven
  library.
