import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LogicalUnitStore } from '../../store/logicalUnitStore';
import { RepositoryContext } from '../../context/repositoryContext';
import * as inferencerModule from '../../ollama/inferencer';
import { buildLLMEvidencePlan, anchorDerivedSubQuestion, expandAnchorsOneHop } from '../../query/planning/llmEvidencePlanner';
import { EvidencePlan } from '../../query/evidencePlanTypes';

async function makeTempRepo(prefix: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
    await fs.mkdir(path.join(root, '.repoguide'), { recursive: true });
    return root;
}

function fakeContext(workspaceRoot: string): RepositoryContext {
    return {
        workspaceRoot,
        getConfig: <T,>(_key: string, defaultValue?: T) => defaultValue as T,
        asRelativePath: (p: string) => p,
        logger: {
            appendLine: () => undefined, debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined,
            stageStart: () => undefined, stageProgress: () => undefined, stageComplete: () => undefined, stageFailed: () => undefined,
            artifactWritten: () => undefined, queryLog: () => undefined, repairLog: () => undefined
        },
        notifyInfo: async () => undefined, notifyWarning: async () => undefined, notifyError: async () => undefined
    };
}

/** Replaces streamChat with a canned response for the duration of one test, restoring
 * the original afterward -- avoids a real Ollama call for a unit test that only cares
 * about how buildLLMEvidencePlan handles the parsed JSON, not model behavior itself. */
function withMockedPlannerResponse(jsonJson: object, fn: () => Promise<EvidencePlan>): Promise<EvidencePlan> {
    const original = inferencerModule.streamChat;
    (inferencerModule as any).streamChat = async function* mockStreamChat() {
        yield JSON.stringify(jsonJson);
    };
    return fn().finally(() => {
        (inferencerModule as any).streamChat = original;
    });
}

test('buildLLMEvidencePlan discards a fabricated symbol/file hint and logs a diagnostic, keeping a real one', async () => {
    const workspaceRoot = await makeTempRepo('llm-evidence-planner');
    const unitStore = new LogicalUnitStore();
    await unitStore.init(workspaceRoot);
    await unitStore.upsertUnits([{
        id: 'src/real.ts::RealFunction::function::1',
        type: 'function',
        symbol: 'RealFunction',
        filePath: 'src/real.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 3,
        content: 'function RealFunction() {}',
        role: 'implementation',
        parseStatus: 'complete',
        extractionMethod: 'tree_sitter',
        metadata: { confidence: 'high' }
    }]);

    const plan = await withMockedPlannerResponse(
        {
            queryType: 'architecture_analysis',
            retrievalTasks: [{
                id: 'task_1',
                description: 'test',
                symbolHints: ['RealFunction', 'FabricatedSymbolThatDoesNotExist'],
                fileHints: ['src/real.ts', 'fake/path/DoesNotExist.java'],
                requiredEvidence: []
            }],
            fileScope: 'both',
            constraints: []
        },
        () => buildLLMEvidencePlan(fakeContext(workspaceRoot), 'a test question', 'test-model', [], unitStore)
    );

    assert.ok(plan.symbolHints.includes('RealFunction'));
    assert.ok(!plan.symbolHints.includes('FabricatedSymbolThatDoesNotExist'));
    assert.ok(plan.fileHints.includes('src/real.ts'));
    assert.ok(!plan.fileHints.includes('fake/path/DoesNotExist.java'));

    assert.ok(plan.diagnostics.some(d => d.includes('symbol hint') && d.includes('FabricatedSymbolThatDoesNotExist')));
    assert.ok(plan.diagnostics.some(d => d.includes('file hint') && d.includes('fake/path/DoesNotExist.java')));
});

