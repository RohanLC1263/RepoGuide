import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LogicalUnitStore } from '../../store/logicalUnitStore';
import { RepositoryContext } from '../../context/repositoryContext';
import * as inferencerModule from '../../ollama/inferencer';
import { buildLLMEvidencePlan, anchorDerivedSubQuestion, expandAnchorsOneHop, filterAnchorsForLayerCoherence } from '../../query/planning/llmEvidencePlanner';
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

test('filterAnchorsForLayerCoherence: file-hint language signal filters out cross-layer anchors', () => {
    const anchors = [
        { symbol: 'CustomizationInterviewAgent', language: 'python' },
        { symbol: 'process_answer', language: 'python' },
        { symbol: 'submitAnswer', language: 'typescript' },
        { symbol: 'retryAnswer', language: 'typescript' }
    ];
    const result = filterAnchorsForLayerCoherence(anchors, ['python', 'python']);
    assert.deepEqual(result, ['CustomizationInterviewAgent', 'process_answer']);
});

test('filterAnchorsForLayerCoherence: no file-hint signal falls back to the anchor pool\'s own majority language', () => {
    const anchors = [
        { symbol: 'CustomizationInterviewAgent', language: 'python' },
        { symbol: 'process_answer', language: 'python' },
        { symbol: 'submitAnswer', language: 'typescript' }
    ];
    const result = filterAnchorsForLayerCoherence(anchors, []);
    assert.deepEqual(result, ['CustomizationInterviewAgent', 'process_answer']);
});

test('filterAnchorsForLayerCoherence: a genuine tie (no file hints, evenly split pool) filters nothing -- no signal, don\'t guess', () => {
    const anchors = [
        { symbol: 'CustomizationInterviewAgent', language: 'python' },
        { symbol: 'process_answer', language: 'python' },
        { symbol: 'submitAnswer', language: 'typescript' },
        { symbol: 'retryAnswer', language: 'typescript' }
    ];
    const result = filterAnchorsForLayerCoherence(anchors, []);
    assert.deepEqual(result.sort(), ['CustomizationInterviewAgent', 'process_answer', 'retryAnswer', 'submitAnswer']);
});

test('filterAnchorsForLayerCoherence: never empties the pool -- if every anchor is the non-dominant language, all are kept', () => {
    // File hints say the dominant layer is Python, but every anchor that
    // actually validated happens to be TypeScript (no internal split to
    // prefer from) -- filtering to zero would leave sub-questions with no
    // anchors at all, worse than keeping a possibly-wrong-layer one.
    const anchors = [
        { symbol: 'submitAnswer', language: 'typescript' },
        { symbol: 'retryAnswer', language: 'typescript' }
    ];
    const result = filterAnchorsForLayerCoherence(anchors, ['python']);
    assert.deepEqual(result, ['submitAnswer', 'retryAnswer']);
});

test('INDUCED FAILURE reproduction: buildLLMEvidencePlan anchors backend sub-questions with backend symbols, not the cross-layer frontend guesses (decomposition anchor cross-layer bug)', async () => {
    const workspaceRoot = await makeTempRepo('llm-evidence-planner-layer-coherence');
    const unitStore = new LogicalUnitStore();
    await unitStore.init(workspaceRoot);
    await unitStore.upsertUnits([
        {
            id: 'app/agents/customization_interview_agent.py::CustomizationInterviewAgent::class::1',
            type: 'class',
            symbol: 'CustomizationInterviewAgent',
            filePath: 'app/agents/customization_interview_agent.py',
            language: 'python',
            startLine: 1,
            endLine: 5,
            content: 'class CustomizationInterviewAgent:\n    def process_answer(self): pass',
            role: 'implementation',
            parseStatus: 'complete',
            extractionMethod: 'tree_sitter',
            metadata: { confidence: 'high' }
        },
        {
            id: 'app/agents/customization_interview_agent.py::process_answer::method::2',
            type: 'method',
            symbol: 'process_answer',
            filePath: 'app/agents/customization_interview_agent.py',
            language: 'python',
            startLine: 2,
            endLine: 2,
            content: 'def process_answer(self): pass',
            role: 'implementation',
            parseStatus: 'complete',
            extractionMethod: 'tree_sitter',
            metadata: { confidence: 'high' }
        },
        {
            id: 'src/pages/InterviewPage.tsx::submitAnswer::function::1',
            type: 'function',
            symbol: 'submitAnswer',
            filePath: 'src/pages/InterviewPage.tsx',
            language: 'typescript',
            startLine: 1,
            endLine: 3,
            content: 'function submitAnswer() {}',
            role: 'implementation',
            parseStatus: 'complete',
            extractionMethod: 'tree_sitter',
            metadata: { confidence: 'high' }
        },
        {
            id: 'src/pages/InterviewPage.tsx::retryAnswer::function::5',
            type: 'function',
            symbol: 'retryAnswer',
            filePath: 'src/pages/InterviewPage.tsx',
            language: 'typescript',
            startLine: 5,
            endLine: 7,
            content: 'function retryAnswer() {}',
            role: 'implementation',
            parseStatus: 'complete',
            extractionMethod: 'tree_sitter',
            metadata: { confidence: 'high' }
        }
    ]);

    // The master query is about the backend interview flow; the planner
    // (simulated here) guesses a mix of real backend AND real frontend
    // symbol names across its tasks, but its file hints consistently point
    // at the backend file -- exactly the real, live-observed shape of the
    // bug (a full-stack-sounding question whose anchor pool spans both
    // layers, with the file hints as the disambiguating signal).
    const masterQuery = 'Walk me through the backend interview answer processing flow: submission, validation, retries, and where session state lives.';
    const plan = await withMockedPlannerResponse(
        {
            queryType: 'architecture_analysis',
            retrievalTasks: [
                { id: 'task_1', description: 'Identify the class that handles interview answers.', symbolHints: ['CustomizationInterviewAgent'], fileHints: ['app/agents/customization_interview_agent.py'], requiredEvidence: [] },
                { id: 'task_2', description: 'Determine how a submitted answer is processed.', symbolHints: ['process_answer'], fileHints: ['app/agents/customization_interview_agent.py'], requiredEvidence: [] },
                { id: 'task_3', description: 'Analyze how the client submits an answer.', symbolHints: ['submitAnswer'], fileHints: [], requiredEvidence: [] },
                { id: 'task_4', description: 'Find the retry mechanism for a failed answer.', symbolHints: ['retryAnswer'], fileHints: [], requiredEvidence: [] }
            ],
            fileScope: 'both',
            constraints: [],
            subQuestions: []
        },
        () => buildLLMEvidencePlan(fakeContext(workspaceRoot), masterQuery, 'test-model', [], unitStore)
    );

    assert.ok(plan.subQuestions && plan.subQuestions.length >= 2, 'derivation should have fired on 4 tasks');
    for (const sub of plan.subQuestions!) {
        assert.ok(!sub.includes('submitAnswer'), `cross-layer frontend anchor leaked into: ${sub}`);
        assert.ok(!sub.includes('retryAnswer'), `cross-layer frontend anchor leaked into: ${sub}`);
    }
    assert.ok(plan.subQuestions!.some(sub => sub.includes('CustomizationInterviewAgent') || sub.includes('process_answer')), 'expected the coherent backend anchor(s) to still be present');
    assert.ok(plan.diagnostics.some(d => d.includes('cross-layer anchor')), 'expected a diagnostic disclosing the dropped cross-layer anchors');
});
