# RepoGuide v2 - Production Prompt Pack From Prompt 3 Onward

Use this document after completing Prompt 0, Prompt 1, and Prompt 2 from the original pack.
Give the agent exactly one prompt at a time. Do not merge prompts.

Every prompt below inherits Prompt 0's operating contract:
- proof before prose
- no LLM-derived exact facts
- no silent legacy fallback
- no repo-specific hardcoding
- hard test-file suppression
- full source unit storage, never first-N-line truncation
- compile and tests after every gate
- evidence-only eval before answer generation

Every prompt below also adds these universal requirements:

```
TEST INTEGRATION REQUIREMENT:
Place tests under src/test unless there is a stronger existing convention in this repo.
Use node:test unless the repo clearly uses another test runner for backend tests.
Add or reuse an npm script so the test is executable through package.json.
Report the exact command and result.

ANTI-HARDCODING GREP:
Before completing the prompt, run:
  rg "CraftConnect|axios|DEFAULT_QUESTIONS|llm_router|customization_interview" src
New production implementation files must not contain repo-specific strings.
Golden eval fixtures may contain repo-specific strings only when the fixture is explicitly for that repo.

VERIFICATION FLOOR:
Run npm run compile.
Run the new tests for this prompt.
Run any existing evidence eval that already exists.
If an eval score drops, stop and fix the regression before advancing.
```

---

## Prompt 3A - Logical Unit Extractor Core for Python

```
Task: Implement production-grade Python logical unit extraction.
This prompt handles only Python full units, import blocks, constant blocks, prompt templates, config blocks, parse status, and whole-file fallback.
Do not implement branch sub-units yet.
Do not implement TS/JS extraction yet.

BEFORE WRITING ANYTHING, READ:
- src/indexing/logicalUnitTypes.ts
- src/indexing/fileRoleClassifier.ts
- src/indexing/astChunker.ts
- src/indexing/textChunker.ts
- src/comprehension/staticAnalyzer.ts
- src/indexing/languageDetector.ts
- package.json

UNDERSTAND AND REPORT BEFORE CODING:
- The exact line where astChunker truncates large classes or functions, if present.
- The exact lines where textChunker uses fixed line windows.
- Which parser packages are installed.
- The repo's test-file convention.

UPDATE TYPE SYSTEM IF NEEDED:
- Add metadata.readsSymbols?: string[] to LogicalUnitMetadata.
- Add metadata.writesSymbols?: string[] if useful for assignment/config extraction.
- Add metadata.valuePreview?: string for short non-authoritative display of constants.
- Do not remove or rename existing fields from Prompt 1.

CREATE OR UPDATE:
- src/indexing/logicalUnitExtractor.ts

EXPORT:
- extractLogicalUnits(filePath: string, content: string, language: string): LogicalUnit[]
- extractLogicalUnitsFromFile(filePath: string, repoRoot: string): Promise<LogicalUnit[]>

PYTHON EXTRACTION CONTRACT:
1. Extract top-level functions and async functions as type "function".
2. Extract top-level classes as type "class".
3. Extract class methods as type "method" with parentSymbol and metadata.className.
4. startLine and endLine are 1-based and must match the full AST node span.
5. content is the exact full source text for the unit. No truncation.
6. A 500-line function is one complete function unit.
7. Every LogicalUnit.role comes from classifyFileRole(filePath).
8. id = `${filePath}::${symbol ?? 'block'}::${type}::${startLine}`.
9. Never use absolute paths in ids.

PYTHON BLOCK CONTRACT:
1. Extract one import_block for the initial contiguous top-level import section.
2. Extract constant_block units for contiguous top-level assignments.
3. Constant block grouping allows at most one blank line between assignments.
4. A gap of two or more blank lines starts a new constant_block.
5. Each assigned top-level name appears in metadata.readsSymbols.
6. Extract prompt_template units for string assignments whose variable name contains:
   prompt, system, template, instruction, full_prompt, system_prompt, user_prompt, chat_template.
7. Extract config_block units for top-level or class-level settings involving:
   os.getenv, os.environ.get, dotenv, BaseSettings fields.

PARSE STATUS CONTRACT:
1. If AST parsing succeeds: parseStatus "complete", extractionMethod "tree_sitter" or the parser method actually used.
2. If AST parsing partly succeeds with recoverable errors: parseStatus "partial".
3. If parser is unavailable and regex extraction is used: parseStatus "regex_fallback", extractionMethod "regex", metadata.confidence "medium".
4. If no structured extraction is possible: emit exactly one whole_file_fallback unit with the entire file content.
5. Whole-file fallback must never emit 50-line windows.

REGEX FALLBACK CONTRACT:
- Python regex fallback must find def, async def, and class definitions.
- It must find the full body by indentation matching.
- It must not stop at line 150 or any fixed window.

TESTS:
Create fixtures under src/test/fixtures:
- logical_units_python_core.py

The fixture must include:
- module imports
- module constants grouped into at least two constant blocks
- DEFAULT_ITEMS = ["a", "b", "c", "d", "e"]
- a prompt string assignment
- an os.getenv or os.environ.get config value
- one class with two methods
- one async function
- one long function named process_items with at least 180 lines and a final fallback return on the last function line

Required assertions:
- Exactly one function unit has symbol "process_items".
- That function unit endLine equals the real final function line.
- That function unit content contains the final fallback return.
- There is at least one class unit and at least two method units.
- There is one async function with metadata.isAsync === true.
- There is an import_block containing the initial imports.
- There is a constant_block whose metadata.readsSymbols includes "DEFAULT_ITEMS".
- There is a prompt_template for the prompt assignment.
- There is a config_block for the environment access.
- No extracted unit content is truncated to 50 or 150 lines.
- All units have role equal to classifyFileRole(filePath).

ACCEPTANCE:
- npm run compile passes.
- The new extractor tests pass through package.json.
- rg anti-hardcoding check passes.
- No LLM calls added.
```

