#!/usr/bin/env node
/**
 * The single source of truth for which test files run, under which runner, and why the
 * rest do not.
 *
 * Before this existed, CI ran exactly one file (out/test/extension.test.js, whose only
 * test asserts `true`). The other 155 test files under src/ were written, compiled, and
 * never executed by anything. The reason it stayed that way is that they need FOUR
 * different runners, and no single glob can express that.
 *
 * So the list is DERIVED FROM FILE CONTENT rather than hardcoded: a new test file is
 * picked up by CI on the day it lands, in whichever lane matches how it was written. Run
 * `npm run test:list` to print the full classification plus every exclusion and its
 * reason -- that output is the checkable version of the numbers quoted in ROADMAP.md.
 *
 * Lanes:
 *   node       node --test, process-isolated. The bulk of the suite.
 *   mocha-tdd  mocha --ui tdd  (files using suite()/test() with no framework import)
 *   mocha-bdd  mocha --ui bdd  (files using describe()/it() with no framework import)
 *              These two CANNOT share a run: mocha's tdd interface does not define
 *              describe/it, so a bdd file added to a tdd run fails to LOAD -- it does not
 *              merely fail its assertions.
 *   edh        real Extension Development Host, see .vscode-test-ci.mjs. Not run here.
 *
 * Anything excluded is excluded BY NAME with a reason, never by a silent glob gap.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/**
 * Excluded from CI, by src-relative path, with the reason. Two categories only:
 *
 *  ORPHANED  -- the production code under test is not reachable from src/extension.ts or
 *               src/mcp/mcpServer.ts, so getting its tests green would buy nothing that
 *               ships. Wiring the code in is a separate task; until then, not CI budget.
 *  STALE GOLDEN -- the provider gained capability and the golden fixture was never
 *               re-derived. Re-deriving it is a domain judgement about what the correct
 *               extraction output IS, not a mechanical fix, so it is filed rather than
 *               guessed at. See ROADMAP.md, "CI runs the real suite (P0-4)".
 */
const EXCLUDED = new Map([
    ['test/indexing/semantic/canonicalFactAdapter.test.ts',
        'ORPHANED: subject imported only by src/test/scripts/validateCP3E.ts. (1 of 10 cases fails.)'],
    ['test/indexing/semantic/canonicalFactNormalizer.test.ts',
        'ORPHANED: subject reached only via src/indexing/semantic/evaluation/*, itself unreachable. (1 of 4 fails.)'],
    ['test/investigationUI.test.ts',
        'EDH but not CI-runnable: needs a local CraftConnect checkout via CRAFTCONNECT_PATH (see .vscode-test.mjs), which no CI runner has. Run locally with `npm test`.'],
    ['test/indexing/semantic/evaluation/evaluationEngine.test.ts',
        'ORPHANED: src/indexing/semantic/evaluation/ is unreachable from either entry point.'],
    ['test/indexing/semantic/evaluation/renderers.test.ts',
        'ORPHANED: src/indexing/semantic/evaluation/ is unreachable from either entry point.'],
    ['test/indexing/semantic/providers/typescript/typeScriptSemanticProvider.test.ts',
        'STALE GOLDEN: "Golden Fixtures" expects 8 entities, extraction now yields 0. 16 other cases in this lane pass.'],
    ['test/indexing/semantic/providers/typescript/cp3c_golden.test.ts',
        'STALE GOLDEN: 2 cases (aliased-type resolution, overload hashing) expect a signatureHash format the code no longer emits.'],
    ['test/indexing/semantic/providers/typescript/cp3d_golden.test.ts',
        'STALE GOLDEN: 5 cases expect IMPORTS/EXTENDS/DECLARES/INSTANTIATES to be UNSUPPORTED and land in knownUnknowns; the provider now resolves them.'],
    ['test/indexing/semantic/providers/typescript/resolution/identityDescriptorBuilder.test.ts',
        'STALE GOLDEN: descriptor shape assertion no longer matches what the builder returns.'],
    // Bucket (d): plain `async function runTests()` scripts, no runner integration. They
    // register ZERO tests, so node --test scores the file as 1 passing test purely because
    // the process exited 0 -- green that asserts nothing. Their subjects
    // (src/runtime/blast_radius/, src/runtime/dependencies/) are unreachable anyway.
    ...['runtimeBlastRadiusPhaseA', 'runtimeBlastRadiusPhaseB', 'runtimeBlastRadiusPhaseC',
        'runtimeBlastRadiusPhaseD', 'runtimeBlastRadiusPhaseE', 'runtimeDependencyPhaseA',
        'runtimeDependencyPhaseB', 'runtimeDependencyPhaseC', 'runtimeDependencyPhaseD',
        'runtimeDependencyPhaseE'
    ].map(n => [`test/${n}.test.ts`,
        'ORPHANED + no runner integration: script-style, registers zero tests; subject under src/runtime/blast_radius|dependencies is unreachable.'])
]);

