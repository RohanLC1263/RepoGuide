import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyFileRole } from '../indexing/fileRoleClassifier';
import { extractLogicalUnits, extractLogicalUnitsFromFile } from '../indexing/logicalUnitExtractor';

const fixturePath = 'src/test/fixtures/logical_units_python_core.py';
const fixtureAbsolutePath = path.resolve(__dirname, '../../src/test/fixtures/logical_units_python_core.py');
const tsFixturePath = 'src/test/fixtures/logical_units_typescript_core.ts';
const tsFixtureAbsolutePath = path.resolve(__dirname, '../../src/test/fixtures/logical_units_typescript_core.ts');
const jsFixturePath = 'src/test/fixtures/logical_units_javascript_core.js';
const jsFixtureAbsolutePath = path.resolve(__dirname, '../../src/test/fixtures/logical_units_javascript_core.js');
const rbFixturePath = 'src/test/fixtures/logical_units_ruby_core.rb';
const rbFixtureAbsolutePath = path.resolve(__dirname, '../../src/test/fixtures/logical_units_ruby_core.rb');
const goFixturePath = 'src/test/fixtures/logical_units_go_core.go';
const goFixtureAbsolutePath = path.resolve(__dirname, '../../src/test/fixtures/logical_units_go_core.go');

test('extractLogicalUnits extracts complete Python units and blocks without truncation', () => {
    const content = fs.readFileSync(fixtureAbsolutePath, 'utf8');
    const units = extractLogicalUnits(fixturePath, content, 'python');
    const expectedRole = classifyFileRole(fixturePath, content);

    const processUnits = units.filter(unit => unit.type === 'function' && unit.symbol === 'process_items');
    assert.equal(processUnits.length, 1);

    const processUnit = processUnits[0];
    const lines = content.split(/\r?\n/);
    const finalFallbackLine = lines.findIndex(line => line.includes('return ["final-fallback"]')) + 1;
    assert.equal(processUnit.endLine, finalFallbackLine);
    assert.match(processUnit.content, /return \["final-fallback"\]/);
    assert.ok(processUnit.endLine - processUnit.startLine + 1 > 180);
    assert.notEqual(processUnit.endLine - processUnit.startLine + 1, 50);
    assert.notEqual(processUnit.endLine - processUnit.startLine + 1, 150);

    assert.ok(units.some(unit => unit.type === 'class' && unit.symbol === 'Processor'));
    assert.ok(units.filter(unit => unit.type === 'method' && unit.parentSymbol === 'Processor').length >= 2);
    assert.ok(units.some(unit => unit.type === 'function' && unit.symbol === 'load_items' && unit.metadata.isAsync === true));

    const importBlock = units.find(unit => unit.type === 'import_block');
    assert.ok(importBlock);
    assert.match(importBlock.content, /import os/);
    assert.match(importBlock.content, /from pathlib import Path/);

    const defaultItemsBlock = units.find(unit =>
        unit.type === 'constant_block' &&
        unit.metadata.readsSymbols?.includes('DEFAULT_ITEMS')
    );
    assert.ok(defaultItemsBlock);

    const promptUnit = units.find(unit => unit.type === 'prompt_template' && unit.symbol === 'SYSTEM_PROMPT');
    assert.ok(promptUnit);
    assert.match(promptUnit.content, /helpful assistant/);

    const configUnit = units.find(unit => unit.type === 'config_block' && unit.symbol === 'API_TOKEN');
    assert.ok(configUnit);
    assert.match(configUnit.content, /os\.environ\.get/);

    assert.ok(units.length > 0);
    for (const unit of units) {
        assert.equal(unit.role, expectedRole);
        assert.equal(unit.extractionMethod, 'tree_sitter');
        assert.equal(unit.parseStatus, 'complete');
        assert.equal(unit.filePath, fixturePath);
        assert.ok(!path.isAbsolute(unit.id));
        assert.ok(unit.content.length > 0);
    }
});

test('extractLogicalUnits emits branch sub-units only for large Python functions', () => {
    const content = fs.readFileSync(fixtureAbsolutePath, 'utf8');
    const units = extractLogicalUnits(fixturePath, content, 'python');
    const processUnits = units.filter(unit => unit.type === 'function' && unit.symbol === 'process_items');
    assert.equal(processUnits.length, 1);

    const processUnit = processUnits[0];
    assert.match(processUnit.content, /return \["final-fallback"\]/);

    const processBranches = units.filter(unit => unit.type === 'branch' && unit.parentUnitId === processUnit.id);
    const branchKinds = new Set(processBranches.map(unit => unit.metadata.branchKind));
    for (const expectedKind of ['if', 'try', 'except', 'else', 'finally']) {
        assert.ok(branchKinds.has(expectedKind), `missing ${expectedKind} branch`);
    }

    for (const branch of processBranches) {
        assert.equal(branch.parentUnitId, processUnit.id);
        assert.equal(branch.parentSymbol, 'process_items');
        assert.equal(branch.extractionMethod, processUnit.extractionMethod);
        assert.equal(branch.parseStatus, processUnit.parseStatus);
        assert.ok(branch.startLine >= processUnit.startLine);
        assert.ok(branch.endLine <= processUnit.endLine);
        assert.ok(branch.content.length > 0);
        assertBranchStartsOnBoundary(branch.metadata.branchKind, branch.content);
        assert.doesNotMatch(branch.content.split(/\r?\n/)[0], /marker_|result = \[\]/);
    }

    const shortUnit = units.find(unit => unit.type === 'function' && unit.symbol === 'short_guard');
    assert.ok(shortUnit);
    const shortBranches = units.filter(unit => unit.type === 'branch' && unit.parentUnitId === shortUnit.id);
    assert.equal(shortBranches.length, 0);
});