test('buildLLMEvidencePlan anchors task-derived sub-questions with the master plan\'s validated hints (and only validated ones)', async () => {
    const workspaceRoot = await makeTempRepo('llm-evidence-planner-anchoring');
    const unitStore = new LogicalUnitStore();
    await unitStore.init(workspaceRoot);
    await unitStore.upsertUnits([{
        id: 'src/pipeline.ts::PipelineRunner::class::1',
        type: 'class',
        symbol: 'PipelineRunner',
        filePath: 'src/pipeline.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 10,
        content: 'class PipelineRunner { run() {} }',
        role: 'implementation',
        parseStatus: 'complete',
        extractionMethod: 'tree_sitter',
        metadata: { confidence: 'high' }
    }]);

    const masterQuery = 'Walk me through the pipeline execution end to end: stages, ordering, failure handling, and where results are stored.';
    const plan = await withMockedPlannerResponse(
        {
            queryType: 'architecture_analysis',
            retrievalTasks: [
                // 4 tasks -> derivation fires; PipelineRunner/src/pipeline.ts validate,
                // FakeHandlerThatDoesNotExist does not.
                { id: 'task_1', description: 'Identify the stages of the pipeline execution.', symbolHints: ['PipelineRunner'], fileHints: [], requiredEvidence: [] },
                { id: 'task_2', description: 'Determine the ordering of pipeline stages.', symbolHints: ['FakeHandlerThatDoesNotExist'], fileHints: [], requiredEvidence: [] },
                { id: 'task_3', description: 'Analyze how failure handling works in the pipeline.', symbolHints: [], fileHints: ['src/pipeline.ts'], requiredEvidence: [] },
                { id: 'task_4', description: 'Locate where pipeline results are stored.', symbolHints: [], fileHints: [], requiredEvidence: [] }
            ],
            fileScope: 'both',
            constraints: [],
            subQuestions: []
        },
        () => buildLLMEvidencePlan(fakeContext(workspaceRoot), masterQuery, 'test-model', [], unitStore)
    );

    assert.ok(plan.subQuestions && plan.subQuestions.length >= 2, 'derivation should have fired on 4 tasks');
    for (const sub of plan.subQuestions!) {
        // Every derived sub-question carries the validated anchors in its TEXT,
        // where BM25/vector/regex-hint extraction can all see them...
        assert.match(sub, /\(Focus on: /);
        assert.ok(sub.includes('PipelineRunner'), `missing validated symbol anchor in: ${sub}`);
        assert.ok(sub.includes('src/pipeline.ts'), `missing validated file anchor in: ${sub}`);
        // ...and never a fabricated hint that failed validation.
        assert.ok(!sub.includes('FakeHandlerThatDoesNotExist'), `fabricated hint leaked into: ${sub}`);
    }
});

test('expandAnchorsOneHop reaches a real unit referenced in the anchor\'s content, and never a non-unit token', async () => {
    const workspaceRoot = await makeTempRepo('llm-evidence-planner-expansion');
    const unitStore = new LogicalUnitStore();
    await unitStore.init(workspaceRoot);
    await unitStore.upsertUnits([
        {
            id: 'src/service.py::execute_job::function::1',
            type: 'function',
            symbol: 'execute_job',
            filePath: 'src/service.py',
            language: 'python',
            startLine: 1,
            endLine: 5,
            // Body references run_workflow (a real unit below) and a phantom_helper
            // that is identifier-shaped but resolves to nothing.
            content: 'async def execute_job(job_id):\n    report = await coordinator.run_workflow(job_id)\n    phantom_helper(report)\n    return report',
            role: 'implementation',
            parseStatus: 'complete',
            extractionMethod: 'tree_sitter',
            metadata: { confidence: 'high' }
        },
        {
            id: 'src/coordinator.py::run_workflow::method::10',
            type: 'method',
            symbol: 'run_workflow',
            filePath: 'src/coordinator.py',
            language: 'python',
            startLine: 10,
            endLine: 20,
            content: 'async def run_workflow(self, job_id):\n    return await asyncio.wait_for(self.stage(job_id), timeout=30)',
            role: 'implementation',
            parseStatus: 'complete',
            extractionMethod: 'tree_sitter',
            metadata: { confidence: 'high' }
        }
    ]);

    const expanded = await expandAnchorsOneHop(['execute_job'], unitStore);
    assert.ok(expanded.includes('run_workflow'), `one-hop target missing from: ${JSON.stringify(expanded)}`);
    assert.ok(!expanded.includes('phantom_helper'), 'non-unit token must not become an anchor');
    assert.ok(!expanded.includes('execute_job'), 'the anchor itself must not be re-added');
});

test('anchorDerivedSubQuestion skips anchors already present and returns text unchanged when no anchors survive', () => {
    assert.equal(
        anchorDerivedSubQuestion('How does PipelineRunner order its stages?', ['PipelineRunner'], []),
        'How does PipelineRunner order its stages?'
    );
    assert.equal(
        anchorDerivedSubQuestion('How are failures handled?', ['PipelineRunner'], ['src/pipeline.ts']),
        'How are failures handled? (Focus on: PipelineRunner, src/pipeline.ts)'
    );
});

test('buildLLMEvidencePlan keeps all hints unfiltered when no unitStore is provided (graceful degradation, not silent breakage)', async () => {
    const workspaceRoot = await makeTempRepo('llm-evidence-planner-no-store');

    const plan = await withMockedPlannerResponse(
        {
            queryType: 'architecture_analysis',
            retrievalTasks: [{
                id: 'task_1',
                description: 'test',
                symbolHints: ['AnythingAtAll'],
                fileHints: ['anything/at/all.py'],
                requiredEvidence: []
            }],
            fileScope: 'both',
            constraints: []
        },
        () => buildLLMEvidencePlan(fakeContext(workspaceRoot), 'a test question', 'test-model', [] /* no unitStore */)
    );

    assert.ok(plan.symbolHints.includes('AnythingAtAll'));
    assert.ok(plan.fileHints.includes('anything/at/all.py'));
    assert.ok(!plan.diagnostics.some(d => d.includes('Discarded')));
});
