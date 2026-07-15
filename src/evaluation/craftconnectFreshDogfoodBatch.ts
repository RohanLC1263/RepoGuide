/**
 * Investigation-only script (no production code modified): a fresh, independent
 * batch of realistic developer questions against CraftConnect, run against a
 * freshly-verified-healthy index (BM25/Lance/liveness-gate all real and
 * non-zero -- see livenessGateCheck.ts), through the real
 * QueryPipelineHarness/QueryDispatcher/AnswerGate/EvidencePacketBuilder
 * production path.
 *
 * Unlike craftconnectRealisticBatch.ts (rc-01..rc-12, run while the chunk
 * stores were unknowingly empty), this batch is the first real test of every
 * fix from the retrieval-integrity thread working together: planner hint
 * validation, the synthesis-style prompt redesign, all three AnswerGate
 * fixes, reindex atomicity, the liveness gate, and searchByContent's fix.
 * Questions are new (not rc-01..rc-12 reworded), spanning flow-tracing,
 * dead-code/impact, config tracing, cross-file relationships, and honest-
 * negative probes -- each verified against CraftConnect's real source before
 * this script was written, so answer quality can be judged against real
 * ground truth, not guessed at.
 *
 * Usage: npm run compile && node out/evaluation/craftconnectFreshDogfoodBatch.js
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

    const capturedPackets: EvidencePacket[] = [];
    const originalBuildPacket = EvidencePacketBuilder.prototype.buildPacket;
    EvidencePacketBuilder.prototype.buildPacket = async function patchedBuildPacket(this: EvidencePacketBuilder, query: string, plan: any, retrievalResult?: any): Promise<EvidencePacket> {
        const packet = await originalBuildPacket.call(this, query, plan, retrievalResult);
        capturedPackets.push(packet);
        return packet;
    };

    const harness = new QueryPipelineHarness({ workspaceRoot, repoguideDir, outputChannel: outputChannel as any });
    await harness.init();

    const questions: Array<{ id: string; type: GoldenQuestion['type']; question: string }> = [
        { id: 'fc-01-delete-all-missions', type: 'flow', question: "Walk me through what happens when a client calls DELETE /api/missions -- does it remove every mission for that user, and what happens to the uploaded files already on disk?" },
        { id: 'fc-02-seal-lock', type: 'flow', question: "What enforces the lock after a mission is sealed via POST /api/mission/{id}/seal -- can a sealed mission still be edited, and if so how is that prevented or allowed?" },
        { id: 'fc-03-community-engine-dead', type: 'orientation', question: "Is app/core/community_engine.py actually wired into the running app, or is it something else entirely?" },
        { id: 'fc-04-rag-agent-vs-engine', type: 'orientation', question: "What's the real difference between app/agents/rag_retriever_agent.py and app/agents/rag_retrieval_engine.py -- is one of them dead code?" },
        { id: 'fc-05-orchestrator-backup', type: 'orientation', question: "Is app/agents/mission_orchestrator.backup.py still used by anything in the running app?" },
        { id: 'fc-06-redis-usage', type: 'explanation', question: "Does CraftConnect use Redis anywhere, and if so, what is it actually used for?" },
        { id: 'fc-07-jwks-refresh', type: 'uncertainty', question: "What's the JWT/JWKS signing-key refresh mechanism in this codebase, and does it actually run as part of the live app?" },
        { id: 'fc-08-orchestrator-vs-coordinator', type: 'explanation', question: "How does app/main.py's global orchestrator relate to app/agents/orchestrator/mission_coordinator.py -- are they the same thing, competing implementations, or does one wrap the other?" },
        { id: 'fc-09-generate-listing-path', type: 'flow', question: "When studio_write.py's generate_listing_from_interview endpoint runs, does it reach the same orchestrator used for mission creation, or a separate code path?" },
        { id: 'fc-10-graphql-negative', type: 'uncertainty', question: "Does CraftConnect expose a GraphQL API anywhere in the codebase?" },
        { id: 'fc-11-stripe-negative', type: 'uncertainty', question: "Is Stripe or any other payment processor integrated into this codebase?" },
        { id: 'fc-12-websocket-negative', type: 'uncertainty', question: "Does this codebase use WebSockets anywhere for real-time communication?" }
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

    const outPath = path.join(process.cwd(), 'craftconnect-fresh-dogfood-batch-raw.json');
    fs.writeFileSync(outPath, JSON.stringify({ runs }, null, 2), 'utf8');
    console.log(`\nRaw results written to ${outPath}`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
