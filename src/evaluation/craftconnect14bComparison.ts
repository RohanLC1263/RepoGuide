/**
 * Investigation-only script: re-runs 3 questions from craftconnectRealisticBatch.ts through
 * the same real QueryPipelineHarness pipeline against CraftConnect, but forces the SYNTHESIS
 * stage to use qwen2.5-coder:14b-instruct-q4_K_M instead of the default 7b -- holding
 * retrieval/planning constant (planning uses a separately hardcoded model, unaffected by this
 * patch) to isolate whether answer tone/quality/genericness is a model-capability ceiling or
 * a retrieval-coverage ceiling.
 *
 * Usage: npm run compile && node out/evaluation/craftconnect14bComparison.js
 */
import * as fs from 'fs';
import * as path from 'path';
import * as moduleObj from 'module';

function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = {
        workspace: {
            workspaceFolders: [],
            getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback })
        },
        window: {
            createOutputChannel: () => ({ appendLine: console.log, show: () => undefined, dispose: () => undefined })
        },
        Uri: {
            file: (fsPath: string) => ({ fsPath }),
            joinPath: (base: any, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) })
        }
    };
    moduleObj.Module.prototype.require = function patchedRequire(id: string) {
        if (id === 'vscode') {return shim;}
        return originalRequire.apply(this, arguments as any);
    };
}
installVscodeShim();

// Force the synthesis model to 14b before any real module requires performanceConfig --
// queryDispatcher.ts/inferencer.ts both call getProfile().inferenceModel at call time via
// the shared CommonJS module object, so patching the export here takes effect everywhere.
import * as performanceConfig from '../config/performanceConfig';
const originalGetProfile = performanceConfig.getProfile;
(performanceConfig as any).getProfile = () => ({ ...originalGetProfile(), inferenceModel: 'qwen2.5-coder:14b-instruct-q4_K_M' });

import { QueryPipelineHarness } from './queryPipelineHarness';
import { GoldenQuestion } from './types';

async function main(): Promise<void> {
    const craftconnectPath = process.env.CRAFTCONNECT_PATH ?? 'C:\\Users\\rohan\\Downloads\\CraftConnect';
    const workspaceRoot = path.resolve(craftconnectPath);
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    const outputChannel = { appendLine: (msg: string) => console.log(msg) };

    const harness = new QueryPipelineHarness({ workspaceRoot, repoguideDir, outputChannel: outputChannel as any });
    await harness.init();

    const questions: Array<{ id: string; type: GoldenQuestion['type']; question: string }> = [
        { id: 'rc-08-flag-threshold-14b', type: 'uncertainty', question: "What does FLAG_THRESHOLD control in this codebase, and where does its value actually get read and enforced?" },
        { id: 'rc-05-request-id-14b', type: 'explanation', question: "The ObservabilityMiddleware sets an X-Request-ID for every request. Is that request ID used anywhere else in the codebase beyond logging, or does it just get logged and discarded?" },
        { id: 'rc-10-orchestrator-vs-orchestrator-14b', type: 'orientation', question: "What's the actual difference between app/orchestrator/ and app/agents/mission_orchestrator.py -- which one runs in production?" }
    ];

    const runs: any[] = [];
    for (const q of questions) {
        console.log(`\n=== Running [${q.id}] (14b synthesis) ===`);
        const golden: GoldenQuestion = { id: q.id, type: q.type, question: q.question, expectedAnswer: '', requiresLocations: false };
        const startedAt = Date.now();
        try {
            const { output } = await harness.runQuestion(golden);
            const elapsedMs = Date.now() - startedAt;
            runs.push({
                id: q.id,
                answer: output.answer,
                citedFiles: output.capturedContext.citedFiles,
                answerGate: output.telemetry?.answerGate ? {
                    outcome: output.telemetry.answerGate.outcome,
                    diagnostics: output.telemetry.answerGate.diagnostics
                } : null,
                elapsedMs
            });
            console.log(`Answer (${output.answer.length} chars, ${elapsedMs}ms):`);
            console.log(output.answer);
            console.log(`Gate: ${output.telemetry?.answerGate?.outcome ?? 'n/a'}`);
        } catch (error) {
            runs.push({ id: q.id, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
            console.log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const outPath = path.join(process.cwd(), 'craftconnect-14b-comparison-raw.json');
    fs.writeFileSync(outPath, JSON.stringify({ runs }, null, 2), 'utf8');
    console.log(`\nRaw results written to ${outPath}`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