test('extractLogicalUnitsFromFile reads files and keeps repo-relative ids', async () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const units = await extractLogicalUnitsFromFile(fixturePath, repoRoot);
    const processUnit = units.find(unit => unit.type === 'function' && unit.symbol === 'process_items');

    assert.ok(processUnit);
    assert.equal(processUnit.filePath, fixturePath);
    assert.ok(processUnit.id.startsWith(`${fixturePath}::process_items::function::`));
    assert.ok(!path.isAbsolute(processUnit.id));
});

test('extractLogicalUnits extracts complete TypeScript units, blocks, and large-function branches', () => {
    const content = fs.readFileSync(tsFixtureAbsolutePath, 'utf8');
    const units = extractLogicalUnits(tsFixturePath, content, 'typescript');

    assert.ok(units.some(unit => unit.type === 'class' && unit.symbol === 'PrimaryService'));
    assert.ok(units.some(unit => unit.type === 'class' && unit.symbol === 'SecondaryService'));
    assert.ok(units.filter(unit => unit.type === 'method' && unit.parentSymbol === 'PrimaryService').length >= 5);
    assert.ok(units.some(unit => unit.type === 'method' && unit.symbol === 'load' && unit.metadata.isAsync === true));
    assert.ok(units.some(unit => unit.type === 'function' && unit.symbol === 'exportedHelper' && unit.metadata.isExported === true));
    assert.ok(units.some(unit => unit.type === 'function' && unit.symbol === 'arrowHelper' && unit.metadata.isAsync === true));

    const constantBlock = units.find(unit =>
        unit.type === 'constant_block' &&
        unit.metadata.readsSymbols?.includes('CONFIG_TIMEOUT')
    );
    assert.ok(constantBlock);

    assert.ok(units.some(unit => unit.type === 'prompt_template' && unit.symbol === 'SYSTEM_PROMPT'));
    assert.ok(units.some(unit => unit.type === 'config_block' && unit.symbol === 'API_URL'));

    const processUnit = units.find(unit => unit.type === 'function' && unit.symbol === 'processLargeItems');
    assert.ok(processUnit);
    assert.match(processUnit.content, /return result;/);
    assert.ok(processUnit.endLine - processUnit.startLine + 1 > 180);
    assert.notEqual(processUnit.endLine - processUnit.startLine + 1, 50);
    assert.notEqual(processUnit.endLine - processUnit.startLine + 1, 150);

    const branchKinds = new Set(
        units
            .filter(unit => unit.type === 'branch' && unit.parentUnitId === processUnit.id)
            .map(unit => unit.metadata.branchKind)
    );
    for (const expectedKind of ['if', 'else', 'try', 'catch', 'finally']) {
        assert.ok(branchKinds.has(expectedKind), `missing ${expectedKind} branch`);
    }
});

test('extractLogicalUnits extracts JavaScript units with the TS/JS parser path', () => {
    const content = fs.readFileSync(jsFixtureAbsolutePath, 'utf8');
    const units = extractLogicalUnits(jsFixturePath, content, 'javascript');

    assert.ok(units.some(unit => unit.type === 'import_block' && /import fs/.test(unit.content)));
    assert.ok(units.some(unit => unit.type === 'class' && unit.symbol === 'JavaScriptService'));
    assert.ok(units.some(unit => unit.type === 'method' && unit.symbol === 'load' && unit.metadata.isAsync === true));
    assert.ok(units.some(unit => unit.type === 'function' && unit.symbol === 'exportedHelper' && unit.metadata.isExported === true));
    assert.ok(units.some(unit => unit.type === 'function' && unit.symbol === 'arrowHelper'));
    assert.ok(units.some(unit => unit.type === 'prompt_template' && unit.symbol === 'SYSTEM_PROMPT'));
    assert.ok(units.some(unit => unit.type === 'config_block' && unit.symbol === 'API_URL'));
    assert.ok(units.some(unit => unit.type === 'method' && unit.symbol === 'run' && unit.parentSymbol === 'publicHandlers'));
});

