# Rust Semantic Provider — Implementation Report

Sixth `SemanticProvider` implementation, after TypeScript, Python, Java, C#, and Go. Registered in
shadow mode alongside the other five (`src/indexing/indexManager.ts`) — computed but not yet
authoritative for any language's query answers.

## 1. Pass 1 findings (re-verified, not assumed)

**Foundation layer was already fully wired** — confirmed via direct grep, not trusted from prior
claims (per the explicit instruction to re-check the way the Go pass "caught nothing" and the C#
pass "found things weren't as claimed"):

- `src/indexing/languageDetector.ts:11` (`case 'rs': return 'rust';`) and `:40` (`getTreeSitterLanguage('rust')`)
- `src/indexing/astChunker.ts:13` — `'rust': new Set(['function_item', 'impl_item', 'trait_item', 'static_item', 'const_item'])`
- `src/indexing/symbolExtractor.ts:37` — `rust: [...]` NODE_TYPES entry
- `src/comprehension/staticAnalyzer.ts:22,33,44,60` — `rust: new Set([...])` for `ROOT_FUNCTION_TYPES`/`CLASS_TYPES`/`IMPORT_TYPES`/`CALL_TYPES`
- `src/indexing/logicalUnitExtractor.ts:24` — `'rust'` in `SOURCE_LANGUAGES_WITH_GENERIC_REGEX`
- `tree-sitter-rust: ^0.23.2` already a working dependency in `package.json`

(My first grep pass, pattern `'rust'|"rust"|case 'rust'`, actually missed the unquoted object-literal
keys in `symbolExtractor.ts`/`staticAnalyzer.ts` — a plain `grep -n "rust"` caught them. Exactly the
kind of thing "re-verify, don't trust" is meant to catch, self-corrected before reporting.)

**No prior Rust semantic code existed** — confirmed via `git show HEAD:src/indexing/semantic/providers`
(only `typescript/` present), `git ls-tree -r HEAD --name-only | grep -i rust` (empty), and
`grep -rli "RustSemanticProvider" src/` (empty). This was genuinely new code, not a wiring fix.

## 2. Structural findings, confirmed via direct AST dumps

