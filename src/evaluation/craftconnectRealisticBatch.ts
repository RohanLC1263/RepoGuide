/**
 * Investigation-only script (no production code modified): runs a broad, varied batch
 * of realistic developer questions against CraftConnect on the current, fully-landed
 * code (Track 1-3 + Track 4 prompt redesign + all three AnswerGate fixes), via the real
 * QueryPipelineHarness/QueryDispatcher/AnswerGate/EvidencePacketBuilder production path.
 *
 * Unlike hallucinationInvestigation.ts (which re-runs two known fabrication-repro
 * questions), this batch is designed to sample the actual goal -- "does RepoGuide
 * understand this whole project and answer any question a developer asks" -- across
 * question types the corpus hasn't been specifically tuned against: dead-code
 * detection, concurrency/idempotency reasoning, config-value tracing, multi-file
 * synthesis, and honest "I don't know" probes.
 *
 * Usage: npm run compile && node out/evaluation/craftconnectRealisticBatch.js
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

import { QueryPipelineHarness } from './queryPipelineHarness';
import { GoldenQuestion } from './types';
import { EvidencePacketBuilder } from '../query/evidencePacketBuilder';
import { EvidencePacket } from '../query/evidencePacket';
import { getCraftConnectPath } from './craftconnectPath';

async function main(): Promise<void> {
    const craftconnectPath = getCraftConnectPath();
    const workspaceRoot = path.resolve(craftconnectPath);
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    const outputChannel = { appendLine: (msg: string) => console.log(msg) };

    const capturedPackets: Array<{ query: string; coverageScore: number; gaps: string[]; itemCount: number }> = [];
    const originalBuildPacket = EvidencePacketBuilder.prototype.buildPacket;
    EvidencePacketBuilder.prototype.buildPacket = async function patchedBuildPacket(this: EvidencePacketBuilder, query: string, plan: any, retrievalResult?: any): Promise<EvidencePacket> {
        const packet = await originalBuildPacket.call(this, query, plan, retrievalResult);
        capturedPackets.push({
            query,
            coverageScore: packet.coverageScore,
            gaps: packet.gaps,
            itemCount: packet.items.length
        });
        return packet;
    };

    const harness = new QueryPipelineHarness({ workspaceRoot, repoguideDir, outputChannel: outputChannel as any });
    await harness.init();

    const questions: Array<{ id: string; type: GoldenQuestion['type']; question: string }> = [
        { id: 'rc-01-upload-flow', type: 'flow', question: "What happens when a user uploads an image to start a new mission -- walk me through the full request path from HTTP endpoint to database record?" },
        { id: 'rc-02-mission-failure', type: 'explanation', question: "If execute_mission in mission_service.py raises an exception while running the orchestrator, what actually gets stored in the database, and does the user ever see the raw error message?" },
        { id: 'rc-03-dead-code', type: 'orientation', question: "Is app/core/community_engine.py actually used anywhere in the running app, or is it dead code left over from an earlier version?" },
        { id: 'rc-04-ratelimit', type: 'uncertainty', question: "What rate limit does the /api/auth/me endpoint enforce, and what happens when a client exceeds it?" },
        { id: 'rc-05-request-id', type: 'explanation', question: "The ObservabilityMiddleware sets an X-Request-ID for every request. Is that request ID used anywhere else in the codebase beyond logging, or does it just get logged and discarded?" },
        { id: 'rc-06-multilang', type: 'explanation', question: "Why does interview_db.py store its default questions in Hindi and Kannada alongside English -- is this multi-language feature actually reachable from any API endpoint?" },
        { id: 'rc-07-idempotency', type: 'flow', question: "In mission_service.execute_mission, what's the idempotency mechanism, and what happens if two requests for the same mission_id arrive at nearly the same time?" },
        { id: 'rc-08-flag-threshold', type: 'uncertainty', question: "What does FLAG_THRESHOLD control in this codebase, and where does its value actually get read and enforced?" },
        { id: 'rc-09-verify-token', type: 'explanation', question: "Does the /api/auth/verify endpoint's verify_token function do anything beyond what the get_current_user dependency it depends on already does?" },
        { id: 'rc-10-orchestrator-vs-orchestrator', type: 'orientation', question: "What's the actual difference between app/orchestrator/ and app/agents/mission_orchestrator.py -- which one runs in production?" },
        { id: 'rc-11-firestore-or-supabase', type: 'uncertainty', question: "Does CraftConnect use Firestore or Supabase for its database -- or both, and under what conditions does it pick one over the other?" },
        { id: 'rc-12-temp-cleanup', type: 'flow', question: "Trace what happens to the local temp image file after a mission completes in mission_service.py -- is it ever cleaned up?" }
    ];

    const runs: any[] = [];
    for (const q of questions) {
        console.log(`\n=== Running [${q.id}] ===`);
        const golden: GoldenQuestion = {
            id: q.id,
            type: q.type,
            question: q.question,
            expectedAnswer: '',
            requiresLocations: false
        };
        const packetsBefore = capturedPackets.length;
        const startedAt = Date.now();
        try {
            const { output } = await harness.runQuestion(golden);
            const elapsedMs = Date.now() - startedAt;
            const packetsForThisRun = capturedPackets.slice(packetsBefore);
            runs.push({
                id: q.id,
                question: q.question,
                answer: output.answer,
                confidence: output.confidence,
                citedFiles: output.capturedContext.citedFiles,
                topCitedFiles: output.capturedContext.topCitedFiles,
                answerGate: output.telemetry?.answerGate ? {
                    outcome: output.telemetry.answerGate.outcome,
                    diagnostics: output.telemetry.answerGate.diagnostics,
                    unsupportedCount: output.telemetry.answerGate.unsupported_claims.length,
                    supportedCount: output.telemetry.answerGate.supported_claims.length
                } : null,
                packetInfo: packetsForThisRun[0] ?? null,
                elapsedMs
            });
            console.log(`Answer (${output.answer.length} chars, ${elapsedMs}ms):`);
            console.log(output.answer);
            console.log(`Gate: ${output.telemetry?.answerGate?.outcome ?? 'n/a'}`);
        } catch (error) {
            runs.push({
                id: q.id,
                question: q.question,
                error: error instanceof Error ? (error.stack ?? error.message) : String(error)
            });
            console.log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const outPath = path.join(process.cwd(), 'craftconnect-realistic-batch-raw.json');
    fs.writeFileSync(outPath, JSON.stringify({ runs }, null, 2), 'utf8');
    console.log(`\nRaw results written to ${outPath}`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
