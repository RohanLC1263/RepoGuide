# Go Semantic Provider + resty Eval Corpus

The fifth `SemanticProvider` implementation, and structurally the biggest
departure from Python/Java/C# so far — Go has no classes, no `implements`
keyword, and no authoritative package-path declaration, forcing several
design decisions with no direct precedent in the first four providers.

## Foundation-layer claim re-checked directly, not assumed

Unlike C#, Go was claimed to already have working tree-sitter/AST-chunking
support. Confirmed directly rather than trusted: `grep` across all 5 legacy
call sites shows Go already wired into `languageDetector.ts` (grammar case),
`astChunker.ts` (`RELEVANT_NODE_TYPES.go`), `symbolExtractor.ts`
(`NODE_TYPES.go` + a Go-specific `type_declaration` branch), `staticAnalyzer.ts`
(Go-specific `isLikelyClassNode`), and `logicalUnitExtractor.ts` (generic-regex
fallback set, same tier as Java/C#). `parseSourceSafely()` confirmed used
generically at every shared call site. Ran the existing (already-wired)
pipeline against all 21 real non-test `.go` files in resty:
**21/21 parse cleanly, zero `hasError`** — no grammar gaps found, unlike
C#'s two confirmed gaps. Current extraction already produces 608 symbols /
51 classes / 21 imports across the corpus before any semantic-provider work.
**Confirmed: this was a semantic-provider-only build, like Java/Python — no
foundation work was needed.**

Repo-wide search for existing-but-unwired Go semantic code, same method as
C#'s investigation: `git show HEAD:<file> | grep -i go` across the semantic
layer and `git ls-tree -r HEAD --name-only | grep -i "goSemantic|providers/go"`
— both empty (the only false-positive was "golden" test files matching the
substring "go"). Confirmed clean.

## Structural findings that cut against the established pattern — reported honestly, not smoothed over

- **Methods aren't nested inside their struct's declaration at all.**
  Go's grammar already distinguishes `method_declaration` (has a `receiver`
  field) from `function_declaration` (no receiver) as different node
  types — easier than expected at the node level. But DECLARES (struct →
  method) can't be built by AST-parent-walking the way every previous
  provider did; it requires matching the method's receiver type name
  against a struct declared elsewhere in the file. All receiver fields
  (`receiver`/`name`/`parameters`/`result`/`body`) resolve reliably via
  `childForFieldName`, cleaner than Python's/C#'s inconsistent field names.
- **IMPLEMENTS is not attempted for Go at all — an explicit non-goal, not a
  scoped-down attempt.** Java has an `implements` keyword; C#'s `base_list`
  is at least syntactically present even if ambiguous. Go gives **zero**
  syntax for interface satisfaction — it's pure structural/duck typing,
  verified only by comparing method sets (including transitively-promoted
  methods from embedded types). Real Go code makes this gap concrete: the
  idiomatic `var _ LoadBalancer = (*RoundRobin)(nil)` pattern found in
  resty's own `load_balancer.go` exists *specifically because* the language
  gives no other way to get a compile-time interface-satisfaction check —
  which is exactly the syntax this provider also doesn't have to lean on.
  Attempting IMPLEMENTS would mean building an actual type-compatibility
  checker, not a name resolver — a qualitatively larger feature than
  anything built for the first four providers. Declared out of scope,
  disclosed here plainly rather than silently downgraded.
- **Struct/interface embedding is Go's real EXTENDS analog, confirmed via
  direct AST dump, not assumed.** An embedded field (`type Dog struct { Animal }`)
  is a `field_declaration` with *only* a type reference child and no
  `field_identifier` — structurally distinct from a named field (`Breed string`,
  which has both). Interface embedding is equally clean: `type_elem`
  (embedded interface) vs. `method_elem` (real method signature) inside
  `interface_type`. Both map to `EXTENDS`, explicitly disclosed as
  composition/embedding labeled with the nearest existing schema vocabulary,
  not literal OO inheritance.
- **Import resolution needed a genuinely new resolver, not a port of Java's/C#'s.**
  Go's `package_clause` is a bare identifier (`package resty`) with no
  resolvable path at all. The real resolvable identity comes from
  combining the module's declared path (`go.mod`'s `module` directive — a
  simple line-based parse, not tree-sitter AST, since go.mod isn't Go
  source) with the file's directory position relative to the module root.
  Confirmed against resty's real `go.mod` (`module resty.dev/v3`) and real
  import shapes (single, grouped, and aliased imports all confirmed via
  direct testing). Go import paths always resolve to a **directory**
  (a package), never a single file — a genuine difference from Java/C#,
  where an import can target one specific class file.
- **Exported/unexported is a clean visibility-only concern, simpler than
  Java's/C#'s modifier keywords.** Capitalization maps deterministically to
  `public`/`internal` — no default-guessing needed at all. Doesn't affect
  DECLARES/identity inclusion; unexported symbols are just as real a part
  of a package's structure.
- **Generics parse cleanly** (`type slidingWindow[G group[G]] struct {...}`,
  confirmed against real resty code, `hasError: false`) — no grammar gap
  here, unlike C#'s collection-expression issue. But generics did surface a
  real bug during implementation (below).