/**
 * The 7 jest suites that genuinely fail, excluded from the jest lane so the other 31 can
 * gate CI. These are NOT flaky: three consecutive runs produced byte-identical results
 * (14 failed / 186 passed / 200 total, same 7 suites every time).
 *
 * The old ci.yml comment blamed "jest-worker resource contention" and quoted 34-41 varying
 * failures. That was measured with jest running ALL 156 test files -- jest.config.js still
 * has testMatch '**\/*.test.ts' and a node:test shim, so a bare `npx jest` drags 118
 * non-jest files through jest workers. Scoped to the files that actually use jest, the run
 * takes ~25s and is deterministic. Use `npm run test:jest`, not bare `npx jest`.
 */
const JEST_EXCLUDED = new Map([
    ['context/typeScriptProjectContext.test.ts',
        'Mock defect: "TypeError: Cannot redefine property: createProgram" -- the ts.createProgram spy cannot be installed twice.'],
    ['coverage/coverage_integration.test.ts',
        'Schema drift: "no such table: coverage_history" -- fixture predates the current store schema.'],
    ['coverage/testCoverage.test.ts',
        'Schema drift: coverage risk query fails on the current schema.'],
    ['e2e/repositoryBrainE2E.test.ts',
        'Schema drift: "no such column: cx.target_entity_type" across all 4 T0-T3 stages.'],
    ['hotspots/knowledgeHotspot.test.ts',
        'Worker crash: "Jest worker encountered 4 child process exceptions, exceeding retry limit" -- suite never runs.'],
    ['test/repositorySimulation.test.ts',
        'Schema drift: "no such column: e.entity_type" across all 5 T0-T4 stages.'],
    ['validity/knowledgeValidity.test.ts',
        'Schema drift: validity scores resolve undefined against the current schema.']
]);

/**
 * Reproduce the jest file count:
 *   grep -lE '@jest/globals|jest\.mock\(' -r src --include='*.test.ts' | wc -l
 *
 * These cannot run under node:test (verified: 38 of 38 fail, 0 pass) and cannot join a
 * mocha run either -- importing @jest/globals outside jest throws at LOAD and aborts
 * mocha's entire run, not just that file. Hence a dedicated lane.
 */
const JEST_MARKER = /@jest\/globals|jest\.mock\(/;
const NODE_TEST_IMPORT = /^import .* from 'node:test'|require\('node:test'\)/m;
const VSCODE_IMPORT = /^import .* from 'vscode'/m;
const TDD_STYLE = /^\s*suite\s*\(/m;
const BDD_STYLE = /^\s*describe\s*\(/m;

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, out); }
        else if (e.name.endsWith('.test.ts')) { out.push(p); }
    }
    return out;
}

function classify(text) {
    // Order matters. jest and vscode are checked first because a file can legitimately
    // also contain suite()/describe() and would otherwise be misrouted into a lane whose
    // runner cannot load it.
    if (JEST_MARKER.test(text)) { return 'jest'; }
    if (VSCODE_IMPORT.test(text)) { return 'edh'; }
    if (NODE_TEST_IMPORT.test(text)) { return 'node'; }
    if (TDD_STYLE.test(text)) { return 'mocha-tdd'; }
    if (BDD_STYLE.test(text)) { return 'mocha-bdd'; }
    return 'script';
}

const buckets = { node: [], 'mocha-tdd': [], 'mocha-bdd': [], jest: [], edh: [], script: [] };
const excludedSeen = [];

