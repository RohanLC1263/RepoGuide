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

test('INDUCED FAILURE reproduction: a numeric field inside a React state-setter\'s object argument is not emitted as numeric_threshold (useState-collision v2)', () => {
    // Real shape from CraftConnect's StudioContext.tsx:382 -- a fallback
    // MissionReport object built inline and passed to setMissionReport(), with
    // confidence_score: 0 as a placeholder field, not a real configurable
    // threshold. AnswerGate's stale-vs-live contradiction check (see
    // answerGate.contentVerification.test.ts) treats every numeric_threshold
    // fact as a competing "real" value for its symbol -- previously, this UI
    // placeholder collided with any unrelated claim mentioning "confidence"
    // and "score" nearby.
    const tsxCode = `
function useMissionReport() {
    const [missionReport, setMissionReport] = useState(null);
    function onStatus() {
        setMissionReport({
            mission_id: missionId,
            confidence_score: 0,
            decision_type: 'PENDING',
        });
    }
}
`;
    const unit: LogicalUnit = {
        id: 'tsx:1',
        type: 'function',
        symbol: 'useMissionReport',
        filePath: 'src/contexts/StudioContext.tsx',
        language: 'typescript',
        startLine: 1,
        endLine: 12,
        content: tsxCode,
        role: 'implementation',
        parseStatus: 'complete',
        extractionMethod: 'tree_sitter',
        metadata: { confidence: 'high' }
    };

    const facts = extractFacts(unit);
    const thresholdFact = facts.find(f => f.factType === 'numeric_threshold' && f.symbol === 'confidence_score');
    assert.equal(thresholdFact, undefined, `expected no numeric_threshold fact for a React setter's object field, got: ${JSON.stringify(thresholdFact)}`);
});

test('INDUCED FAILURE reproduction: a numeric field inside a useState(...) object initializer is not emitted as numeric_threshold', () => {
    const tsxCode = `
function useConfidence() {
    const [state, setState] = useState({ confidence_score: 0.5, ready: false });
}
`;
    const unit: LogicalUnit = {
        id: 'tsx:2',
        type: 'function',
        symbol: 'useConfidence',
        filePath: 'src/hooks/useConfidence.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 4,
        content: tsxCode,
        role: 'implementation',
        parseStatus: 'complete',
        extractionMethod: 'tree_sitter',
        metadata: { confidence: 'high' }
    };

    const facts = extractFacts(unit);
    const thresholdFact = facts.find(f => f.factType === 'numeric_threshold' && f.symbol === 'confidence_score');
    assert.equal(thresholdFact, undefined, `expected no numeric_threshold fact for a useState() object initializer field, got: ${JSON.stringify(thresholdFact)}`);
});

test('control: a real, non-React numeric threshold in the same file is still extracted normally', () => {
    // The fix must only exclude values nested inside a React hook/setter call
    // -- a real module-level or class-level threshold in the same file (not
    // inside any use*/set* call) must be completely unaffected.
    const tsxCode = `
const CONFIDENCE_THRESHOLD = 0.55;

function useMissionReport() {
    const [missionReport, setMissionReport] = useState(null);
    function onStatus() {
        setMissionReport({
            mission_id: missionId,
            confidence_score: 0,
        });
    }
}
`;
    const unit: LogicalUnit = {
        id: 'tsx:3',
        type: 'constant_block',
        filePath: 'src/contexts/StudioContext.tsx',
        language: 'typescript',
        startLine: 1,
        endLine: 12,
        content: tsxCode,
        role: 'implementation',
        parseStatus: 'complete',
        extractionMethod: 'tree_sitter',
        metadata: { confidence: 'high' }
    };

    const facts = extractFacts(unit);
    assert.ok(facts.find(f => f.factType === 'numeric_threshold' && f.symbol === 'CONFIDENCE_THRESHOLD' && f.value === 0.55), 'real module-level constant must still be extracted');
    assert.equal(facts.find(f => f.factType === 'numeric_threshold' && f.symbol === 'confidence_score'), undefined, 'the React setter field in the same file must still be excluded');
});
