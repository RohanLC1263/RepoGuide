import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LogicalUnitStore } from '../../store/logicalUnitStore';
import { RepositoryContext } from '../../context/repositoryContext';
import * as inferencerModule from '../../ollama/inferencer';
import { buildLLMEvidencePlan } from '../../query/planning/llmEvidencePlanner';
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
