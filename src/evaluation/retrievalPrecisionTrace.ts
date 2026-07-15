/**
 * Investigation-only script (Pass 1 diagnosis, no fixes): traces exactly what happens
 * between a query and the final evidence packet for rc-01/rc-04/rc-10 -- which providers
 * get invoked, what search terms/symbol hints the planner extracted, what each retrieval
 * channel found before fusion/trimming, and what actually survives into the final packet.
 * Captures intermediate state via monkey-patching (no production code modified) at three
 * points: the planner's EvidencePlan, HybridRetrievalFusion's raw per-channel results
 * before fusion, and EvidencePacketBuilder's final packet before/after trimToTokenBudget.
 *
 * Usage: npm run compile && node out/evaluation/retrievalPrecisionTrace.js
 */
import * as fs from 'fs';
import * as path from 'path';
import * as moduleObj from 'module';

function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = {
        workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_k: string, f: unknown) => f }) },
        window: { createOutputChannel: () => ({ appendLine: console.log, show: () => undefined, dispose: () => undefined }) }
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
import * as hybridFusionModule from '../query/hybridRetrievalFusion';
import { getCraftConnectPath } from './craftconnectPath';

async function main(): Promise<void> {
    const craftconnectPath = getCraftConnectPath();
    const workspaceRoot = path.resolve(craftconnectPath);
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    const outputChannel = { appendLine: (msg: string) => console.log(msg) };

    // Capture the raw fused assembly (per-channel chunk scores) before EvidencePacketBuilder
    // ever sees it -- this is the state right after retrieveContext() but before trimming.
    const capturedAssemblies: Array<{ query: string; chunks: Array<{ file: string; score: number; startLine: number; endLine: number }> }> = [];
    const originalRetrieveContext = hybridFusionModule.HybridRetrievalFusion.prototype.retrieveContext;
    hybridFusionModule.HybridRetrievalFusion.prototype.retrieveContext = async function patchedRetrieveContext(
        this: InstanceType<typeof hybridFusionModule.HybridRetrievalFusion>,
        question: string,
        seedFiles: string[] = [],
        preferredAnnotationSignals: string[] = []
    ) {
        const assembly = await originalRetrieveContext.call(this, question, seedFiles, preferredAnnotationSignals);
        capturedAssemblies.push({
            query: question,
            chunks: assembly.chunks.map(c => ({ file: c.chunk.filePath, score: c.score, startLine: c.chunk.startLine, endLine: c.chunk.endLine }))
        });
        return assembly;
    };

    // Capture the final packet (post-trim) items with scores.
    const capturedPackets: Array<{ query: string; items: Array<{ file: string; score: number; type: string; retrieval_signal: string }> }> = [];
    const originalBuildPacket = EvidencePacketBuilder.prototype.buildPacket;
    EvidencePacketBuilder.prototype.buildPacket = async function patchedBuildPacket(this: EvidencePacketBuilder, query: string, plan: any, retrievalResult?: any): Promise<EvidencePacket> {
        const packet = await originalBuildPacket.call(this, query, plan, retrievalResult);
        capturedPackets.push({
            query,
            items: packet.items.map(i => ({ file: i.file, score: i.score, type: i.type, retrieval_signal: i.retrieval_signal }))
        });
        return packet;
    };

    const harness = new QueryPipelineHarness({ workspaceRoot, repoguideDir, outputChannel: outputChannel as any });
    await harness.init();

    const questions: Array<{ id: string; type: GoldenQuestion['type']; question: string }> = [
        { id: 'rc-01-upload-flow', type: 'flow', question: "What happens when a user uploads an image to start a new mission -- walk me through the full request path from HTTP endpoint to database record?" },
        { id: 'rc-04-ratelimit', type: 'uncertainty', question: "What rate limit does the /api/auth/me endpoint enforce, and what happens when a client exceeds it?" },
        { id: 'rc-10-orchestrator-vs-orchestrator', type: 'orientation', question: "What's the actual difference between app/orchestrator/ and app/agents/mission_orchestrator.py -- which one runs in production?" }
    ];

    const runs: any[] = [];
    for (const q of questions) {
        console.log(`\n${'='.repeat(80)}\n=== Running [${q.id}] ===\n${'='.repeat(80)}`);
        const golden: GoldenQuestion = { id: q.id, type: q.type, question: q.question, expectedAnswer: '', requiresLocations: false };
        const assembliesBefore = capturedAssemblies.length;
        const packetsBefore = capturedPackets.length;
        try {
            const { output } = await harness.runQuestion(golden);
            const executionPlan = output.telemetry?.executionPlan;
            runs.push({
                id: q.id,
                queryType: executionPlan?.evidencePlan?.queryType,
                category: executionPlan?.category,
                symbolHints: executionPlan?.evidencePlan?.symbolHints,
                fileHints: executionPlan?.evidencePlan?.fileHints,
                retrievalStrategy: executionPlan?.evidencePlan?.retrievalStrategy,
                providerIds: executionPlan?.retrievalPlan?.providerIds,
                providersInvoked: output.telemetry?.retrievalResult?.metadata?.providersInvoked,
                providersSkipped: output.telemetry?.retrievalResult?.metadata?.providersSkipped,
                providersFailed: output.telemetry?.retrievalResult?.metadata?.providersFailed,
                rawAssemblies: capturedAssemblies.slice(assembliesBefore),
                finalPacketItems: capturedPackets.slice(packetsBefore),
                answerGate: output.telemetry?.answerGate ? { outcome: output.telemetry.answerGate.outcome, diagnostics: output.telemetry.answerGate.diagnostics } : null,
                answer: output.answer
            });
        } catch (error) {
            runs.push({ id: q.id, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
        }
    }

    const outPath = path.join(process.cwd(), 'retrieval-precision-trace-raw.json');
    fs.writeFileSync(outPath, JSON.stringify({ runs }, null, 2), 'utf8');
    console.log(`\nRaw trace written to ${outPath}`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