## The empirical check that could have gone either way, and didn't

Before implementing, you asked whether resty splits a struct's methods
across multiple files (a common enough Go idiom that same-file DECLARES
could have been a much larger undercount than any same-file restriction in
the first three providers). A robust, file-by-file scan across all 38
distinct receiver types in resty's real non-test source found **zero**
types with methods split across multiple files — every struct's methods
stay in exactly one file. This directly could have contradicted the
same-file design choice, but didn't for this specific corpus. Per your
explicit instruction, same-file DECLARES scope was kept (not redesigned to
same-package), consistent with your earlier choice and empirically
justified for resty, though a differently-organized Go codebase could still
hit this gap — stated as a disclosed limitation, not assumed away.

A second check — whether `composite_literal` (Go's INSTANTIATES analog) is
unambiguous the way Java's/C#'s `new` was — came back negative on first
principles, confirmed by direct testing: `Animal{Name: "x"}` and
`[]int{1,2,3}` (a plain slice literal, not a struct instantiation) use the
**same** node type, differing only in what their `type` field resolves to
(`type_identifier` vs. `slice_type`). INSTANTIATES therefore requires an
explicit filter (only `type_identifier` counts) that Java/C# never needed —
once applied, matching a locally-declared struct is reliable, but the raw
node type alone is shared/ambiguous in a way `new` never was.

## Three real bugs found and fixed during implementation, not assumed correct

1. **Missing DECLARES case for struct/interface types entirely.** The
   first golden-fixture test run showed 0 DECLARES relationships for
   `Animal`/`Dog` (only the package-level function `NewDog` got one) — the
   relationship resolver's `resolve()` switch never had a case for
   `type_declaration` at all, an outright omission caught by the test
   suite, not by code review.
2. **Wrong assumed field name for `struct_type`.** `resolveEmbedding`
   assumed `struct_type.childForFieldName('body')` would give the field
   list; it returns `undefined` (confirmed by direct testing after the
   embedding test failed) — `field_declaration_list` is `struct_type`'s
   only namedChild and has to be found positionally, not via a field name
   that doesn't exist.
3. **Generic receivers broke every method-to-struct link on a generic
   type.** Corpus-scale verification against real resty code (`circuit_breaker.go`'s
   `slidingWindow[G group[G]]`) showed 4 unexpected "Receiver type"
   `KnownUnknown`s — methods on a generic struct's receiver
   (`func (s *slidingWindow[G]) Add(...)`) read the receiver type as the
   literal text `"slidingWindow[G]"`, which never matches how the struct
   itself is indexed (by its bare name `"slidingWindow"`). Fixed by
   extending the pointer-type unwrap to also unwrap `generic_type` down to
   its bare `type_identifier`. Re-verified directly: the 4 unknowns dropped
   to 0, and DECLARES count increased by exactly 4 system-wide — confirming
   the fix, not just assuming it worked. This also confirmed the earlier
   empirical file-split check was accurate: these weren't real cross-file
   splits, just a text-matching bug.

## Real-corpus verification (not synthetic)

7 hand-picked real files, all `status: SUCCESS`, 0 diagnostics:

| File | Entities | Relationships | KnownUnknowns |
|---|---|---|---|
| `client.go` (2,659 lines) | 173 | 213 (163 DECLARES, 49 CALLS, 1 INSTANTIATES) | 21 |
| `request.go` (1,884 lines) | 101 | 126 (99 DECLARES, 27 CALLS) | 25 |
| `response.go` (356 lines) | 26 | 33 (24 DECLARES, 9 CALLS) | 12 |
| `load_balancer.go` (444 lines) | 39 | 39 (31 DECLARES, 4 INSTANTIATES, 4 CALLS) | 8 |
| `digest.go` (424 lines) | 21 | 33 (17 DECLARES, 2 INSTANTIATES, 14 CALLS) | 14 (incl. 1 "Embedded type") |
| `circuit_breaker.go` (485 lines) | 49 | 62 (39 DECLARES, 5 INSTANTIATES, 2 EXTENDS, 16 CALLS) | 4 |
| `resty.go` (213 lines) | 11 | 17 (9 DECLARES, 8 CALLS) | 11 |

Then, matching the rigor applied to the first four providers, ran the
provider against **every one of the 21 real non-test `.go` files** at the
module root (not a curated subset): **21/21 succeeded, 0 diagnostics** —
694 entities (435 methods, 113 functions, 65 variables, 48 classes, 12
interfaces), 837 relationships (608 DECLARES, 197 CALLS, 30 INSTANTIATES, 2
EXTENDS), 213 `KnownUnknown`s. The low EXTENDS count (2) reflects resty's
real structure honestly — a flat, mostly non-embedding-heavy single-package
library, not a bug.

## Eval corpus: resty, with an honest comparison disclosed

resty was investigated directly (cloned, all 21 files scanned, real AST
dumps against it) before being proposed. Two alternatives were lightweight-checked
via GitHub API (language breakdown + file count, not full-cloned): **fasthttp**
(valyala/fasthttp — 78 non-test files, 1.44MB Go, genuine multi-package
structure, but thematically diverges from the "HTTP client wrapper" pattern
of the other four corpora) and **go-retryablehttp** (hashicorp — only 4
non-test files, too small alone). You chose resty.

**Disclosed limitation, confirmed not assumed:** resty is an entirely flat
single-package module (`resty.dev/v3`, all 21 files at the module root, no
subdirectories) — confirmed via `find`. This means the eval corpus doesn't
exercise cross-package import resolution within one module, only the
same-package case plus external (stdlib/third-party) imports. fasthttp
would have been the better choice specifically for that dimension, at the
cost of thematic consistency — a real tradeoff, not glossed over.

`eval_repos/resty` (21 files) plus `src/test/evaluation/eval_questions_resty.json`
— 19 hand-written golden questions (3/5/4/3/3/1, matching the established
schema/minimums), written from reading `Client`, `Request`, `LoadBalancer`/`RoundRobin`,
`digestTransport`, and the `New()`/`NewRoundRobin` factory-function chains
directly, before the final corpus-scale verification run in this report.

## Verification against CLAUDE.md's Definition of Done

1. **Tests pass.** `npx tsc --noEmit` clean throughout. `npm run lint`: 0
   errors (6 pre-existing-style `curly` warnings attributable to the new
   files, matching repo-wide convention). Full `npx jest`: 306 total tests
   (up from 296 before this change, +10 for the new Go suite), with the
   same pre-existing failure pattern as every prior pass in this session —
   worth noting honestly: the failure *count* itself fluctuated between
   consecutive runs (35-40 failures across repeated runs) due to
   environment-dependent worker-crash flakiness in a handful of files
   (`runtimeDependencyPhaseB.test.ts` and similar, which call `process.exit()`
   in their own setup) that predate this work. Verified via `grep` on the
   failing-suite list across a run that no Go/semantic-provider file
   appears among them — all 34 unique failing files are the same
   pre-existing set (the mocha-import-under-jest pattern documented
   earlier this session, plus the flaky phase-test files), confirmed by
   name, not assumed. Go's own suite passes 10/10 on every run.
2. **Called from a real production entry point.** `GoSemanticProvider` is
   registered in `indexManager.ts`'s real constructor path, reachable the
   same way the TS/Python/Java/C# providers are.
3. **No orphaned imports.** Additive; nothing superseded.
4. **Scratch artifacts cleaned up.** The direct-verification script used to
   produce the real-corpus counts above ran from the session scratchpad
   and was deleted after use. The investigation clone was renamed from its
   temporary name to `eval_repos/resty` once confirmed as the actual corpus.
5. **Docs updated, and the update verified with `git diff`/`grep` before
   being reported done — not just claimed, per the explicit ask given the
   C# pass's false-alarm mixup.** `REPOGUIDE_AUDIT.md`'s §6 body and
   recommendation #8 both updated to name Go/`GoSemanticProvider`/`eval_repos/resty`.
   Confirmed live, in this same turn, via:

   ```
   $ grep -n "Go\b|GoSemanticProvider|resty" REPOGUIDE_AUDIT.md
   110:...serve working grammars for TypeScript, JavaScript, Python, Java, Go, Rust, C++, and (as of this update) C#...
   115:...`src/indexing/semantic/providers/go/` (`GoSemanticProvider`)...IMPLEMENTS is not attempted for Go at all...
   117:...Go's grammar was already working before this update (confirmed directly, not assumed...)...
   118:...`eval_repos/resty` (Go)...
   173:8. ...**Done for Python, Java, C#, and Go**...`eval_repos/resty` (19 questions)...
   ```

   ```
   $ git diff REPOGUIDE_AUDIT.md
   [shown in full during this session; index 09ad370a..560f0143, five hunks
   touching lines 110/115/117/118/120/122/173, all confirmed present in the
   working tree, not from memory]
   ```

## Known limitations (disclosed, not fixed here)

- IMPLEMENTS unimplemented by design for Go, for reasons qualitatively
  different from every other provider's scope reductions (no syntax to
  even approximate from, not merely a scoping choice).
- DECLARES/CALLS/INSTANTIATES are same-file only; same-package-aware
  linkage was considered and explicitly declined for consistency, checked
  empirically against resty (no cost found there), but a differently-organized
  Go codebase could still split a struct's methods across files and lose
  those DECLARES edges.
- CALLS does not follow embedding-based method promotion (a call to a
  method promoted from an embedded type, e.g. `d.Speak()` where `Speak` is
  declared on an embedded `Animal`, not `Dog` itself, stays silently
  unresolved) — verified via a dedicated test, not left as an unstated gap.
- IMPORTS resolves to a package directory, not a specific symbol within it.
- REFERENCES unimplemented, by design, same as every other provider.
- Only one real Go repo (resty) backs this, and it has a real, disclosed
  structural limitation (flat single-package, no internal cross-package
  imports to exercise) that a second corpus (e.g. fasthttp) would address.