| Question | Finding |
|---|---|
| Does `impl Trait for Type` give real IMPLEMENTS support? | **Yes — a genuine tier improvement over every prior provider.** `impl_item`'s `trait`/`type` fields are both directly present and reliably resolvable via `childForFieldName`; distinguished from an inherent `impl Type` block by whether `trait` is present at all. Better than C#'s ambiguous `base_list` and Go's total absence. |
| Are impl blocks commonly split across files for the same type? | **Rare but non-zero** — a naive regex check first over-reported 16 "splits" (false positives: same type *name* reused across different modules, e.g. reqwest's three unrelated `Client` types in `async_impl/`/`blocking/`/`wasm/`). A directory-scoped re-check found **2 genuine same-type splits out of 108** impl'd types in reqwest (`Body`, `Reader`). Same-file-only scope was kept per user decision, consistent with Go's precedent — and empirically confirmed real, non-catastrophic (~98% same-file). |
| Does struct-literal instantiation share a node type with tuple/array literals (like Go's `composite_literal`)? | **No — genuinely distinct node types.** `struct_expression`/`tuple_expression`/`array_expression` are all separate, confirmed via direct construction and dump. INSTANTIATES needs **zero filtering** in Rust, unlike Go. |
| Do generic impls (`impl<T> Foo<T>`) hit the same receiver-type-text bug that broke Go's generic methods? | **Yes, proactively fixed before any resolution code was written.** A generic impl's `type`/`trait` fields resolve to a `generic_type` node whose `.text` includes the type arguments (e.g. `"Container<T>"`, `"From<String>"`), which never matches how the struct/trait is indexed by its bare name. Fixed via `unwrapGenericType()` in `astHelpers.ts`, applied to both `implTypeName()` and `implTraitName()`. |
| Do macros generating real impls/methods need a disclosed limitation? | **Yes, confirmed with a real corpus example, not hypothetical.** Verified via full-corpus extraction on reqwest: `TotalTimeoutBody`/`ReadTimeoutBody` are declared inside `pin_project! { struct TotalTimeoutBody<B> { ... } }` macro invocations in `src/async_impl/body.rs` — these struct declarations are genuinely invisible to structural extraction (never appear as root-level `struct_item` nodes), while a later top-level `impl<B> hyper::body::Body for TotalTimeoutBody<B>` *is* visible and correctly produces an "Impl target type" `KnownUnknown` when it can't resolve the type. Same category as Java's reflection gap and Go's embedding-promotion gap — disclosed, not silently swallowed. |
| Does a Cargo.toml/module resolver need to be more intricate than Go's/Java's? | **Yes, confirmed, not assumed.** `crate::`/`self::`/`super::`/own-crate-name/external-crate all need distinct handling. A real bug was found and fixed during implementation (see §4). |

## 3. Design, as implemented

File layout mirrors the established per-language pattern under `src/indexing/semantic/providers/rust/`:
`rustSemanticProvider.ts`, `internalModels.ts`, `astHelpers.ts`, `declarationVisitor.ts`,
`relationshipVisitor.ts`, `semanticAstWalker.ts`, `repositoryEntityAssembler.ts`,
`mappers/{declarationClassifier,documentationExtractor,locationMapper,modifierMapper}.ts`,
`resolution/{signatureHasher,identityDescriptorBuilder,nameResolver,relationshipResolver,crateResolver}.ts`.

**Entity kinds**: `struct_item` → `class`, `enum_item` → `enum`, `trait_item` → `interface`,
`function_item` → `method` (if enclosed in an `impl`/`trait` block) or `function` (module-level),
`const_item`/`static_item` → `variable`. A local `fn` nested inside another function's body (legal,
real Rust) is pruned via `isInsideFunctionBody`, the same as struct/enum/trait/const/static locals.

**Relationship tiers**:
- **DECLARES** — module-level items from a synthetic module entity; impl-block methods DECLARES
  from their owning struct/enum (resolved same-file via `implTypeName` + the generic-unwrap fix);
  trait default methods (with a body, i.e. real `function_item`s) DECLARES from their trait.
  **Disclosed gap**: trait method *signatures without a body* use a distinct node type
  (`function_signature_item`, not `function_item`) and are not captured at all — confirmed via the
  golden fixture test (`Speak.speak` invisible, `Speak.greet` with a default body captured).
- **IMPORTS** — via `RustCrateResolver`, handling `crate::`/`self::`/`super::`/own-crate-name paths,
  both simple (`use crate::error::Error;`) and grouped/nested (`use std::{fmt, io::{Read, Write}}`,
  aliased `use self::error::{Error as MyError, Result};`), confirmed against reqwest's own `lib.rs`
  re-export chain. External crates and `std`/`core`/`alloc` are correctly out of scope.
- **IMPLEMENTS** — `impl Trait for Type`, classified only when *both* the trait and the implementing
  type resolve to a module-level declaration in the same file. A genuine tier improvement over every
  prior provider's IMPLEMENTS story, at the cost of the same same-file-only ceiling as everything else.
- **EXTENDS** — `trait Sub: Super (+ Other)` supertrait bounds, Rust's closest analog to inheritance
  since there's no struct inheritance. Lifetime bounds (`'static`) are filtered out (see §4 — this
  was a real bug found during real-corpus verification, not anticipated in the plan).
- **INSTANTIATES** — `struct_expression`, unfiltered (see §2 — no ambiguity to filter).
- **CALLS** — same-file only, and *narrower* than Go's: only `self.method()` (field_expression with
  literal `self` receiver) and `Type::method()`/`Self::method()` (scoped_identifier) forms are
  attempted. Calls through an arbitrary variable (`client.get()`) are not attempted at all — Rust has
  no receiver-variable-name convention to check an arbitrary call's target type against the way Go's
  arbitrary-but-consistent receiver name at least offers one signal. A real, disclosed narrower tier
  than Go's CALLS, not an oversight.
- **REFERENCES** — excluded, consistent with every other provider.

## 4. Bugs found and fixed during implementation (not assumed away)

1. **Doc-comment adjacency check was wrong** — `rustDocFor`'s original adjacency check compared
   `current.endPosition.row === nextRow - 1`, assuming (by analogy with Go/C#'s single-line comments)
   that a `line_comment` node's span ends on the same row it starts. Confirmed via direct AST dump
   that a Rust `line_comment` node's `endPosition.row` actually spills onto the *next* row (the
   trailing newline is part of the node's span), which made every doc comment silently fail to
   attach — caught by the golden-fixture test showing every entity's `documentation` as `undefined`.
   Fixed by comparing `current.startPosition.row === nextRow - 1` instead, which is span-inclusion-
   agnostic. Re-verified: all doc comments (`Dog is a domesticated animal.`, `Speak is something that
   can speak.`, etc.) now attach correctly.

2. **`RustCrateResolver.resolveUnderDir` couldn't resolve the single most common `use` shape** — the
   original implementation joined the *entire* remainder of a `use` path (e.g. `["error", "Error"]`
   for `use crate::error::Error;`) as one file/directory path, which fails whenever the last segment
   is an imported item name rather than a module segment — i.e. almost every real item-level import.
   Fixed by trying the full remainder first (for module-only imports like `use crate::config;`), then
   falling back to the remainder with its last segment dropped (treating it as an item name). Found
   before shipping, via the golden-fixture test's crate-relative item-import case
   (`use crate::shapes::Shape;`), not discovered later against the real corpus.

3. **Supertrait-bound resolution flagged lifetime bounds (`'static`) as unresolved traits** — found
   during real-corpus verification against reqwest (`src/config.rs`, `src/connect.rs`): a
   `trait_bounds` node's children can be a `lifetime` node (`'static`), not just `type_identifier`/
   `generic_type`. The original loop treated every bound uniformly, producing a misleading
   "Supertrait bound" `KnownUnknown` for `'static`. Fixed by explicitly skipping `bound.type === 'lifetime'`
   nodes — a real bound, but not a trait, so silently dropped rather than flagged as noise.

## 5. Golden-fixture tests (`src/test/indexing/semantic/providers/rust/rustSemanticProvider.test.ts`)

12 tests, all passing, covering: `canHandle`, dispatcher registration, entity kinds + doc comments,
the disclosed signature-only-trait-method gap, IMPLEMENTS (including through a generic impl target
and an unresolved-trait `Clone` case), EXTENDS via supertrait bounds, IMPORTS (crate-relative module
and item imports, plus an unresolved stdlib import), CALLS (`self.method()`/`Self::method()`),
INSTANTIATES (unfiltered `struct_expression`, including through a generic impl), and the tuple/array
non-conflation confirmation.

```
Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
```

## 6. Real-corpus verification (`eval_repos/reqwest`, seanmonstar/reqwest 0.13.4)

**Single file** (`src/async_impl/client.rs`, the largest/richest file):

```
status: SUCCESS, diagnostics: 0
entities: 137  { class: 6, enum: 3, method: 123, function: 4, module: 1 }
relationships: 182  { DECLARES: 126, IMPORTS: 19, INSTANTIATES: 6, CALLS: 31 }
knownUnknowns: 62  { 'Unresolved Import': 38, Trait: 7, 'Unresolved Instantiation': 3, 'Impl target type': 14 }
durationMs: 464
```

**Full corpus** (40 non-test `.rs` files under `src/`):

```
files processed: 40, failed: 0, diagnostics: 0
entities: 1294  { class: 107, enum: 27, method: 929, function: 162, module: 40, variable: 10, interface: 19 }
relationships: 1692  { DECLARES: 1113, INSTANTIATES: 103, IMPORTS: 114, CALLS: 354, IMPLEMENTS: 5, EXTENDS: 3 }
knownUnknowns: 1017  { 'Unresolved Import': 588, 'Unresolved Instantiation': 72, Trait: 127, 'Impl target type': 214, 'Supertrait bound': 16 }
durationMs: 2275 (total, all 40 files)
```

**IMPORTS resolve rate: 16.2%** (114 resolved / 702 total). This is honestly low, and expected: the
vast majority of reqwest's `use` statements target `std`/external crates (`hyper`, `http`, `bytes`,
`tokio`, `url`, etc.), which are correctly out of scope for a same-file/same-crate resolver. Spot-
checked samples confirm the unresolved imports are genuinely external (`std::fmt`, `std::task::Poll`,
etc.), not resolver bugs.

