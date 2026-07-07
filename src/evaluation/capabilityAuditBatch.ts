/**
 * Fresh, previously-unused-territory batch for a comprehensive capability audit
 * (investigation-only, no production code modified): targets the interview
 * flow (app/routers/interview.py, CustomizationInterviewAgent), which no prior
 * rc- or fc- batch this session touched, so results reflect the CURRENT
 * pipeline's real behavior on genuinely fresh questions, not a repeat of
 * already-tuned-against material. Ground truth for every question was verified
 * against CraftConnect's real source before this script was written.
 *
 * Usage: npm run compile && node out/evaluation/capabilityAuditBatch.js
 */
import * as fs from 'fs';
import * as path from 'path';
import * as moduleObj from 'module';

function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = {
        workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
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

const QUESTIONS: Array<{ id: string; type: GoldenQuestion['type']; category: string; question: string }> = [
    { id: 'audit-01-confidence-threshold', category: 'simple-factual (trap: docstring vs enforced value)', type: 'uncertainty', question: "What confidence threshold triggers a retry (rather than proceeding) for a submitted interview answer, and where is that threshold actually enforced in the code?" },
    { id: 'audit-02-which-agent', category: 'simple-factual', type: 'orientation', question: "Which agent class actually handles interview answers submitted through the /interview routes?" },
    { id: 'audit-03-submit-flow', category: 'flow-tracing', type: 'flow', question: "Walk me through what happens when a user submits an interview answer via POST /interview/submit-answer, from receiving the audio file to what's returned to the client." },
    { id: 'audit-04-retry-flow', category: 'flow-tracing', type: 'flow', question: "If a submitted interview answer's transcription confidence is too low, what happens -- does the user get to retry, and does anything get saved to the database in that case?" },
    { id: 'audit-05-full-interview-walkthrough', category: 'complex-architectural (decomposition candidate)', type: 'explanation', question: "Walk me through the complete interview flow in this codebase: initializing a session, submitting and validating each answer, handling low-confidence retries, and completing the interview -- which agents and services are involved at each step, and where does session state actually live?" },
    { id: 'audit-06-deployment-negative', category: 'honest-negative (partial truth trap)', type: 'uncertainty', question: "Does this codebase have Kubernetes deployment configuration, or does it deploy some other way?" },
    { id: 'audit-07-message-queue-negative', category: 'honest-negative', type: 'uncertainty', question: "Does this codebase use Kafka, RabbitMQ, Celery, or any other message queue?" },
    { id: 'audit-08-graphql-negative-control', category: 'honest-negative (repeat control)', type: 'uncertainty', question: "Does CraftConnect expose a GraphQL API anywhere in the codebase?" }
];

async function main(): Promise<void> {
    const craftconnectPath = process.env.CRAFTCONNECT_PATH ?? 'C:\\Users\\rohan\\Downloads\\CraftConnect';
    const workspaceRoot = path.resolve(craftconnectPath);
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    const outputChannel = { appendLine: (msg: string) => console.log(msg) };

    const runs: any[] = [];
    for (const q of QUESTIONS) {
        console.log(`\n=== Running [${q.id}] (${q.category}) ===`);
        const harness = new QueryPipelineHarness({ workspaceRoot, repoguideDir, outputChannel: outputChannel as any });
        await harness.init();
        const golden: GoldenQuestion = { id: q.id, type: q.type, question: q.question, expectedAnswer: '', requiresLocations: false };
        const startedAt = Date.now();
        try {
            const { output } = await harness.runQuestion(golden);
            const elapsedMs = Date.now() - startedAt;
            runs.push({
                id: q.id,
                category: q.category,
                question: q.question,
                answer: output.answer,
                gate: output.telemetry?.answerGate?.outcome,
                gateDiagnostics: output.telemetry?.answerGate?.diagnostics,
                decomposition: output.telemetry?.decomposition,
                elapsedMs
            });
            console.log(`[${q.id}] gate=${output.telemetry?.answerGate?.outcome} decomposed=${!!output.telemetry?.decomposition} len=${output.answer.length} in ${Math.round(elapsedMs / 1000)}s`);
        } catch (error) {
            runs.push({ id: q.id, category: q.category, question: q.question, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
            console.log(`[${q.id}] ERROR: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const outPath = path.join(process.cwd(), 'capability-audit-batch-raw.json');
    fs.writeFileSync(outPath, JSON.stringify({ runs }, null, 2), 'utf8');
    console.log(`\nRaw results written to ${outPath}`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