---

## Prompt 3B - Python Branch Sub-Units

```
Task: Add Python branch sub-unit extraction for large functions and methods.
This prompt must not change full unit extraction behavior from Prompt 3A.

BEFORE WRITING ANYTHING, READ:
- src/indexing/logicalUnitExtractor.ts
- src/indexing/logicalUnitTypes.ts
- src/test/fixtures/logical_units_python_core.py
- all tests added in Prompt 3A

BRANCH CONTRACT:
For any Python function or method where endLine - startLine > 150:
1. Always emit the full function/method unit.
2. Also emit branch sub-units for top-level control-flow blocks inside the function body:
   if, elif, else, for, while, try, except, finally, with, match, case.
3. Branch units must have:
   type: "branch"
   parentUnitId: the full function or method id
   parentSymbol: the function or method symbol
   metadata.branchKind set to the exact branch kind
   startLine/endLine equal to the real block span
   content equal to the full branch source text
   extractionMethod and parseStatus inherited from structured extraction
4. Branch units are supplementary. They must never replace the full function unit.
5. Branch ids use the same global id format and must be stable.

SCOPE CONTRACT:
- Only top-level branches within the large function body are required.
- Nested branches may be included only if they do not produce duplicate spans and do not reduce precision.
- Do not emit branch units for functions <= 150 lines.

TESTS:
Extend the Python fixture or add logical_units_python_branches.py with:
- a function over 180 lines
- top-level if
- top-level for or while
- top-level try/except/else/finally
- a final fallback return after all branches

Required assertions:
- Exactly one function unit with symbol "process_items".
- The full function unit still contains the final fallback return.
- Branch sub-units exist for if, try, except, else, finally.
- Each branch has parentUnitId equal to the process_items unit id.
- Each branch content starts and ends on actual branch block boundaries.
- No branch content contains unrelated code before the branch starts.
- A short function with an if statement produces zero branch units.

ACCEPTANCE:
- npm run compile passes.
- Prompt 3A tests still pass.
- Prompt 3B tests pass.
- rg anti-hardcoding check passes.
```

---

## Prompt 3C - TypeScript and JavaScript Logical Unit Extraction

```
Task: Implement production-grade TS/JS logical unit extraction.
This prompt covers full units, import blocks, constant blocks, prompt templates, config blocks, and branch sub-units for large functions.

BEFORE WRITING ANYTHING, READ:
- src/indexing/logicalUnitExtractor.ts
- src/indexing/languageDetector.ts
- package.json
- src/comprehension/staticAnalyzer.ts
- existing TS/JS parser or tree-sitter integration files
- tests from Prompt 3A and 3B

TS/JS FULL UNIT CONTRACT:
Extract:
1. function declarations
2. async function declarations
3. arrow functions assigned to const/let/var
4. exported functions
5. classes
6. class methods
7. object methods when they are named, top-level, and represent public behavior

For every unit:
- endLine must be the closing brace or expression end line of the full AST node.
- content must be the full source text.
- metadata.isAsync must be true for async functions/methods.
- metadata.isExported must be true for exported declarations.
- metadata.parameters should contain parameter names when extractable.
- metadata.returnType should contain return annotations when present.

TS/JS BLOCK CONTRACT:
1. Extract the initial top-level import section as import_block.
2. Extract contiguous top-level constants as constant_block.
3. Extract prompt_template units from string/template literal assignments whose name contains:
   prompt, system, template, instruction, full_prompt, system_prompt, user_prompt, chat_template.
4. Extract config_block units for process.env, dotenv config access, and config object declarations with environment reads.

TS/JS BRANCH CONTRACT:
For functions/methods over 150 lines:
- Emit branch units for top-level if, else if, else, for, while, try, catch, finally, switch.
- Keep the complete parent function/method unit.

REGEX FALLBACK CONTRACT:
If structured parsing is unavailable:
- Use regex and brace matching for function/class/arrow function extraction.
- Mark extractionMethod "regex", parseStatus "regex_fallback", confidence "medium".
- Do not use fixed windows.

TESTS:
Create fixtures under src/test/fixtures:
- logical_units_typescript_core.ts
- logical_units_javascript_core.js

The TypeScript fixture must include:
- two classes
- one class with five methods
- one async method
- one exported function
- one arrow function
- const CONFIG_TIMEOUT = 5000
- const SYSTEM_PROMPT = `You are a helpful assistant...`
- process.env access
- one function over 180 lines with if/else and try/catch/finally

Required assertions:
- Class units are returned for both classes.
- Method units are returned for all class methods.
- The async method has metadata.isAsync === true.
- The exported function has metadata.isExported === true.
- The arrow function is returned as a function unit.
- constant_block metadata.readsSymbols includes CONFIG_TIMEOUT.
- prompt_template is emitted for SYSTEM_PROMPT.
- config_block is emitted for process.env.
- Large function branch units include if, else, try, catch, finally.
- No unit content is truncated.

ACCEPTANCE:
- npm run compile passes.
- Prompt 3A and 3B tests still pass.
- Prompt 3C tests pass.
- rg anti-hardcoding check passes.
```