**IMPLEMENTS (5) vs. unresolved "Trait" KnownUnknowns (127)**: also expected, not a red flag — the
overwhelming majority of real `impl X for Y` blocks in reqwest implement *std* traits (`Debug`,
`Default`, `From<T>`, `Clone`) rather than reqwest's own traits, so the type resolves locally but the
trait doesn't. The 5 that *do* resolve are real (e.g. `IntoUrl for Url`, `IntoUrlSealed for String`,
etc., confirmed by spot-checking).

No crashes, no unhandled exceptions, 0 diagnostics across all 40 files.

## 7. Full jest suite

```
Test Suites: 35 failed, 1 skipped, 50 passed, 85 of 86 total
Tests:       34 failed, 20 skipped, 264 passed, 318 total
```

The 34 failures are the same pre-existing, unrelated flaky failures documented in every prior
language's report (TS-compiler-mocking issues in `typeScriptProjectContext.test.ts`, worker-process
crashes in `knowledgeHotspot.test.ts`/`runtimeDependencyPhaseB.test.ts`/`runtimeBlastRadiusPhaseD.test.ts`,
a `t.beforeEach` API-shape issue in `checkpoint2_migration.test.ts`) — confirmed via
`npx jest 2>&1 | grep -iE "FAIL.*rust|RustSemantic"` returning no matches. Total test count rose from
306 to 318, exactly the 12 new Rust tests added.

