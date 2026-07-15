# node-tree-sitter 32KB Buffer Bug: Investigation and Fix

Triggered by the fix applied for `PythonSemanticProvider` (see
`PYTHON_SEMANTIC_PROVIDER_REPORT.md`), which hit the same defect at a 5th
call site. This report covers the pre-existing 4 call sites shared by every
currently-supported language, not just Python.

## Root cause

`node-tree-sitter`'s string-input parse path (`Parser.prototype.parse`,
`node_modules/node-tree-sitter/index.js`) defaults to a 32KB internal read
buffer and throws `Error: Invalid argument` for any input past that
boundary, unless an explicit `bufferSize` option is passed. Confirmed by
binary search against a real file: failure begins at byte-offset exactly
**32,768**, independent of file content or language.

This is not a Python-specific or synthetic issue. Every one of the 4
existing call sites calls `parser.parse(content)` the same way, with no
`bufferSize` override, so every currently-supported language passes through
this defect once a file crosses ~32KB — a completely ordinary size for real
production source files (see "Real-file verification" below).

## Pass 1 findings (investigation, before any fix)

Nothing crashes: all 4 sites already wrap `parser.parse()` in a try/catch.
The question was whether the fallback each site takes on catch is a real
degrade or a broken one. Verified directly (not just by reading code)
against 4 real files across 2 languages: `httpx/_client.py` (68KB),
`httpx/_models.py` (46KB), `eval_repos/yarn/.../Project.ts` (110KB),
`eval_repos/medusa/.../order/service.ts` (196KB) — all 4 confirmed to throw
past 32KB.

| Call site | Verdict | Why |
|---|---|---|
| `staticAnalyzer.ts` (`analyzeFileStructure`) | **Actually broken (silent).** | Falls back to `buildEmptyStructure`. For every language except Python, this is **fully empty** — 0 imports, 0 exports, 0 classes, 0 functions, 0 calls. Confirmed on both real TS files: completely empty `FileStructure`. This feeds the comprehension engine's `static_analysis` stage on every file of every full index run, which `call_graph_v1` depends on (`comprehensionEngine.ts:119`) — and the engine counts this as `filesAnalyzed++`, not `filesFailed++`, so the hollow result is logged as a successful analysis. This is a live correctness bug for real TypeScript/JavaScript codebases today, not a Python-only concern. |
| `symbolExtractor.ts` (`extractSymbols`) | **Degraded, compounding the above.** | TS/JS get a regex fallback that only matches `function`/`class`/arrow-const patterns, missing `interface` entirely. Java/Go/Rust/C++ get zero symbols on **any** parse failure (not just this bug). Real effect: yarn's file recovered 387/592 symbols via regex vs. AST; medusa's interface-heavy file recovered **1 of ~240+ real symbols**. Feeds `indexManager.ts`'s symbol index directly. |
| `astChunker.ts` (`astChunk`) | **Already safe.** | Falls back to plain `textChunk` (50-line windows) for every language, plus an extra regex pass for Python. Full file coverage preserved for embeddings; only chunk-boundary precision is lost. Matches its own documented contract exactly. |
| `logicalUnitExtractor.ts` (`extractLogicalUnits`) | **Degraded, not broken.** | Non-Python/TS/JS languages never call tree-sitter at this site regardless of file size (bypassed unconditionally), so they were never exposed here. Python/TS/JS fall back to a regex extractor that itself falls back further to a single whole-file unit if it finds zero matches — confirmed on medusa's file (1 `whole_file_fallback` unit instead of per-method granularity). Never returns nothing; the file stays indexed, just coarsely. |

**Conclusion presented to the user before any fix:** this was not "nothing to
fix." `staticAnalyzer.ts` had a live, silent bug affecting real TypeScript/
JavaScript files today, miscounted as a successful analysis. Given the
identical `try { parser.parse(content) } catch { ... }` pattern was
duplicated at all 4 sites (and had just been fixed a 5th time for Python
inline), the user chose to fix all 4 via a shared helper rather than patch
each site separately or fix only `staticAnalyzer.ts`.