---

## Prompt 3D - Extractor Robustness, Unsupported Languages, and File Helper

```
Task: Finish the extractor as a production component.
This prompt adds robust file reading, language dispatch, unsupported language behavior, binary/malformed protection, and deterministic ordering.

BEFORE WRITING ANYTHING, READ:
- src/indexing/logicalUnitExtractor.ts
- src/indexing/languageDetector.ts
- src/indexing/fileWalker.ts
- package.json

PRODUCTION CONTRACT:
1. extractLogicalUnits must never throw for ordinary bad input.
2. Empty files return [] unless a whole-file fallback is more appropriate for non-empty unparseable text.
3. Binary-looking content returns [].
4. Unsupported source languages use regex when safe, otherwise whole_file_fallback.
5. Non-source roles such as docs/config may emit config/prompt/import/constant units only when useful; otherwise return [].
6. Generated files should return [].
7. Results must be deterministic and sorted by:
   filePath, startLine, endLine, type, symbol/id.
8. Duplicate ids are a test failure. Resolve by making ids stable and unique.

FILE HELPER CONTRACT:
Implement:
  extractLogicalUnitsFromFile(filePath: string, repoRoot: string): Promise<LogicalUnit[]>

Rules:
- filePath may be repo-relative or absolute.
- ids and LogicalUnit.filePath must always be repo-relative.
- Read failures return [] and log only through existing repo logging if available.
- Detect language with the repo's languageDetector.
- Call extractLogicalUnits.
- Do not read outside repoRoot.

TESTS:
Add tests for:
- malformed Python returns partial structured units or whole_file_fallback, not throw.
- malformed TS returns partial structured units or whole_file_fallback, not throw.
- unsupported .rb or .go source uses regex when a simple function/class can be found.
- binary-looking content returns [].
- extractLogicalUnitsFromFile returns repo-relative paths and ids.
- extractLogicalUnitsFromFile returns [] for missing files.
- duplicate ids are not produced for a fixture with repeated symbol names in different scopes.
- generated files return [].

ACCEPTANCE:
- npm run compile passes.
- All Prompt 3 tests pass.
- rg anti-hardcoding check passes.
```

---

## Prompt 4 - Logical Unit Store and Index Integration

```
Task: Build the production LogicalUnitStore and wire extraction into indexing.

BEFORE WRITING ANYTHING, READ:
- src/store/storeTypes.ts
- src/indexing/logicalUnitTypes.ts
- src/indexing/logicalUnitExtractor.ts
- src/indexing/fileWalker.ts
- src/indexing/indexManager.ts or the current indexing orchestrator
- src/store/vectorStore.ts
- src/store/sqliteStore.ts or existing persistent store files
- package.json

STORE CONTRACT:
Create or update src/store/logicalUnitStore.ts.

The store must support:
- init(repoRoot: string): Promise<void>
- upsertUnits(units: LogicalUnit[]): Promise<void>
- deleteFile(filePath: string): Promise<void>
- getUnit(id: string): Promise<LogicalUnit | undefined>
- getUnitsByFile(filePath: string): Promise<LogicalUnit[]>
- searchBySymbol(symbol: string, options?: { role?: LogicalUnitRole; types?: LogicalUnitType[]; limit?: number }): Promise<LogicalUnitIndex[]>
- searchByContent(query: string, options?: { role?: LogicalUnitRole; excludeRoles?: LogicalUnitRole[]; limit?: number }): Promise<LogicalUnitIndex[]>
- listIndexes(options?: { role?: LogicalUnitRole; types?: LogicalUnitType[]; limit?: number }): Promise<LogicalUnitIndex[]>

PERSISTENCE CONTRACT:
- Store full LogicalUnit.content without truncation.
- Store a lightweight LogicalUnitIndex for fast lookup.
- Persist under .repoguide using existing storage conventions.
- Writes must be atomic enough that a failed write does not corrupt the previous index.
- deleteFile must remove every unit for that file.

INDEXING INTEGRATION CONTRACT:
- During indexing, call extractLogicalUnitsFromFile for source files.
- Store logical units alongside existing legacy chunks; do not break legacy behavior.
- Generated files are not stored.
- Test units may be stored but must carry role "test" for hard suppression later.
- Report extraction diagnostics: count by role, type, parseStatus, extractionMethod.

TESTS:
- upsert and get preserve full content for a >180-line function.
- deleteFile removes all units for that file.
- searchBySymbol finds exact symbols and respects role/type filters.
- searchByContent can find a constant by name and by literal value.
- storage survives re-init.
- index integration creates logical units for a fixture repo.
- no stored unit has truncated content.

ACCEPTANCE:
- npm run compile passes.
- New store tests pass through package.json.
- Existing indexing tests still pass.
- rg anti-hardcoding check passes.
```

---