test('extractLogicalUnits handles malformed Python and TypeScript without throwing', () => {
    assert.doesNotThrow(() => extractLogicalUnits('src/app/broken.py', 'def still_visible(value):\n    return value\nif ', 'python'));
    const malformedPython = extractLogicalUnits('src/app/broken.py', 'def still_visible(value):\n    return value\nif ', 'python');
    assert.ok(malformedPython.length > 0);
    assert.ok(malformedPython.every(unit => unit.parseStatus === 'partial' || unit.parseStatus === 'whole_file_fallback'));

    assert.doesNotThrow(() => extractLogicalUnits('src/app/broken.ts', 'export function stillVisible() {\n  if (true) {\n', 'typescript'));
    const malformedTs = extractLogicalUnits('src/app/broken.ts', 'export function stillVisible() {\n  if (true) {\n', 'typescript');
    assert.ok(malformedTs.length > 0);
    assert.ok(malformedTs.every(unit => unit.parseStatus === 'partial' || unit.parseStatus === 'whole_file_fallback'));
});

test('extractLogicalUnits uses safe regex for unsupported source languages', () => {
    const rubyContent = fs.readFileSync(rbFixtureAbsolutePath, 'utf8');
    const rubyUnits = extractLogicalUnits(rbFixturePath, rubyContent, 'ruby');
    assert.ok(rubyUnits.some(unit => unit.type === 'class' && unit.symbol === 'RubyWorker' && unit.extractionMethod === 'regex'));
    assert.ok(rubyUnits.some(unit => unit.type === 'function' && unit.symbol === 'top_level_task' && unit.extractionMethod === 'regex'));

    const goContent = fs.readFileSync(goFixtureAbsolutePath, 'utf8');
    const goUnits = extractLogicalUnits(goFixturePath, goContent, 'go');
    assert.ok(goUnits.some(unit => unit.type === 'function' && unit.symbol === 'ProcessItem' && unit.extractionMethod === 'regex'));
    assert.ok(goUnits.some(unit => unit.type === 'class' && unit.symbol === 'GoWorker' && unit.extractionMethod === 'regex'));
});

test('extractLogicalUnits suppresses binary and generated files and avoids noisy non-source fallback', () => {
    assert.deepEqual(extractLogicalUnits('src/app/binary.py', 'abc\u0000def', 'python'), []);
    assert.deepEqual(extractLogicalUnits('dist/generated.py', 'def generated():\n    return True\n', 'python'), []);
    assert.deepEqual(extractLogicalUnits('README.md', '# Plain docs\nNothing structured here.\n', 'markdown'), []);

    const configUnits = extractLogicalUnits('.env.example', 'API_URL=http://localhost\n', 'unknown');
    assert.ok(configUnits.some(unit => unit.type === 'config_block'));
});

test('extractLogicalUnitsFromFile rejects missing and outside-root files', async () => {
    const repoRoot = path.resolve(__dirname, '../..');
    assert.deepEqual(await extractLogicalUnitsFromFile('src/test/fixtures/missing.py', repoRoot), []);
    assert.deepEqual(await extractLogicalUnitsFromFile(path.resolve(repoRoot, '..', 'outside.py'), repoRoot), []);
});

test('extractLogicalUnitsFromFile supports absolute paths and unsupported language detection', async () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const units = await extractLogicalUnitsFromFile(rbFixtureAbsolutePath, repoRoot);
    const rubyFunction = units.find(unit => unit.type === 'function' && unit.symbol === 'top_level_task');
    assert.ok(rubyFunction);
    assert.equal(rubyFunction.filePath, rbFixturePath);
    assert.ok(rubyFunction.id.startsWith(`${rbFixturePath}::top_level_task::function::`));
    assert.ok(!path.isAbsolute(rubyFunction.id));
});

test('extractLogicalUnits returns deterministic ordering and unique ids for repeated symbols', () => {
    const content = [
        'class Alpha {',
        '  run() { return 1; }',
        '}',
        'class Beta {',
        '  run() { return 2; }',
        '}',
        'function run() { return 3; }'
    ].join('\n');
    const first = extractLogicalUnits('src/app/repeated.ts', content, 'typescript');
    const second = extractLogicalUnits('src/app/repeated.ts', content, 'typescript');
    assert.deepEqual(first.map(unit => unit.id), second.map(unit => unit.id));
    assert.equal(new Set(first.map(unit => unit.id)).size, first.length);
    assert.ok(first.some(unit => unit.type === 'method' && unit.symbol === 'run' && unit.parentSymbol === 'Alpha'));
    assert.ok(first.some(unit => unit.type === 'method' && unit.symbol === 'run' && unit.parentSymbol === 'Beta'));
    assert.ok(first.some(unit => unit.type === 'function' && unit.symbol === 'run'));
});

function assertBranchStartsOnBoundary(branchKind: string | undefined, content: string): void {
    const firstLine = content.split(/\r?\n/)[0].trim();
    switch (branchKind) {
        case 'if':
            assert.match(firstLine, /^if\b/);
            break;
        case 'try':
            assert.match(firstLine, /^try:/);
            break;
        case 'except':
            assert.match(firstLine, /^except\b/);
            break;
        case 'else':
            assert.match(firstLine, /^else:/);
            break;
        case 'finally':
            assert.match(firstLine, /^finally:/);
            break;
        default:
            break;
    }
}
