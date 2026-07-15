/**
 * Pass 1 hypothesis test for the query-decomposition design (investigation-only,
 * no production code modified): runs ONE complex architecture-walkthrough
 * question single-shot (the baseline -- what a single generation call produces
 * today), then the same question manually decomposed into 4 ordered
 * sub-questions, each through the identical production pipeline
 * (QueryPipelineHarness -> planner -> retrieval -> packet -> synthesize ->
 * AnswerGate). The merge is then done BY HAND in the investigation report and
 * judged against ground truth verified from CraftConnect's real source before
 * this script was written -- the point is to learn whether decomposed+merged is
 * genuinely more useful and still grounded, or just longer, BEFORE building
 * anything.
 *
 * Usage: npm run compile && node out/evaluation/decompositionHypothesisTest.js
 */
import * as fs from 'fs';
import * as path from 'path';
import * as moduleObj from 'module';

function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = {
        workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_k: string, f: unknown) => f }) },
        window: { createOutputChannel: () => ({ appendLine: console.log, show: () => undefined, dispose: () => undefined }) },
        Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (base: any, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }) }
    };
    moduleObj.Module.prototype.require = function patchedRequire(id: string) {
        if (id === 'vscode') {return shim;}
        return originalRequire.apply(this, arguments as any);
    };
}
installVscodeShim();

import { QueryPipelineHarness } from './queryPipelineHarness';
import { GoldenQuestion } from './types';
import { getCraftConnectPath } from './craftconnectPath';

const MASTER = {
    id: 'master-single-shot',
    question: 'Walk me through the complete mission execution pipeline in this codebase: starting from mission_service.execute_mission, which agents run and in what order, how per-agent failures and timeouts are handled, and where the final mission report ends up on disk and in the database.'
};

const SUB_QUESTIONS = [
    { id: 'sub-1-execute-mission', question: 'What does mission_service.execute_mission do step by step, and what happens if the orchestrator raises an exception while running the mission?' },
    { id: 'sub-2-agent-order', question: 'In MissionCoordinator.run_mission, which agents run and in what order?' },
    { id: 'sub-3-agent-failures', question: 'How does MissionCoordinator handle timeouts or failures in individual agents such as the classifier or the RAG retriever during run_mission?' },
    { id: 'sub-4-report-persistence', question: 'After a mission completes, where is the mission report persisted -- which files on disk and which database table and columns?' }
];

async function main(): Promise<void> {
    const workspaceRoot = path.resolve(getCraftConnectPath());
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    const outputChannel = { appendLine: (msg: string) => console.log(msg) };

    const runs: any[] = [];
    for (const q of [MASTER, ...SUB_QUESTIONS]) {
        console.log(`\n=== Running [${q.id}] ===`);
        // Fresh harness per question: each sub-question must stand alone, exactly as
        // the future per-sub-task pipeline calls would -- no conversation-history bleed.
        const harness = new QueryPipelineHarness({ workspaceRoot, repoguideDir, outputChannel: outputChannel as any });
        await harness.init();
        const golden: GoldenQuestion = { id: q.id, type: 'flow', question: q.question, expectedAnswer: '', requiresLocations: false };
        const startedAt = Date.now();
        try {
            const { output } = await harness.runQuestion(golden);
            runs.push({
                id: q.id,
                question: q.question,
                answer: output.answer,
                gate: output.telemetry?.answerGate?.outcome,
                gateDiagnostics: output.telemetry?.answerGate?.diagnostics,
                elapsedMs: Date.now() - startedAt
            });
            console.log(`[${q.id}] gate=${output.telemetry?.answerGate?.outcome} len=${output.answer.length} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
        } catch (error) {
            runs.push({ id: q.id, question: q.question, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
            console.log(`[${q.id}] ERROR: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const outPath = path.join(process.cwd(), 'decomposition-hypothesis-raw.json');
    fs.writeFileSync(outPath, JSON.stringify({ runs }, null, 2), 'utf8');
    console.log(`\nRaw results written to ${outPath}`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