## Prompt 5 - Production Fact Extraction and Fact Store

```
Task: Extract exact facts deterministically from LogicalUnits and persist them.
No LLM calls. No repo-specific heuristics.

BEFORE WRITING ANYTHING, READ:
- src/indexing/logicalUnitTypes.ts
- src/indexing/logicalUnitExtractor.ts
- src/store/logicalUnitStore.ts
- src/comprehension/staticAnalyzer.ts
- existing fact/evaluation types if present

CREATE OR UPDATE:
- src/indexing/factTypes.ts
- src/indexing/factExtractor.ts
- src/store/factStore.ts

FACT TYPES MUST COVER:
- constant
- numeric_threshold
- list_literal
- list_count
- dict_literal
- string_literal
- prompt_template
- config_value
- environment_variable
- fallback_chain
- guard_clause
- dependency_injection
- instantiation
- import
- exported_symbol
- call_site
- assignment

FACT RECORD CONTRACT:
Each FactRecord must include:
- factId
- filePath
- unitId
- symbol
- factType
- value
- valueKind
- startLine
- endLine
- extractionMethod
- confidence
- sourceText
- role
- diagnostics?

EXTRACTION CONTRACT:
1. All exact values come from AST or deterministic parsing.
2. AST assignment facts are confidence high.
3. Regex facts are confidence medium.
4. Comment/docstring inference is confidence low and may not be used for exact values.
5. Extract list_count from actual list literal length, not from text heuristics when AST exists.
6. Extract fallback_chain from try/except, nullish coalescing, default parameters, catch/finally, guard returns, and explicit default branches when structurally visible.
7. Extract dependency injection and instantiation from constructor calls, class initializers, provider arrays, and function parameters where deterministic.
8. Keep multiple facts for the same symbol if they have different confidence or source spans.
9. Prefer highest confidence at query time; do not discard lower confidence diagnostics.

STORE CONTRACT:
FactStore must support:
- init(repoRoot: string): Promise<void>
- upsertFacts(facts: FactRecord[]): Promise<void>
- deleteFile(filePath: string): Promise<void>
- getFact(factId: string): Promise<FactRecord | undefined>
- findBySymbol(symbol: string, options?: filters): Promise<FactRecord[]>
- findByType(factType: FactType, options?: filters): Promise<FactRecord[]>
- findExactValue(value: unknown, options?: filters): Promise<FactRecord[]>
- queryFacts(query: FactQuery): Promise<FactRecord[]>

TESTS:
- numeric threshold extraction gets exact numeric values.
- list_count gets exact length.
- string and prompt templates preserve exact source text.
- env var facts include variable names.
- fallback facts preserve order.
- DI/instantiation facts identify class/function names and call sites.
- test and generated roles are preserved on facts.
- store persists, filters, deletes by file, and returns highest confidence first.

ACCEPTANCE:
- npm run compile passes.
- Fact extractor/store tests pass.
- Prompt 3 and 4 tests still pass.
- rg anti-hardcoding check passes.
```

---

## Prompt 6 - Constant and Fact Expansion Engine

```
Task: Implement deterministic expansion from retrieved units to the exact facts they read or reference.

BEFORE WRITING ANYTHING, READ:
- src/store/logicalUnitStore.ts
- src/store/factStore.ts
- src/indexing/factExtractor.ts
- src/indexing/logicalUnitExtractor.ts
- any existing symbol index or lexical map

CREATE:
- src/query/factExpansion.ts

EXPORT:
- expandConstantsAndFacts(seedUnits: LogicalUnitIndex[], query: string, stores: { unitStore: LogicalUnitStore; factStore: FactStore; symbolIndex?: SymbolIndex }): Promise<FactExpansionResult>

CONTRACT:
1. Identify symbol references in seed unit content using deterministic token/scope parsing.
2. Resolve referenced constants, lists, thresholds, prompt templates, config values, fallback facts, and instantiation facts from FactStore.
3. Expansion must be bounded and deterministic:
   - maxDepth default 2
   - maxFacts default 50
   - stable ordering by confidence, directness, file proximity, line number
4. Do not expand into test/generated facts for non-test queries.
5. Every expanded item must record retrieval_signal, reason, source seed unit, and confidence.
6. No LLM calls.

TESTS:
- a function referencing DEFAULT_ITEMS expands to the DEFAULT_ITEMS constant and list_count fact.
- a function referencing CONFIG_TIMEOUT expands to the numeric constant.
- a prompt query expands prompt_template facts.
- expansion does not include test/generated facts for implementation scope.
- recursive references stop at maxDepth and do not loop.
- ordering is deterministic across 3 runs.

ACCEPTANCE:
- npm run compile passes.
- Fact expansion tests pass.
- rg anti-hardcoding check passes.
```

---

## Prompt 7 - Evidence Planner