## Fix

Added `src/indexing/treeSitterParse.ts`:

```ts
export function parseSourceSafely(parser: Parser, content: string): Parser.Tree | null {
    try {
        return parser.parse(content, undefined, { bufferSize: content.length + 1024 });
    } catch {
        return null;
    }
}
```

Applied at all 5 call sites (the original try/catch-around-`parser.parse`
block replaced with a single call, each site's own post-parse null-handling
left untouched):

- `src/comprehension/staticAnalyzer.ts`
- `src/indexing/astChunker.ts`
- `src/indexing/symbolExtractor.ts`
- `src/indexing/logicalUnitExtractor.ts`
- `src/indexing/semantic/providers/python/pythonSemanticProvider.ts`
  (replaced its own one-off inline `bufferSize` fix from the prior pass with
  this shared helper, for consistency — same fix, one place)

## Verification against the same real files

Re-ran all 4 original call sites against the same 4 real files after the fix:

| File | staticAnalyzer | astChunker | symbolExtractor | logicalUnitExtractor |
|---|---|---|---|---|
| httpx `_client.py` (68KB) | 0→**23 imports**, 6→**7 classes**, 0→**6 top-level calls** | 139→71 chunks (now real AST boundaries, not text windows) | 94→**240 symbols** | 10→**93 units** |
| httpx `_models.py` (46KB) | 0→**17 imports** | 133→64 chunks | 102→**277 symbols** | 10→**96 units** |
| yarn `Project.ts` (110KB) | 0→**41 imports**, 0→**1399 exports**, 0→**1 class**, 0→**24 functions** | 70→116 chunks | 387→**592 symbols** | 18→**68 units** |
| medusa `order/service.ts` (196KB) | 0→**6 imports**, 0→**625 exports** | 128 chunks (unchanged — was already using safe text-window fallback) | 1 symbol (unchanged — see caveat below) | 1→1 unit (`whole_file_fallback`→`import_block`, see caveat below) |

`staticAnalyzer.ts` — the one confirmed-broken site — now recovers full,
real structure on every file tested, including the two that previously came
back completely empty.

**Caveat found during re-verification, explicitly not fixed here (separate,
pre-existing, narrower issue):** medusa's `order/service.ts` is a single
large `export interface IOrderModuleService { ... }` with no `class`/
`function` declarations at all. `symbolExtractor.ts`'s `NODE_TYPES.typescript`
list maps `interface_declaration` but not `method_signature` (the node type
for a method inside an interface body), so even with parsing now succeeding,
only the interface itself is captured as a symbol, not its ~150+ method
signatures. This is a real, separate gap in the TS node-type mapping,
independent of file size — a tiny interface-only file would show the same
limitation. Flagging it here since it surfaced during this investigation,
but it's out of scope for the buffer-bug fix and wasn't touched.

## Full jest suite

`npx jest`: **222/276 passing**, same as the pre-fix baseline (35
pre-existing failing suites, unrelated to this change, unchanged). No
regressions. `npx tsc --noEmit` and `npm run lint` both clean (0 errors).

## Definition of Done

1. **Tests pass.** Full jest suite unchanged at 222/276; `logicalUnitExtractor.test.ts`/`logicalUnitStore.test.ts` (15 tests) and the Python provider's 8 tests re-run and pass explicitly. `tsc --noEmit` and `eslint` clean.
2. **Called from real production entry points.** All 4 fixed functions are the same production functions already wired into `comprehensionEngine.ts`, `indexManager.ts`, and the extraction pipeline — this is a fix to existing production code paths, not new orphaned code.
3. **No orphaned imports.** Each site's original try/catch was replaced in place, not left running alongside the new helper.
4. **Scratch artifacts cleaned up.** The verification script used to produce the before/after tables above ran from the session scratchpad and was deleted after use.
5. **Docs updated.** No existing doc claimed a false absolute guarantee here (`LANGUAGE-ARCHITECTURE.md`'s existing fallback descriptions remain accurate — they describe fallback *behavior*, not a size threshold), so no correction was needed; this report is the durable record of the bug and fix.
