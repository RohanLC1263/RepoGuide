import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { walkFiles } from '../indexing/fileWalker';
import { extractLogicalUnitsFromFile } from '../indexing/logicalUnitExtractor';
import { LogicalUnitStore } from '../store/logicalUnitStore';

const pythonFixturePath = path.resolve(__dirname, '../../src/test/fixtures/logical_units_python_core.py');
const tsFixturePath = path.resolve(__dirname, '../../src/test/fixtures/logical_units_typescript_core.ts');

test('LogicalUnitStore preserves full content and survives re-init', async () => {
    const repoRoot = await makeTempRepo('logical-unit-store-preserve');
    const sourcePath = path.join(repoRoot, 'src', 'app.py');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.copyFile(pythonFixturePath, sourcePath);

    const units = await extractLogicalUnitsFromFile('src/app.py', repoRoot);
    const processUnit = units.find(unit => unit.type === 'function' && unit.symbol === 'process_items');
    assert.ok(processUnit);
    assert.ok(processUnit.endLine - processUnit.startLine + 1 > 180);

    const store = new LogicalUnitStore();
    await store.init(repoRoot);
    await store.upsertUnits(units);

    const stored = await store.getUnit(processUnit.id);
    assert.ok(stored);
    assert.equal(stored.content, processUnit.content);
    assert.match(stored.content, /return \["final-fallback"\]/);
    assert.ok(stored.content.split(/\r?\n/).length > 180);

    const reopened = new LogicalUnitStore();
    await reopened.init(repoRoot);
    const reopenedUnit = await reopened.getUnit(processUnit.id);
    assert.ok(reopenedUnit);
    assert.equal(reopenedUnit.content, processUnit.content);
});

test('LogicalUnitStore deleteFile removes every unit for a file', async () => {
    const repoRoot = await makeTempRepo('logical-unit-store-delete');
    const sourcePath = path.join(repoRoot, 'src', 'app.py');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.copyFile(pythonFixturePath, sourcePath);

    const units = await extractLogicalUnitsFromFile('src/app.py', repoRoot);
    const store = new LogicalUnitStore();
    await store.init(repoRoot);
    await store.upsertUnits(units);
    assert.ok((await store.getUnitsByFile('src/app.py')).length > 0);

    await store.deleteFile('src/app.py');
    assert.equal((await store.getUnitsByFile('src/app.py')).length, 0);
});

test('LogicalUnitStore preserves the real casing of a mixed-case filePath in the stored value (case-mismatch regression)', async () => {
    // Reproduces the confirmed bug (see docs/engineering-log/HALLUCINATION_INVESTIGATION_REPORT.md /
    // CHANGELOG.md "Fixed"): filePath was being lowercased at write time, silently
    // diverging the stored value from `id` (built from the real, un-folded path) for
    // any file whose real path contains uppercase letters -- corrupting citations on
    // case-sensitive filesystems.
    const repoRoot = await makeTempRepo('logical-unit-store-casing');
    const store = new LogicalUnitStore();
    await store.init(repoRoot);

    const unit = {
        id: 'src/MyComponent.tsx::Widget::class::1',
        type: 'class' as const,
        symbol: 'Widget',
        filePath: 'src/MyComponent.tsx',
        language: 'typescript',
        startLine: 1,
        endLine: 10,
        content: 'class Widget {}',
        role: 'implementation' as const,
        parseStatus: 'complete' as const,
        extractionMethod: 'tree_sitter' as const,
        metadata: { confidence: 'high' as const }
    };
    await store.upsertUnits([unit]);

    // The stored value must retain the real casing, not fold to "src/mycomponent.tsx".
    const stored = await store.getUnit(unit.id);
    assert.ok(stored);
    assert.equal(stored.filePath, 'src/MyComponent.tsx');

    // Lookup must still work case-insensitively even though the stored value isn't folded.
    const byFile = await store.getUnitsByFile('src/mycomponent.tsx');
    assert.equal(byFile.length, 1);
    assert.equal(byFile[0].filePath, 'src/MyComponent.tsx');
});