```
Task: Build a deterministic EvidencePlanner that turns a question into a retrieval plan.
The planner may use lexical rules only. It must not call an LLM.

BEFORE WRITING ANYTHING, READ:
- src/query/hybridRetrievalFusion.ts
- src/indexing/fileRoleClassifier.ts
- src/indexing/factTypes.ts
- src/indexing/logicalUnitTypes.ts
- existing evaluation query types if present

CREATE OR UPDATE:
- src/query/evidencePlanTypes.ts
- src/query/evidencePlanner.ts

PLAN CONTRACT:
EvidencePlan must include:
- originalQuery
- normalizedQuery
- queryType
- requiredEvidence
- symbolHints
- fileHints
- factTypes
- unitTypes
- fileScope: "implementation_only" | "tests_only" | "both" | "docs_config_allowed"
- retrievalStrategy
- mustExcludeRoles
- diagnostics

QUERY TYPES MUST INCLUDE:
- exact_constant
- threshold
- list_count
- fallback_chain
- dependency_injection
- symbol_location
- prompt_template
- config_surface
- behavior_explanation
- repo_orientation
- test_query
- unknown

HARD SUPPRESSION CONTRACT:
- Non-test queries must set mustExcludeRoles to include "test" and "generated".
- Test queries may use tests_only or both.
- Generated files are never evidence unless explicitly debugging indexing.

REQUIRED EVIDENCE CONTRACT:
- Exact numeric/list/value questions require fact evidence and source span evidence.
- Behavior questions require function/method/class units plus any relevant fallback/guard facts.
- Location questions require symbol/fact evidence and line spans.
- Orientation can use annotations/readme/community summaries if available, but not for exact facts.

TESTS:
- threshold queries produce threshold fact requirements.
- "how many" list queries produce list_count requirements.
- fallback-order queries produce fallback_chain requirements.
- dependency/injection queries produce instantiation/DI requirements.
- "where is X initialized" produces symbol_location plus instantiation requirements.
- test-focused queries allow test scope.
- ordinary implementation queries exclude tests/generated.
- unknown queries produce a conservative plan with structured gaps.

ACCEPTANCE:
- npm run compile passes.
- Evidence planner tests pass.
- rg anti-hardcoding check passes.
```

---

## Prompt 8 - Evidence Packet Builder

```
Task: Build the production EvidencePacketBuilder.
This is the core retrieval path: plan -> proof packet.

BEFORE WRITING ANYTHING, READ:
- src/query/evidencePlanner.ts
- src/query/evidencePlanTypes.ts
- src/query/factExpansion.ts
- src/store/logicalUnitStore.ts
- src/store/factStore.ts
- src/indexing/fileRoleClassifier.ts
- existing BM25/vector store files
- src/query/hybridRetrievalFusion.ts

CREATE OR UPDATE:
- src/query/evidencePacket.ts
- src/query/evidencePacketBuilder.ts

EVIDENCE PACKET CONTRACT:
EvidencePacket must include:
- query
- plan
- items
- facts
- coverage
- gaps
- diagnostics
- stale flags when available

EvidenceItem must include:
- id
- file
- startLine
- endLine
- role
- unitId?
- factId?
- symbol?
- type
- content
- retrieval_signal
- score
- confidence
- extractionMethod
- parseStatus
- stale?

BUILDER STEPS:
1. Apply role suppression before scoring.
2. Retrieve by exact symbol hints.
3. Retrieve by fact type/value requirements.
4. Retrieve by BM25 over unit indexes/content.
5. Retrieve by vector search only as supplementary evidence, never as sole proof for exact facts.
6. Run factExpansion on seed units.
7. Merge, dedupe, and rank.
8. Compute coverage against requiredEvidence.
9. Produce structured gaps for missing required evidence.

RANKING CONTRACT:
- Exact fact match outranks semantic/vector match.
- High-confidence AST facts outrank regex facts.
- Implementation evidence outranks docs for exact implementation questions.
- Test files must not appear in non-test packets.
- Full parent function should appear when a branch is selected.
- Branch units should appear when the query asks about code near the tail or a specific branch.

TESTS:
- exact threshold query retrieves numeric fact and source unit.
- list count query retrieves list_count and constant block.
- fallback query retrieves full function and relevant branch/fallback facts.
- dependency injection query retrieves instantiation facts and source spans.
- non-test query never returns test/generated evidence even when test file has better lexical score.
- missing symbol returns a structured gap and no legacy fallback.
- vector-only evidence cannot satisfy exact fact coverage.
- packet order is deterministic across 3 runs.

ACCEPTANCE:
- npm run compile passes.
- Packet builder tests pass.
- Existing tests pass.
- rg anti-hardcoding check passes.
```

---

## Prompt 9 - Golden Evidence Evaluation Harness

```
Task: Build the first production evidence eval before answer generation.
Do not implement answer synthesis until this eval passes.

BEFORE WRITING ANYTHING, READ:
- existing src/evaluation files
- src/query/evidencePacket.ts
- src/query/evidencePacketBuilder.ts
- src/query/evidencePlanner.ts
- src/indexing/factExtractor.ts

CREATE OR UPDATE:
- src/evaluation/evidenceGoldenTypes.ts
- src/evaluation/craftConnectGolden.ts
- src/evaluation/evidenceEvalRunner.ts
- src/evaluation/evidenceScorers.ts
- src/evaluation/evidenceReportWriter.ts

GOLDEN SUITE CONTRACT:
CraftConnect-specific strings are allowed only inside craftConnectGolden.ts and expected-output fixture files.
Create at least 10 cases:
- threshold exact value
- list count exact value
- fallback chain
- dependency injection / initialization
- prompt template
- config surface
- long function tail branch
- symbol location
- missing symbol gap
- implementation query with tempting test-file match

SCORING CONTRACT:
Gate 1: span retrieval.
- Pass if required source spans/files are in top-K.
- Initial required score: >= 8/10.

Gate 2: exact facts.
- Pass if exact numeric/list/string/fallback facts match source truth.
- Initial required score: >= 7/10.

Other metrics:
- test file leak rate must be 0%.
- numeric accuracy must be 100% for answered exact numeric cases.
- unsupported/missing cases must produce gaps, not guesses.

RUNNER CONTRACT:
- Build or refresh the index before eval unless --reuse-index is passed.
- Output JSON and human-readable markdown report.
- Exit nonzero when required gates fail.
- Include diagnostics for every failed case.

ACCEPTANCE:
- npm run compile passes.
- npm run eval:evidence:craftconnect exists.
- Run the eval if CraftConnect repo is available.
- If the eval fails, fix extraction/planning/retrieval root causes until Gate 1 >= 8/10, Gate 2 >= 7/10, leak 0%.
- rg anti-hardcoding check passes outside golden fixtures.
```