## 8. `REPOGUIDE_AUDIT.md` update — verified live

```diff
-- AST chunking is centralized, not duplicated per language: ... serve working grammars for
   TypeScript, JavaScript, Python, Java, Go, Rust, and C++ ...
++ ... TypeScript, JavaScript, Python, Java, Go, Rust, C++, and (as of this update) C# ...

-**Gap:**
-- The deeper semantic/fact extraction layer ... has exactly one provider ...
++**Gap (partially closed — see update below):**
++- ~~...~~ **Update:** five more providers are now registered alongside the TypeScript provider in
   `indexManager.ts` — ... `src/indexing/semantic/providers/go/` (`GoSemanticProvider`), and
   `src/indexing/semantic/providers/rust/` (`RustSemanticProvider`). All five are tree-sitter/AST-based
   ... Rust's `struct_expression` needs no such filtering at all ... Rust shares Go's
   no-classes/methods-in-separate-impl-blocks structure, but `impl Trait for Type` gives it a genuine
   **IMPLEMENTS tier improvement over every other provider** ... Derive/attribute macros
   (`#[derive(Debug)]`, `pin_project!`, `macro_rules!`) are a disclosed non-goal for Rust — confirmed
   via real-corpus testing ... All six providers currently run in the framework's global Shadow Mode
   ... see ... `RUST_SEMANTIC_PROVIDER_REPORT.md` ... Every language beyond
   TypeScript/Python/Java/C#/Go/Rust is still AST-chunking-only ...

