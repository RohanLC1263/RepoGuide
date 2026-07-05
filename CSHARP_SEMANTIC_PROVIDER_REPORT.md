# C# Semantic Provider + RestSharp Eval Corpus

The fourth `SemanticProvider` implementation, and the first to require building
a new foundation layer before any semantic work could start: unlike Python
and Java, C# had no tree-sitter grammar wired in at all. This report covers
both that foundation layer (real, verified, committed) and the semantic
provider built on top of it.

## Pre-existing state, confirmed directly, not assumed

`detectLanguage()` already mapped `.cs → 'csharp'`, but `getTreeSitterLanguage('csharp')`
had no case and fell to `default: return null` — C# was detected but had zero
grammar support. `logicalUnitExtractor.ts` already listed `csharp` in its
generic-regex fallback set (shared with Java, Go, Rust, C++, Ruby, PHP,
Swift), but `astChunker.ts`/`symbolExtractor.ts`/`staticAnalyzer.ts` had no
C#-specific entries anywhere. A search of the original `HEAD` commit
(`git show HEAD:<file> | grep -i csharp`, and `git ls-tree -r HEAD --name-only`
for any csharp-named file) confirmed no existing extraction code, built-but-
unwired or otherwise — the only two pre-existing mentions were the bare
extension mapping and the generic-regex set entry.

## Foundation layer: real before/after numbers, not projected

Added `tree-sitter-c-sharp` and wired it into `languageDetector.ts` (using
the whole module object for `setLanguage()`, not `.language` — passing
`.language` alone parses but then throws when walking the tree, since
node-tree-sitter's node-subclassing reads `nodeTypeInfo` off whatever was
passed in), `astChunker.ts`, `symbolExtractor.ts`, and `staticAnalyzer.ts`,
each using the shared `parseSourceSafely()` helper from the start (no inline
try/catch introduced, no retrofit needed later).

**Two real dependency bugs found and fixed, not assumed away:**
- **Version incompatibility.** The latest available version, `0.23.5`,
  throws `ERR_REQUIRE_ASYNC_MODULE` under this codebase's CommonJS
  `require()` (a top-level-await/ESM incompatibility in its native binding
  wrapper). Pinned to `0.23.1` in `package.json` **without a caret**
  (`"tree-sitter-c-sharp": "0.23.1"`, not `"^0.23.1"`) specifically so a
  future `npm install` can't silently drift onto the broken version. This is
  a load-bearing fact about the foundation this provider sits on, not an
  implementation detail — anyone touching this dependency later needs to
  know 0.23.5 is broken here, not just that 0.23.1 happens to be what's
  installed.
- **Export shape mismatch.** `tree-sitter-c-sharp` exports `{name, language, nodeTypeInfo}`,
  unlike every other grammar in this codebase (`tree-sitter-python`,
  `-java`, etc., which each export a named sub-property). Confirmed via a
  crash-then-fix cycle: passing `.language` alone parses successfully but
  throws later, mid-tree-walk, once `unmarshalNode` tries to read
  `language.nodeSubclasses` off a language object that was never given the
  `nodeTypeInfo` needed to build them.

**Real before/after numbers**, measured live by actually `git stash`ing the
wiring changes out and back in (not from memory), on 2 real files from
RestSharp:

| File | staticAnalyzer (imports/classes) | symbolExtractor (symbols) |
|---|---|---|
| `RestClient.cs` (291 lines) | 0/0 → 4/1 | 0 → 19 |
| `RestRequest.cs` (278 lines) | 0/0 → 4/1 | 0 → 35 |

**A second, distinct parse-error cause found via this same rigor, not just
the first one reported.** Both files above have `tree.rootNode.hasError: true`,
so `astChunker`'s chunk count for them is unchanged (8 and 7 plain-text
windows respectively) even after the wiring — `astChunker.ts` discards the
whole tree on any `hasError` and falls back to safe plain-text chunking.
Investigating why revealed **two separate root causes, not one**:
1. `RestClient.cs`: real, common C# preprocessor conditional-compilation
   (`#if NET ... #endif` wrapping a brace), which tree-sitter-c-sharp has no
   preprocessor pass to resolve — confirmed at corpus scale: 8 of 127 files
   (6.3%) in an earlier full-repo scan contained `#if`/`#endif` and had
   `hasError: true`.