---

## Prompt 10 - Evidence Answer Synthesizer

```
Task: Implement answer generation constrained by EvidencePacket.
The LLM may synthesize prose only from evidence. It may not invent exact facts.

BEFORE WRITING ANYTHING, READ:
- src/query/evidencePacket.ts
- src/query/evidencePacketBuilder.ts
- existing prompt/synthesis files
- src/evaluation/evidenceEvalRunner.ts

CREATE OR UPDATE:
- src/prompts/evidencePrompt.ts
- src/query/evidenceAnswerSynthesizer.ts

SYNTHESIZER CONTRACT:
1. If required evidence is missing, answer with the gap. Do not guess.
2. Exact numbers, counts, paths, symbol names, and ordered fallback chains must be copied only from EvidencePacket facts/items.
3. Every factual paragraph must include citations to evidence item ids or file:line spans.
4. The LLM receives a compact evidence packet, not raw repo-wide context.
5. If the packet has stale warnings, the answer must mention them.
6. The synthesizer must expose a non-streaming and streaming API if the current UI needs streaming.
7. It must not call legacy retrieval.

PROMPT CONTRACT:
- State that evidence is authoritative and incomplete evidence must produce uncertainty.
- Forbid filling gaps from model memory.
- Require citations.
- Require "evidence does not determine" for unsupported facts.

TESTS:
- missing exact fact yields gap wording, not guessed number.
- numeric answer uses only packet value.
- cited answer includes evidence ids/spans.
- stale evidence warning appears when packet items are stale.
- synthesizer never calls legacy retrieval in evidence mode.

ACCEPTANCE:
- npm run compile passes.
- Synthesizer tests pass with a mocked LLM.
- CraftConnect evidence eval from Prompt 9 still passes.
- rg anti-hardcoding check passes.
```

---

## Prompt 11 - Deterministic Answer Gate

```
Task: Implement deterministic claim verification after synthesis.
No LLM calls.

BEFORE WRITING ANYTHING, READ:
- src/query/evidenceAnswerSynthesizer.ts
- src/query/evidencePacket.ts
- src/indexing/factTypes.ts
- existing answer gate or degraded gate files if present

CREATE OR UPDATE:
- src/query/answerGate.ts

GATE CONTRACT:
The gate takes:
- answer text
- EvidencePacket

It returns:
- outcome: "pass" | "revise" | "block"
- supported_claims
- unsupported_claims
- removed_or_rewritten_claims
- required_gaps
- finalAnswer
- diagnostics

DETERMINISTIC CHECKS:
1. Numeric values in the answer must appear in EvidencePacket facts/items for the same query context.
2. List counts must equal packet list_count facts.
3. Quoted strings and prompt text must be present in source evidence.
4. File paths and symbol names must appear in evidence.
5. Ordered fallback chains must match fact order.
6. Unsupported exact claims are removed or cause block.
7. If required evidence is missing, finalAnswer must say evidence does not determine.
8. No model call is allowed inside the gate.

TESTS:
- wrong numeric threshold is blocked or revised.
- wrong list count is blocked or revised.
- unsupported path/symbol is blocked.
- supported numeric claim passes.
- fallback order mismatch is blocked.
- gap packet cannot produce a confident answer.
- gate source contains no model-provider import or LLM call.

ACCEPTANCE:
- npm run compile passes.
- Answer gate tests pass.
- Evidence eval still passes.
- rg anti-hardcoding check passes.
```

---

## Prompt 12 - Incremental Index, Manifest, and Stale Evidence

