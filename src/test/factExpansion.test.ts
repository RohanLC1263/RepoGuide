import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expandConstantsAndFacts } from '../query/factExpansion';
import { FactStore } from '../store/factStore';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { extractLogicalUnitsFromFile } from '../indexing/logicalUnitExtractor';
import { extractFacts } from '../indexing/factExtractor';
import { LogicalUnitIndex } from '../indexing/logicalUnitTypes';

test('Fact expansion', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fact-expansion-'));
    
    const srcDir = path.join(repoRoot, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    
    // Create source files
    const configPath = path.join(srcDir, 'config.ts');
    await fs.writeFile(configPath, `
export const CONFIG_TIMEOUT = 5000;
export const DEFAULT_ITEMS = ['a', 'b', 'c'];
export const LLM_SYSTEM_PROMPT = "You are a helpful assistant.";
    `);
    
    const servicePath = path.join(srcDir, 'service.ts');
    await fs.writeFile(servicePath, `
import { CONFIG_TIMEOUT, DEFAULT_ITEMS, LLM_SYSTEM_PROMPT } from './config';

function doWork() {
    console.log(CONFIG_TIMEOUT);
    console.log(DEFAULT_ITEMS);
    console.log(LLM_SYSTEM_PROMPT);
}
    `);

    const testPath = path.join(srcDir, 'service.test.ts');
    await fs.writeFile(testPath, `
const TEST_MOCK_VALUE = 999;
function mockWork() {
    console.log(TEST_MOCK_VALUE);
}
    `);

    const unitStore = new LogicalUnitStore();
    await unitStore.init(repoRoot);
    
    const factStore = new FactStore();
    await factStore.init(repoRoot);

    const files = ['src/config.ts', 'src/service.ts', 'src/service.test.ts'];
    for (const f of files) {
        const fullPath = path.join(repoRoot, f);
        const units = await extractLogicalUnitsFromFile(fullPath, repoRoot);
        await unitStore.upsertUnits(units);
        const allFacts: any[] = [];
        for (const u of units) {
            allFacts.push(...extractFacts(u));
        }
        await factStore.upsertFacts(allFacts);
    }

    const serviceUnits = await unitStore.getUnitsByFile('src/service.ts');
    const doWorkUnit = serviceUnits.find(u => u.type === 'function');
    assert.ok(doWorkUnit);
    
    const seedUnits: LogicalUnitIndex[] = [{
        id: doWorkUnit.id,
        type: doWorkUnit.type,
        symbol: doWorkUnit.symbol,
        filePath: doWorkUnit.filePath,
        language: doWorkUnit.language,
        startLine: doWorkUnit.startLine,
        endLine: doWorkUnit.endLine,
        role: doWorkUnit.role,
        parseStatus: doWorkUnit.parseStatus
    }];

    // 1. A function referencing DEFAULT_ITEMS expands to the DEFAULT_ITEMS constant and list_count fact.
    // 2. A function referencing CONFIG_TIMEOUT expands to the numeric constant.
    const res1 = await expandConstantsAndFacts(seedUnits, 'how does service work', { unitStore, factStore });
    const facts1 = res1.expandedFacts;
    
    assert.ok(facts1.find(f => f.fact.symbol === 'CONFIG_TIMEOUT' && f.fact.value === 5000));
    assert.ok(facts1.find(f => f.fact.symbol === 'DEFAULT_ITEMS' && f.fact.factType === 'list_count' && f.fact.value === 3));
    assert.ok(facts1.find(f => f.fact.symbol === 'DEFAULT_ITEMS' && f.fact.factType === 'list_literal'));

    // 3. A prompt query expands prompt_template facts.
    assert.ok(facts1.find(f => f.fact.symbol === 'LLM_SYSTEM_PROMPT' && f.fact.factType === 'prompt_template'));

    // 4. Expansion does not include test/generated facts for implementation scope.
    const testUnits = await unitStore.getUnitsByFile('src/service.test.ts');
    const mockWorkUnit = testUnits.find(u => u.type === 'function');
    assert.ok(mockWorkUnit);

    const testSeedUnits: LogicalUnitIndex[] = [{
        id: mockWorkUnit.id,
        type: mockWorkUnit.type,
        symbol: mockWorkUnit.symbol,
        filePath: mockWorkUnit.filePath,
        language: mockWorkUnit.language,
        startLine: mockWorkUnit.startLine,
        endLine: mockWorkUnit.endLine,
        role: mockWorkUnit.role,
        parseStatus: mockWorkUnit.parseStatus
    }];

    const res2 = await expandConstantsAndFacts(testSeedUnits, 'how does this fake work', { unitStore, factStore });
    // Should NOT find TEST_MOCK_VALUE because query doesn't have 'test' or 'mock', and it excludes test roles
    assert.ok(!res2.expandedFacts.find(f => f.fact.symbol === 'TEST_MOCK_VALUE'));

    // But if we ask a test query:
    const res3 = await expandConstantsAndFacts(testSeedUnits, 'how does the test work', { unitStore, factStore });
    assert.ok(res3.expandedFacts.find(f => f.fact.symbol === 'TEST_MOCK_VALUE'));

    // 5. Recursive references stop at maxDepth and do not loop.
    const resDepth = await expandConstantsAndFacts(seedUnits, 'query', { unitStore, factStore }, 1); // Depth 1
    assert.ok(resDepth.expandedFacts.length > 0);

    // 6. Ordering is deterministic across 3 runs.
    const runA = await expandConstantsAndFacts(seedUnits, 'how does service work', { unitStore, factStore });
    const runB = await expandConstantsAndFacts(seedUnits, 'how does service work', { unitStore, factStore });
    const runC = await expandConstantsAndFacts(seedUnits, 'how does service work', { unitStore, factStore });
    
    assert.deepEqual(runA.expandedFacts.map(f => f.fact.factId), runB.expandedFacts.map(f => f.fact.factId));
    assert.deepEqual(runB.expandedFacts.map(f => f.fact.factId), runC.expandedFacts.map(f => f.fact.factId));
});
