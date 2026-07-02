import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractFacts } from '../indexing/factExtractor';
import { FactStore } from '../store/factStore';
import { LogicalUnit } from '../indexing/logicalUnitTypes';

test('Fact extraction and storage', async () => {
    const pythonCode = `
class Worker:
    def __init__(self, service):
        self.service = service
        self.timeout = 5.5

    def do_work(self):
        system_prompt = """You are an AI"""
        items = ["a", "b", "c"]
        os.environ.get("OPENAI_API_KEY")
        try:
            return fallback_call()
        except:
            return default_call()
        finally:
            cleanup()
`;

    const tsCode = `
const MAX_RETRIES = 3;
const url = process.env.DATABASE_URL;
const result = fetch() ?? local_cache();
const manager = new DataManager();
`;

    const pyUnit: LogicalUnit = {
        id: 'py:1',
        type: 'class',
        symbol: 'Worker',
        filePath: 'src/worker.py',
        language: 'python',
        startLine: 1,
        endLine: 15,
        content: pythonCode,
        role: 'implementation',
        parseStatus: 'complete',
        extractionMethod: 'tree_sitter',
        metadata: { confidence: 'high' }
    };

    const tsUnit: LogicalUnit = {
        id: 'ts:1',
        type: 'constant_block',
        filePath: 'src/config.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 5,
        content: tsCode,
        role: 'implementation',
        parseStatus: 'complete',
        extractionMethod: 'tree_sitter',
        metadata: { confidence: 'high' }
    };

    const pyFacts = extractFacts(pyUnit);
    const tsFacts = extractFacts(tsUnit);

    // 1. Numeric thresholds
    assert.ok(pyFacts.find(f => f.factType === 'numeric_threshold' && f.value === 5.5));
    assert.ok(tsFacts.find(f => f.factType === 'numeric_threshold' && f.value === 3));
    assert.ok(tsFacts.find(f => f.factType === 'constant' && f.value === 3)); // MAX_RETRIES

    // 2. list_count gets exact length
    const listFact = pyFacts.find(f => f.factType === 'list_count' && f.value === 3);
    assert.ok(listFact, 'Should extract list_count = 3');

    // 3. String and prompt templates
    assert.ok(pyFacts.find(f => f.factType === 'prompt_template' && f.value === 'You are an AI'));
    
    // 4. Env var facts
    assert.ok(pyFacts.find(f => f.factType === 'environment_variable' && f.value === 'OPENAI_API_KEY'));
    assert.ok(tsFacts.find(f => f.factType === 'environment_variable' && f.value === 'DATABASE_URL'));

    // 5. Fallback facts preserve order
    const pyFallback = pyFacts.find(f => f.factType === 'fallback_chain');
    assert.ok(pyFallback);
    assert.deepEqual(pyFallback.value, ['try', 'catch', 'finally']);

    const tsFallback = tsFacts.find(f => f.factType === 'fallback_chain');
    assert.ok(tsFallback);
    assert.deepEqual(tsFallback.value, ['fetch()', 'local_cache()']);

    // 6. DI/Instantiation
    assert.ok(pyFacts.find(f => f.factType === 'dependency_injection' && f.value === 'service'));
    const instantiationFact = tsFacts.find(f => f.factType === 'instantiation');
    assert.ok(instantiationFact);
    assert.deepEqual(instantiationFact.value, { instantiatedClass: 'DataManager', args: [] });

    // 7. Store persists, filters, returns highest confidence
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fact-store-'));
    const store = new FactStore();
    await store.init(repoRoot);

    await store.upsertFacts([...pyFacts, ...tsFacts]);

    const retrieved = await store.findBySymbol('Worker');
    assert.equal(retrieved[0].role, 'implementation'); // Test and generated are preserved from parent unit

    const envVars = await store.findByType('environment_variable');
    assert.equal(envVars.length, 2);

    // 8. Delete by file
    await store.deleteFile('src/worker.py');
    const afterDelete = await store.findByType('environment_variable');
    assert.equal(afterDelete.length, 1);
    assert.equal(afterDelete[0].value, 'DATABASE_URL');
});