-- Real-world eval corpora (`eval_repos/`: axios, medusa, yarn) are JS/TS-only; ...
++- ~~...~~ **Update:** `eval_repos/httpx` (Python), `eval_repos/httpclient` (Java),
   `eval_repos/restsharp` (C#), `eval_repos/resty` (Go), and `eval_repos/reqwest` (Rust) — each with
   19 hand-written golden questions — now exist as held-out non-JS corpora ...

-**Fix size:** ... extending the semantic/fact layer to a second language is a real design effort ...
++**Fix size:** ... a seventh language would still require the same level of care, though the
   `SemanticProvider` adapter seam itself has needed zero changes across all six implementations so far.

8. ~~Extend semantic/fact extraction beyond the single TypeScript provider ...~~ **Done for Python,
   Java, C#, Go, and Rust** — ... `eval_repos/reqwest` (19 questions) ... C++/Ruby/PHP/Swift remain
   AST-chunking-only with no eval corpus.
```

Full raw `git diff REPOGUIDE_AUDIT.md` output (captured directly from the terminal, unedited):

```
diff --git a/REPOGUIDE_AUDIT.md b/REPOGUIDE_AUDIT.md
index 09ad370a..3633b1ac 100644
--- a/REPOGUIDE_AUDIT.md
+++ b/REPOGUIDE_AUDIT.md
@@ -107,19 +107,19 @@ Audited 2026-07-02 against the 8 guiding principles in `VISION.md.md`. Findings

 **Verdict: Partially Aligned**

 **Evidence — good foundation:**
-- AST chunking is centralized, not duplicated per language: one `astChunk` function and one `getTreeSitterLanguage()` lookup (`src/indexing/astChunker.ts`, `src/indexing/languageDetector.ts:25-52`) serve working grammars for TypeScript, JavaScript, Python, Java, Go, Rust, and C++ — matching the tree-sitter dependencies declared in `package.json:284-291`.
+- AST chunking is centralized, not duplicated per language: one `astChunk` function and one `getTreeSitterLanguage()` lookup (`src/indexing/astChunker.ts`, `src/indexing/languageDetector.ts:25-52`) serve working grammars for TypeScript, JavaScript, Python, Java, Go, Rust, C++, and (as of this update) C# — matching the tree-sitter dependencies declared in `package.json`.
 - `src/indexing/fileRoleClassifier.ts:40-66` and `src/workspaceRootDetector.ts:20-21` recognize `pyproject.toml`, `Cargo.toml`, `go.mod`, `requirements.txt` alongside `package.json` — genuine multi-stack awareness at the file-role layer.
 - `src/runtime/blast_radius/` and `src/runtime/dependencies/` operate on a generic component/trace graph, not language-specific AST — durable by design. `traceIngestionService.ts:7` explicitly supports `pytest | coverage | otel | log | manual` trace formats, spanning ecosystems.

-**Gap:**
-- The deeper semantic/fact extraction layer — the part that actually builds structured understanding, not just chunks — has exactly one provider: `src/indexing/semantic/providers/typescript/`, registered alone in `indexManager.ts:117`. Every non-JS/TS language gets AST chunking but not semantic fact extraction.
+**Gap (partially closed — see update below):**
+- ~~The deeper semantic/fact extraction layer... has exactly one provider... Every non-JS/TS language gets AST chunking but not semantic fact extraction.~~ **Update:** five more providers are now registered alongside the TypeScript provider in `indexManager.ts` — `src/indexing/semantic/providers/python/` (`PythonSemanticProvider`), `src/indexing/semantic/providers/java/` (`JavaSemanticProvider`), `src/indexing/semantic/providers/csharp/` (`CSharpSemanticProvider`), `src/indexing/semantic/providers/go/` (`GoSemanticProvider`), and `src/indexing/semantic/providers/rust/` (`RustSemanticProvider`). All five are tree-sitter/AST-based, not compiler-based — there is no embeddable type-checker equivalent to TypeScript's for any of them — so all are honestly a lower tier than the TS provider: strong on structural facts, same-file-only for CALLS, and none attempts REFERENCES. Java's and C#'s INSTANTIATES are unambiguous (`new X()`'s `type` field, no heuristic); Go's is similarly unambiguous once `composite_literal` is filtered to named-type references (excluding slice/map/array literals, which share the same node type) — both a genuine tier improvement over Python's uppercase-name guess; Rust's `struct_expression` needs no such filtering at all, since it's a genuinely distinct node type from tuple/array expressions. C# has no syntactic distinction between "extends" and "implements" (`base_list` conflates both), classified only when a base-list entry resolves locally. Go is structurally the biggest departure: it has no classes at all (methods are top-level declarations linked to their struct via receiver-type matching, not AST nesting), no `implements` keyword and no base-list-style syntax either — **IMPLEMENTS is not attempted for Go at all, an explicit disclosed non-goal**, since Go gives zero syntax for interface satisfaction to even heuristically approximate (a real tier regression from Java/C#, not a scoping shortcut). Struct/interface embedding is Go's EXTENDS analog instead. Rust shares Go's no-classes/methods-in-separate-impl-blocks structure, but `impl Trait for Type` gives it a genuine **IMPLEMENTS tier improvement over every other provider** (both the trait and type names are directly field-accessible on `impl_item`, unlike C#'s ambiguous `base_list` or Go's total absence) — classified when both resolve locally in the same file; `trait Sub: Super` supertrait bounds are Rust's EXTENDS analog. Rust's CALLS is narrower than Go's (only `self.method()`/`Type::method()`/`Self::method()` forms, since Rust has no receiver-variable-name convention to check an arbitrary call against). Derive/attribute macros (`#[derive(Debug)]`, `pin_project!`, `macro_rules!`) are a disclosed non-goal for Rust — confirmed via real-corpus testing that macro-wrapped struct declarations (e.g. reqwest's `pin_project! { struct TotalTimeoutBody ... }`) are genuinely invisible to structural extraction, the same category as Java's reflection and Go's embedding-promotion gaps. All six providers currently run in the framework's global Shadow Mode (computed but not authoritative for any language), so this doesn't change what the query pipeline sees today — see `PYTHON_SEMANTIC_PROVIDER_REPORT.md`, `JAVA_SEMANTIC_PROVIDER_REPORT.md`, `CSHARP_SEMANTIC_PROVIDER_REPORT.md`, `GO_SEMANTIC_PROVIDER_REPORT.md`, and `RUST_SEMANTIC_PROVIDER_REPORT.md` for the full tier breakdowns and real-corpus counts. Every language beyond TypeScript/Python/Java/C#/Go/Rust is still AST-chunking-only, not semantic-fact-extraction.
 - Kotlin (`.kt`) is mapped to the Java grammar (`languageDetector.ts:19`) — parses by approximation, not a real Kotlin grammar.
-- Ruby, PHP, C#, and Swift have no tree-sitter grammar at all and always fall back to fixed-window plain-text chunking.
-- Real-world eval corpora (`eval_repos/`: axios, medusa, yarn) are JS/TS-only; `test/fixtures/` has `python-fastapi` and `mixed-fullstack` unit fixtures but no equivalent large-scale, non-JS evaluation exists.
+- ~~Ruby, PHP, C#, and Swift have no tree-sitter grammar at all...~~ **Update:** C# now has a real grammar (`tree-sitter-c-sharp`, pinned to `0.23.1` exact — `0.23.5` is incompatible with this codebase's CommonJS `require()`, see `CSHARP_SEMANTIC_PROVIDER_REPORT.md`) wired through `languageDetector.ts`/`astChunker.ts`/`symbolExtractor.ts`/`staticAnalyzer.ts`. Go's grammar was already working before this update (confirmed directly, not assumed — see `GO_SEMANTIC_PROVIDER_REPORT.md`). Ruby, PHP, and Swift remain ungrammared, falling back to fixed-window plain-text chunking.
+- ~~Real-world eval corpora (`eval_repos/`: axios, medusa, yarn) are JS/TS-only...~~ **Update:** `eval_repos/httpx` (Python), `eval_repos/httpclient` (Java), `eval_repos/restsharp` (C#), `eval_repos/resty` (Go), and `eval_repos/reqwest` (Rust) — each with 19 hand-written golden questions — now exist as held-out non-JS corpora. See the respective `*_SEMANTIC_PROVIDER_REPORT.md` files.

-**Fix size:** Architectural — extending the semantic/fact layer to a second language is a real design effort (it must generalize whatever TypeScript-specific assumptions the current provider has), not a quick add.
+**Fix size:** Architectural — extending the semantic/fact layer to each additional language was a real design effort each time (see the per-language reports); a seventh language would still require the same level of care, though the `SemanticProvider` adapter seam itself has needed zero changes across all six implementations so far.

-**Confidence:** High on what's implemented; Medium on how much this gap has been felt in practice, since non-JS real-world evaluation is absent.
+**Confidence:** High on what's implemented; Medium on how much this gap has been felt in practice, since the semantic layer is still shadow-mode for every language and doesn't yet affect query answers.

 ---

@@ -170,7 +170,7 @@ Audited 2026-07-02 against the 8 guiding principles in `VISION.md.md`. Findings
 5. **Decide the fate of each orphaned module** (`src/intent`, `src/evolution`, `src/drift`, `src/causal`→MCP chain, `src/orchestrator`, `src/incident` singular) — wire into the live orchestrator/query path or delete. Currently pure maintenance liability with zero user-facing value. *Moderate.*
 6. **Retire or complete the `legacy` query pipeline** so only one provenance/confidence/answer model is maintained; today `explainSelection` silently falls back to legacy even under the "evidence" architecture, meaning users get inconsistent behavior depending on query type. *Moderate.*
 7. **Consolidate the UI design system** — make `indexHealthPanel.ts` and `explainPanel.ts` use the shared `wrapHtml()` shell instead of duplicated/bespoke CSS, and add one unified entry point that surfaces the other 8+ panels. *Architectural.*
-8. **Extend semantic/fact extraction beyond the single TypeScript provider**, and add at least one real-world non-JS eval corpus (Python/Go/Rust) alongside axios/medusa/yarn to validate the stack-agnostic claim under real load. *Architectural.*
+8. ~~Extend semantic/fact extraction beyond the single TypeScript provider, and add at least one real-world non-JS eval corpus (Python/Go/Rust) alongside axios/medusa/yarn to validate the stack-agnostic claim under real load.~~ **Done for Python, Java, C#, Go, and Rust** — `eval_repos/httpx` (19 questions), `eval_repos/httpclient` (19 questions), `eval_repos/restsharp` (19 questions), `eval_repos/resty` (19 questions), and `eval_repos/reqwest` (19 questions) are real, held-out, non-JS corpora. C++/Ruby/PHP/Swift remain AST-chunking-only with no eval corpus. *Architectural, partially addressed.*

 ---
```

## 9. Definition of Done checklist

1. **Tests pass** — `npm run compile && npm run lint` clean (0 errors, 5 pre-existing-style warnings
   matching the Go provider's own warning count/kind); `rustSemanticProvider.test.ts` 12/12 passing;
   full jest suite 264/318 passing with the same 34 pre-existing unrelated failures as every prior
   language's baseline (confirmed via `grep -iE "FAIL.*rust|RustSemantic"` returning no matches).
2. **Called from a real production entry point** — `RustSemanticProvider` is registered in
   `src/indexing/indexManager.ts:132` (`dispatcher.registerProvider(new RustSemanticProvider())`),
   which is constructed from `src/extension.ts`'s real indexing path, not just its own test file.
3. **No orphaned imports** — this is new code, not a replacement; nothing superseded.
4. **Scratch artifacts cleaned up** — all `scratch_rust_*`/`scratch_reqwest_*`/`scratch_*_check.js`
   files used during investigation and verification were deleted before this report was written;
   confirmed via `git status --short | grep -i scratch` returning nothing.
5. **Docs updated** — `REPOGUIDE_AUDIT.md` §6 updated and verified live above; this report is the
   language-specific doc, mirroring `GO_SEMANTIC_PROVIDER_REPORT.md`'s role.