for (const abs of walk(SRC).sort()) {
    const rel = path.relative(SRC, abs).split(path.sep).join('/');
    const lane = classify(fs.readFileSync(abs, 'utf8'));
    if (EXCLUDED.has(rel)) { excludedSeen.push([rel, lane, EXCLUDED.get(rel)]); continue; }
    if (lane === 'jest' && JEST_EXCLUDED.has(rel)) {
        excludedSeen.push([rel, lane, JEST_EXCLUDED.get(rel)]);
        continue;
    }
    buckets[lane].push(rel);
}

const toOut = rel => path.join('out', rel.replace(/\.ts$/, '.js')).split(path.sep).join('/');

const mode = process.argv[2] || 'list';

if (mode === 'list') {
    const total = walk(SRC).length;
    const where = {
        node: 'RUNS in `npm run test:unit`',
        'mocha-tdd': 'RUNS in `npm run test:unit`',
        'mocha-bdd': 'RUNS in `npm run test:unit`',
        jest: 'RUNS in `npm run test:jest`',
        edh: 'RUNS in `npm run test:edh` (real VS Code)',
        script: 'NOT RUN'
    };
    console.log(`${total} test files under src/\n`);
    for (const [lane, files] of Object.entries(buckets)) {
        console.log(`${lane.padEnd(10)} ${String(files.length).padStart(3)}  ${where[lane]}`);
    }
    console.log(`excluded   ${String(excludedSeen.length).padStart(3)}  NOT RUN (named below)\n`);
    const ciTotal = buckets.node.length + buckets['mocha-tdd'].length
        + buckets['mocha-bdd'].length + buckets.jest.length;
    console.log(`=> ${ciTotal} files run headless in CI, +${buckets.edh.length} in the Extension Host lane.\n`);
    console.log('Excluded, with reasons:');
    for (const [rel, lane, why] of excludedSeen) { console.log(`  [${lane}] ${rel}\n      ${why}`); }
    process.exit(0);
}

const files = buckets[mode];
if (!files) {
    console.error(`Unknown mode "${mode}". Use: node | mocha-tdd | mocha-bdd | jest | list`);
    process.exit(2);
}

// jest runs the TypeScript sources through ts-jest, not the compiled output. Explicit
// paths rather than jest.config.js's testMatch, which would also drag in the 118 non-jest
// files via the node:test shim -- the original cause of the "flaky jest" reputation.
if (mode === 'jest') {
    const jestBin = path.join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');
    if (!fs.existsSync(jestBin)) {
        console.error(`[run-tests] jest not found at ${jestBin} -- run \`npm ci\`.`);
        process.exit(1);
    }
    console.log(`[run-tests] jest: ${files.length} file(s)`);
    const jr = spawnSync(
        process.execPath,
        [jestBin, '--runTestsByPath', ...files.map(f => 'src/' + f)],
        { cwd: ROOT, stdio: 'inherit', env: process.env }
    );
    process.exit(jr.status === null ? 1 : jr.status);
}

const compiled = files.map(toOut);
const missing = compiled.filter(f => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) {
    console.error(`[run-tests] ${missing.length} compiled file(s) missing, e.g. ${missing[0]} -- run \`npm run compile\` first.`);
    process.exit(1);
}

console.log(`[run-tests] ${mode}: ${compiled.length} file(s)`);

let args;
if (mode === 'node') {
    // Process-per-file isolation on purpose: several of these suites open real on-disk
    // stores and set env vars, and sharing one process made results depend on file order.
    args = ['--test', ...compiled];
} else {
    // mocha's JS entry point directly, run by this same node binary. Spawning `npx`/
    // `npx.cmd` instead silently produced NO output and a success exit on Windows, which
    // is the worst possible failure mode for a test runner -- a lane that reports green
    // without running anything. Resolving the bin removes the shell from the path.
    const mochaBin = path.join(ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js');
    if (!fs.existsSync(mochaBin)) {
        console.error(`[run-tests] mocha not found at ${mochaBin} -- run \`npm ci\`.`);
        process.exit(1);
    }
    args = [mochaBin, '--ui', mode === 'mocha-tdd' ? 'tdd' : 'bdd', '--timeout', '20000', ...compiled];
}

const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
process.exit(r.status === null ? 1 : r.status);