2. `RestRequest.cs`: a **different** cause — `readonly List<FileParameter> _files = [];`
   at line 75, C# 12's **collection-expression syntax** (`= []` for an
   empty collection literal), which the installed grammar version doesn't
   fully parse. This is a real, disclosed, verified limitation: the
   installed grammar lags behind the newest C# language syntax, independent
   of the preprocessor issue. Neither is a bug in this session's code —
   both are properties of the third-party grammar this provider depends on.

Neither issue crashes anything or drops a file from the corpus — both
degrade gracefully to plain-text chunking for the affected files, the same
safe fallback every other language already has.

Full jest suite after the foundation layer alone: identical to the
pre-change baseline, zero regressions (confirmed before building anything
semantic on top, per the investigation's own stated order of operations).

## Semantic provider: design decisions confirmed via direct AST dumps

- **Namespace resolution transfers cleanly from Java, and is if anything
  simpler.** `namespace X.Y;` (file-scoped, C# 10+) or `namespace X.Y { }`
  (block-scoped) both give an explicit, authoritative dotted name via a
  working `name` field — same "no confidence flag needed" property Java's
  `package` declaration has over Python's best-effort walk.
- **`base_list` conflates EXTENDS and IMPLEMENTS syntactically — a
  genuinely new problem Java didn't have.** `class Foo : Base, IDisposable`
  has no `extends`/`implements` keyword split; the list is just comma-
  separated type references. Resolved by classifying each entry only when
  it resolves to a local declaration (checking whether the target node is
  `class_declaration`/`struct_declaration`/`record_declaration` → EXTENDS,
  or `interface_declaration` → IMPLEMENTS); an unresolved entry (the common
  case, since most base types are BCL/NuGet or cross-file) becomes a single,
  honestly generic `"Base type or interface"` `KnownUnknown` rather than a
  guessed relationship kind. Verified directly in a dedicated test with
  both a resolvable class, a resolvable interface, and an unresolved BCL
  interface (`IDisposable`) in the same file.
- **`modifier` nodes are separate siblings, not one wrapped node.** Unlike
  Java's single `modifiers` node, C# emits each `public`/`partial`/`static`
  as its own sibling `modifier` node — collected via a direct
  `namedChildren.filter`, not a port of Java's helper.
- **Properties are a new member kind** (`property_declaration`, distinct
  from `field_declaration`) — mapped to `entityKind: 'variable'`, same tier
  as fields, no schema change needed.
- **`method_declaration`'s return type has no reliable field name** —
  neither `type` nor `returns` resolves via `childForFieldName` (confirmed
  by direct testing before writing the identity builder, not assumed);
  extracted positionally instead (first namedChild that isn't an
  attribute_list/modifier/type_parameter_list).
- **`generic_name`'s base identifier also has no working field name** — a
  second field-name bug found and fixed *during* implementation:
  `generic_name.childForFieldName('type')` returns `undefined` for
  `new List<int>()`. Caught via a dedicated verification step before it
  could silently degrade INSTANTIATES/base-list resolution for any generic
  type (a very common C# pattern) to matching on the full `"List<int>"`
  text instead of the base name `"List"`. Fixed by reading
  `generic_name.namedChildren[0]` (the base identifier) directly.
- **Constructor delegation is structurally cleaner than Java's**: `: this(...)`/`: base(...)`
  is a dedicated `constructor_initializer` child of the constructor node
  itself, not a statement buried in the body. Same near-always-ambiguous-
  in-practice caveat as Java: any class using `this(...)` has 2+
  constructors by definition, so the constructor name is never unambiguous
  under the no-overload-resolution design — verified with a dedicated test
  asserting zero `CALLS` edges for a real 2-constructor `this(...)` case,
  not just asserting it "should" happen.
- **XML doc comments (`///`) are separate sibling `comment` nodes per
  line**, not one block — extracted by walking backward collecting
  consecutive `///`-prefixed siblings and stripping XML tags, a genuinely
  different routine from Java's block comment and Python's docstring.
- **Local functions** need the same "inside a method body → prune" rule
  already used for Java's local classes and Python's locals — one more
  trigger for the existing rule, not a new mechanism. Unlike Java, C# has
  no anonymous-class-body construct to separately detect (object
  initializers carry no nested method declarations), so this single check
  covers all of C#'s "not a stable member" pruning.
- **Records and structs** map cleanly to `entityKind: 'class'`, consistent
  with how Go's `type_declaration` already does the same for struct-shaped
  types. C# 12 primary constructors (`class Foo(int x) : Base`) were
  verified directly to parse without error and without disturbing the
  `name`/`base_list` lookups (confirmed against a real file,
  `AuthenticatorBase.cs`, that uses this exact pattern).
- **Overload-safe name resolution was carried forward from Java's fix, not
  re-broken.** `methodsByType` indexes a list per name; a name resolves
  only when exactly one candidate exists. This transfers directly since C#
  overloads just as freely as Java.

## A real IMPORTS-resolution bug found during corpus-scale verification, fixed before reporting

The first full-corpus run (all 110 `.cs` files under `src/RestSharp`)
produced **zero** resolved `IMPORTS` relationships, despite real,
verifiable intra-project `using` statements (e.g. `using RestSharp.Authenticators;`
in `RestClientOptions.cs`). Investigating why revealed the actual bug:
real C# `using` directives overwhelmingly reference a **namespace**
(a directory, e.g. `RestSharp/Authenticators/`), not a specific type file —
but the resolver only checked for a matching `.cs` **file**, so every
namespace-shaped `using` (the common case) failed to resolve even when the
namespace plainly existed on disk. Fixed by having `CSharpNamespaceResolver.resolveImport`
check for a matching **directory** first (representing the namespace
itself as the IMPORTS target) before falling back to the file check for
the less common "using a specific type" form.

**Verified, not just fixed and assumed working:** re-ran the same 110-file
corpus scan after the fix — `IMPORTS` went from 0 to 12 resolved
relationships. The golden-fixture test was updated to use a realistic
namespace-shaped `using` (matching real RestSharp code) instead of the
unusually-specific `using Namespace.ClassName;` form the test originally
used, so the test actually exercises the fix rather than the narrower case
that happened to already work.

**The remaining resolution gap (12 out of many more real `using`s across
110 files) is honestly explained, not hand-waved:** most `using`s in this
corpus are BCL types (`System.*`, unresolvable by design — they're not in
this project), and several reference sibling projects in the same solution
(e.g. `RestSharp.Serializers.Xml`) that live in separate top-level
directories outside the scanned `src/RestSharp` root, so they're out of
scope for a single-workspace-root resolver the same way a truly external
NuGet dependency would be.

## Eval corpus: RestSharp, with an honest comparison note

RestSharp was investigated directly (cloned, 127 files scanned, real
before/after/AST-dump verification against it) before being proposed.
One lightweight (not full-clone) real check was done on an alternative,
Polly, per explicit request: GitHub's API confirms `language: "C#"` with a
4.37MB C# / 7KB PowerShell / 128B Batchfile breakdown (no Kotlin/F#-style
migration risk) and 433 non-test `.cs` files (same order of magnitude as
RestSharp's 127, just larger) — confirming RestSharp wasn't a blind pick
against an unverifiable alternative, though Polly itself was not cloned or
run.

`eval_repos/restsharp` (127 files under `src/`) plus
`src/test/evaluation/eval_questions_restsharp.json` — 19 hand-written
golden questions (3/5/4/3/3/1, matching the established schema/minimums),
written from reading `RestClient`, `RestRequest`, `IAuthenticator`,
`AuthenticatorBase`, `HttpBasicAuthenticator`, and `RestClientOptions`
directly, before the final corpus-scale verification run in this report.

## Real-corpus verification (not synthetic)

7 hand-picked real files, all `status: SUCCESS`, 0 diagnostics:

| File | Entities | Relationships | KnownUnknowns |
|---|---|---|---|
| `RestClient.cs` (291 lines) | 22 | 22 (14 DECLARES, 8 CALLS) | 12 |
| `RestRequest.cs` (278 lines) | 38 | 10 (all DECLARES) | 7 |
| `IAuthenticator.cs` (19 lines) | 3 | 2 (all DECLARES) | 0 |
| `AuthenticatorBase.cs` (24 lines) | 5 | 4 (3 DECLARES, 1 CALLS) | 1 |
| `HttpBasicAuthenticator.cs` (37 lines) | 5 | 4 (all DECLARES) | 3 |
| `RestClientOptions.cs` (259 lines) | 37 | 3 (all DECLARES) | 10 |
| `OAuth1Authenticator.cs` (313 lines) | 29 | 14 (13 DECLARES, 1 CALLS) | 12 |

Then, matching the rigor applied to Python and Java, ran the provider
against **every one of the 110 real `.cs` files** under `src/RestSharp`
(not a curated subset): **110/110 succeeded, 0 diagnostics** — 957 entities
(385 methods, 333 variables, 111 classes, 9 interfaces, 9 enums), 618
relationships (502 DECLARES, 94 CALLS, 12 IMPORTS, 5 EXTENDS, 5
INSTANTIATES), 313 `KnownUnknown`s. The low EXTENDS count is expected and
consistent with the same-file-only design (most real base classes in a
well-organized codebase live in a different file), not a bug.

## Verification against CLAUDE.md's Definition of Done

1. **Tests pass.** `npx tsc --noEmit` clean throughout. `npm run lint`: 0
   errors (8 pre-existing-style `curly` warnings attributable to the new
   files, matching repo-wide convention). Full `npx jest`: 242/296 passing
   (was 232/286 before this change) — the same 35 pre-existing failing
   suites, plus 1 new suite (10 tests) that all pass. No regressions,
   verified after both the foundation-layer wiring and the semantic
   provider itself.
2. **Called from a real production entry point.** `CSharpSemanticProvider`
   is registered in `indexManager.ts`'s real constructor path, reachable
   the same way the TS/Python/Java providers are.
3. **No orphaned imports.** Additive; nothing superseded.
4. **Scratch artifacts cleaned up.** The direct-verification script used to
   produce the real-corpus counts above ran from the session scratchpad
   and was deleted after use. The exploratory clone used to derive the
   very first before-numbers was later confirmed as the actual eval corpus
   and renamed from its temporary investigation name to `eval_repos/restsharp`,
   not left as throwaway.
5. **Docs updated.** `REPOGUIDE_AUDIT.md` §6 and its recommendation updated
   in place: the "Ruby, PHP, C#, and Swift have no tree-sitter grammar"
   claim (now false for C#) struck through and corrected, the provider
   count and eval-corpus list updated to reflect four languages, not two.

## Known limitations (disclosed, not fixed here)

- IMPORTS resolves to a namespace or file, not to the specific imported
  symbol within a multi-type file (C# doesn't enforce one-type-per-file,
  so even a resolved file may not contain the specific type that was
  `using`-imported by name).
- CALLS/`this(...)` resolution has no overload/arity disambiguation, same
  tradeoff as Java's — an ambiguous name resolves to nothing rather than a
  guess.
- EXTENDS/IMPLEMENTS are same-file only, and additionally can't be
  classified at all for entries that don't resolve locally (the base_list
  ambiguity problem) — confirmed empirically at scale (5 EXTENDS, 0
  IMPLEMENTS resolved across 110 real files; most base types genuinely
  live in a different file, which is also the majority contributor to the
  313 KnownUnknowns).
- The `tree-sitter-c-sharp@0.23.1` grammar has at least two confirmed gaps
  against modern C#: preprocessor conditional-compilation blocks with
  unbalanced braces (`#if`/`#endif`), and C# 12 collection-expression
  syntax (`= []`). Both degrade gracefully (plain-text chunking fallback,
  or partial-tree extraction in the semantic provider) but neither is fixed
  — a proper fix would need a preprocessor-aware parsing pass or a newer,
  CommonJS-compatible grammar release, both out of scope here.
- REFERENCES unimplemented, by design, same as Python and Java.
- Only one real C# repo (RestSharp) backs this — a lightweight (not
  full-clone) check confirmed a plausible alternative (Polly) exists at
  comparable scale, but a second fully-verified corpus would still
  strengthen confidence the design generalizes beyond an HTTP-client-shaped
  library.