```
Task: Make the evidence index production-safe under file changes.

BEFORE WRITING ANYTHING, READ:
- current index manager/orchestrator
- src/store/logicalUnitStore.ts
- src/store/factStore.ts
- src/query/evidencePacketBuilder.ts
- src/prompts/evidencePrompt.ts

CREATE OR UPDATE:
- src/indexing/indexManifest.ts
- incremental index logic in the indexing orchestrator

MANIFEST CONTRACT:
Track per file:
- repo-relative file path
- size
- mtimeMs
- content hash
- indexedAt
- language
- role
- unit count
- fact count
- parse diagnostics

INCREMENTAL CONTRACT:
- reindexChanged indexes new/modified files only.
- unchanged files are not rewritten.
- deleted files are removed from LogicalUnitStore, FactStore, vector/BM25 indexes, and manifest.
- generated files are removed/suppressed.
- file changes must mark evidence items stale when a packet is built before reindex.

STALE CONTRACT:
- EvidenceItem.stale = true when manifest says file has changed since indexed.
- evidencePrompt includes a warning for stale evidence.
- stale evidence does not silently masquerade as current.

TESTS:
- modify indexed file -> isStale true.
- reindexChanged reindexes modified file only.
- delete file -> all stores remove it.
- add file -> indexed.
- packet marks modified-but-not-reindexed evidence stale.
- stale warning appears in synthesized prompt.

ACCEPTANCE:
- npm run compile passes.
- Incremental index tests pass.
- Existing eval still passes after fresh index.
- rg anti-hardcoding check passes.
```

---

## Prompt 13 - Chat Pipeline Integration with Explicit Architecture Mode

```
Task: Wire the evidence path into chat behind an explicit setting.
Both paths coexist. No automatic fallback.

BEFORE WRITING ANYTHING, READ:
- src/query/hybridQueryPipeline.ts
- src/query/hybridRetrievalFusion.ts
- src/ui/sidebarProvider.ts
- src/extension.ts
- package.json
- src/evaluation/queryPipelineHarness.ts

ADD SETTING:
repoguide.queryArchitecture:
- enum: ["legacy", "evidence"]
- default: "legacy"
- description explains that evidence enables RepoGuide v2 proof-first behavior.

CREATE OR UPDATE:
- src/query/queryDispatcher.ts

DISPATCH CONTRACT:
- mode "legacy": existing behavior unchanged.
- mode "evidence": planner -> packet builder -> synthesizer -> answer gate.
- mode "evidence" must never call HybridRetrievalFusion.
- evidence failures return explicit error/gap results, never legacy fallback.
- optional mode "compare": run both paths and report side-by-side without blending.

UI CONTRACT:
- sidebar reads repoguide.queryArchitecture.
- legacy mode still works exactly as before.
- evidence mode shows answer plus evidence/gate metadata where the UI already supports metadata.

HARNESS CONTRACT:
- queryPipelineHarness accepts --mode legacy|evidence|compare.
- default remains legacy.

TESTS:
- dispatcher evidence mode does not call legacy mock.
- dispatcher legacy mode calls legacy mock.
- evidence failure does not call legacy fallback.
- compare mode runs both and keeps outputs separate.
- setting default is legacy.

ACCEPTANCE:
- npm run compile passes.
- Dispatcher/UI integration tests pass.
- Manual smoke: legacy chat query works.
- Manual smoke: evidence chat query works on a built index.
- rg anti-hardcoding check passes.
```

---

## Prompt 14 - Production Evaluation Framework and Stability Runner

```
Task: Finish the permanent regression harness.

BEFORE WRITING ANYTHING, READ:
- all src/evaluation files
- src/query/evidencePacket.ts
- src/query/answerGate.ts
- package.json

FRAMEWORK CONTRACT:
Implement or complete:
- evidencePrecisionAtK
- evidenceRecallAtK
- requiredEvidenceCoverage
- testFileLeak
- factRetrievalAccuracy
- constantExpansionFired
- unsupportedClaimRate
- numericAccuracy
- answerGatePassRate
- stabilityVariance
- classifyFailureMode
- writeEvidenceReport
- runStabilityCheck

REPORT CONTRACT:
Report must include:
- summary table
- Gate 1 and Gate 2 scores
- test file leak rate
- numeric accuracy
- constant expansion rate
- answer gate pass rate
- failed cases with retrieved evidence ids/files, missing evidence, and diagnostics
- regression delta if previous results are provided

STABILITY CONTRACT:
- run the same suite at least 3 times.
- use deterministic ordering and fixed seeds where applicable.
- overall variance must be < 0.05.

NPM SCRIPTS:
- eval:evidence:craftconnect
- eval:stability:craftconnect
- eval:compare:craftconnect

ACCEPTANCE:
- npm run compile passes.
- Evaluation framework tests pass.
- CraftConnect evidence eval runs if repo exists.
- Stability runner runs if repo exists.
- rg anti-hardcoding check passes outside golden fixtures.
```

---

## Prompt 15 - Second Repository Generalization Gate

```
Task: Prove RepoGuide v2 is not CraftConnect-specific.
Do not add Program Graph until this passes.

BEFORE WRITING ANYTHING, READ:
- src/evaluation/evidenceGoldenTypes.ts
- src/evaluation/craftConnectGolden.ts
- src/evaluation/evidenceEvalRunner.ts
- src/indexing/logicalUnitExtractor.ts
- src/indexing/factExtractor.ts
- src/query/evidencePlanner.ts
- src/query/evidencePacketBuilder.ts

PRECHECK:
Run:
  rg "CraftConnect|axios|DEFAULT_QUESTIONS|llm_router|customization_interview" src
Any match outside golden fixtures is a bug. Fix it first.

CHOOSE SECOND REPO:
- Use a local non-CraftConnect Python or TS/JS repo with 1000-10000 lines if available.
- It must have at least one constant/threshold, one list, one fallback/guard, and one initialization/injection site.

CREATE:
- src/evaluation/secondRepoGolden.ts

GOLDEN CASES:
Generate or hand-author 5 cases from source truth:
- SR-01 exact threshold/constant
- SR-02 list count
- SR-03 fallback or guard behavior
- SR-04 class/function initialization location
- SR-05 orientation using annotations/docs/community summaries, not exact facts

GATE 4 PASS CONDITIONS:
- Gate 1 >= 4/5.
- Gate 2 >= 3/5.
- test file leak rate 0%.
- numeric accuracy 100% for SR-01 and SR-02.
- no repo-specific implementation code.

FAILURE POLICY:
If Gate 4 fails, identify root cause:
- extraction
- fact extraction
- planning
- packet building
- storage
Fix the generic root cause. Do not add repo-specific workarounds.

ACCEPTANCE:
- npm run compile passes.
- npm run eval:evidence:secondrepo exists.
- Run it if the second repo is available.
- Gate 4 passes before proceeding.
```