test('LogicalUnitStore searches by symbol, role, type, and content', async () => {
    const repoRoot = await makeTempRepo('logical-unit-store-search');
    const sourcePath = path.join(repoRoot, 'src', 'service.ts');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.copyFile(tsFixturePath, sourcePath);

    const units = await extractLogicalUnitsFromFile('src/service.ts', repoRoot);
    const store = new LogicalUnitStore();
    await store.init(repoRoot);
    await store.upsertUnits(units);

    const classResults = await store.searchBySymbol('PrimaryService', { types: ['class'] });
    assert.equal(classResults.length, 1);
    assert.equal(classResults[0].type, 'class');

    const methodResults = await store.searchBySymbol('load', { role: 'implementation', types: ['method'] });
    assert.equal(methodResults.length, 1);
    assert.equal(methodResults[0].symbol, 'load');

    const constantByName = await store.searchByContent('CONFIG_TIMEOUT', { limit: 5 });
    assert.ok(constantByName.some(unit => unit.type === 'constant_block'));

    const constantByValue = await store.searchByContent('5000', { limit: 5 });
    assert.ok(constantByValue.some(unit => unit.type === 'constant_block'));
});

test('LogicalUnitStore searchByContent matches on a later term even when the first tokenized word matches nothing (rc-01 regression)', async () => {
    const repoRoot = await makeTempRepo('logical-unit-store-search-later-term');
    const sourcePath = path.join(repoRoot, 'src', 'service.ts');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.copyFile(tsFixturePath, sourcePath);

    const units = await extractLogicalUnitsFromFile('src/service.ts', repoRoot);
    const store = new LogicalUnitStore();
    await store.init(repoRoot);
    await store.upsertUnits(units);

    // "walkthrough" (the first tokenized word) appears nowhere in the fixture.
    // Previously the coarse SQL filter used only terms[0], so this query would
    // return zero rows regardless of "config_timeout" being a real, later match --
    // exactly the shape of rc-01's "What happens when..." question, where the
    // sentence's first significant word was a near-meaningless one.
    const results = await store.searchByContent('walkthrough config_timeout usage', { limit: 5 });
    assert.ok(results.some(unit => unit.type === 'constant_block'));
});

test('LogicalUnitStore indexing pass creates units, suppresses generated files, and stores no truncated units', async () => {
    const repoRoot = await makeTempRepo('logical-unit-store-indexing');
    await fs.mkdir(path.join(repoRoot, 'src'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, 'dist'), { recursive: true });
    await fs.copyFile(pythonFixturePath, path.join(repoRoot, 'src', 'app.py'));
    await fs.copyFile(tsFixturePath, path.join(repoRoot, 'src', 'service.ts'));
    await fs.writeFile(path.join(repoRoot, 'dist', 'generated.py'), 'def generated():\n    return True\n', 'utf8');

    const store = new LogicalUnitStore();
    await store.init(repoRoot);

    const { filePaths } = await walkFiles(repoRoot);
    for (const filePath of filePaths) {
        const units = await extractLogicalUnitsFromFile(filePath, repoRoot);
        if (units.length > 0) {
            await store.upsertUnits(units);
        }
    }

    const indexes = await store.listIndexes();
    assert.ok(indexes.some(unit => unit.filePath === 'src/app.py' && unit.symbol === 'process_items'));
    assert.ok(indexes.some(unit => unit.filePath === 'src/service.ts' && unit.symbol === 'PrimaryService'));
    assert.equal(indexes.some(unit => unit.filePath.includes('dist/')), false);

    const appUnits = await store.getUnitsByFile('src/app.py');
    const processUnit = appUnits.find(unit => unit.type === 'function' && unit.symbol === 'process_items');
    assert.ok(processUnit);
    assert.ok(processUnit.content.includes('return ["final-fallback"]'));
    assert.notEqual(processUnit.content.split(/\r?\n/).length, 50);
    assert.notEqual(processUnit.content.split(/\r?\n/).length, 150);

    const ids = indexes.map(unit => unit.id);
    assert.equal(new Set(ids).size, ids.length);
});

async function makeTempRepo(prefix: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
    await fs.mkdir(path.join(root, '.repoguide'), { recursive: true });
    return root;
}