---

## Prompt 16 - Program Graph v1 After Gates Pass

```
PRECONDITION:
Do not implement this prompt until:
- CraftConnect Gate 1 >= 8/10
- CraftConnect Gate 2 >= 7/10
- AnswerGate blocks unsupported numeric claims
- Second repo Gate 4 passes

Task: Add Program Graph v1 as supplementary evidence navigation.
It must extend the evidence path without replacing it.

BEFORE WRITING ANYTHING, READ:
- src/comprehension/staticAnalyzer.ts
- src/comprehension/callGraph/callGraphBuilderV2.ts
- src/comprehension/lexicalMapBuilder.ts
- src/store/logicalUnitStore.ts
- src/store/factStore.ts
- src/indexing/logicalUnitTypes.ts
- src/indexing/factTypes.ts
- src/query/evidencePacketBuilder.ts

CREATE:
- src/graph/programGraphTypes.ts
- src/graph/programGraphBuilder.ts
- src/store/programGraphStore.ts

GRAPH CONTRACT:
Build from existing extracted data where possible. Do not re-parse if the data already exists.

Node types:
- file
- logical_unit
- function
- method
- class
- constant
- assignment
- call_site
- instantiation
- import
- prompt_template

Edge types:
- contains
- imports
- calls
- instantiates
- reads
- assigns
- decorates
- fallback_to

STORE CONTRACT:
Persist under .repoguide/graph/graph.json and expose:
- build(unitStore, factStore, repoRoot)
- getReads(unitId)
- getCallers(symbol)
- getCallees(unitId)
- getInstantiations(className)
- getFallbacks(unitId)
- getContainedBy(unitId)

PACKET BUILDER INTEGRATION:
- Add graph expansion after fact expansion.
- Graph expansion is supplementary.
- Add retrieval_signal values:
  graph_callee_expansion
  graph_caller_expansion
  graph_fallback_expansion
  graph_instantiation_expansion
- Only expand when primary evidence coverage_score > 0.5 or when the plan explicitly requires graph evidence.
- If eval score drops, filter graph expansion more tightly.

TESTS:
- graph contains file -> unit edges.
- graph contains class -> method edges.
- calls and instantiations are represented when facts/static analyzer provide them.
- fallback_to edges come from fallback facts.
- packet builder adds graph evidence only when allowed.
- graph expansion does not introduce test/generated leaks.

ACCEPTANCE:
- npm run compile passes.
- Graph tests pass.
- CraftConnect eval score does not decrease.
- Second repo eval still passes.
- rg anti-hardcoding check passes.
```

---

## Prompt 17 - Final Production Reliability Validation

```
Task: Run the full definition-of-done validation and fix every failure.

RUN:
1. npm run compile
2. all unit tests through package.json
3. npm run eval:evidence:craftconnect
4. npm run eval:evidence:secondrepo
5. npm run eval:stability:craftconnect
6. npm run eval:compare:craftconnect
7. rg "CraftConnect|axios|DEFAULT_QUESTIONS|llm_router|customization_interview" src

REQUIRED FINAL RESULTS:
- compile passes with zero errors.
- all unit tests pass.
- CraftConnect Gate 1 >= 9/10.
- CraftConnect Gate 2 >= 8/10.
- claim support rate >= 90% on passing answers.
- test file leak rate 0%.
- numeric accuracy 100%.
- second repo Gate 1 >= 4/5.
- second repo test file leak rate 0%.
- second repo numeric accuracy 100% for exact cases.
- stability variance < 0.05 across 3 runs.
- evidence score >= legacy score on Gate 1 + Gate 2 comparison.
- legacy path still works.
- evidence path never silently calls legacy.
- no repo-specific strings in production implementation files.

MANUAL SMOKE TESTS:
- Evidence query for a known threshold returns the exact source value and citation.
- Evidence query for a known list count returns the exact count and citation.
- Evidence fallback-order query returns the exact chain in order with citations.
- Query for a missing function returns "evidence does not determine" or equivalent gap wording.
- Legacy mode chat query still works.
- Feed a wrong numeric value into AnswerGate and verify outcome is not "pass".

FAILURE POLICY:
If any condition fails:
- Identify the failing layer: extraction, facts, store, planner, packet builder, synthesizer, gate, UI, or eval.
- Fix the root cause generically.
- Re-run the relevant focused tests.
- Re-run the full validation before shipping.

RepoGuide v2 is production-ready only when every required result above passes.
```

