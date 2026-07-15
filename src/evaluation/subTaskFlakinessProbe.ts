/**
 * Mechanism probe for per-facet coverage instability (investigation tooling):
 * runs the two sub-questions that flip between pass and block across identical
 * decomposed invocations, N times each, fingerprinting every stage --
 *
 *   packetHash: sorted evidence item+fact ids   (retrieval-side variance?)
 *   promptHash: exact answer-call message bytes (prompt-assembly variance?)
 *   answerHash: raw synthesized answer          (generation-sampling variance?)
 *   gate outcome + diagnostics
 *
 * If promptHash is constant while answerHash/gate flip, the nondeterminism is
 * pure generation sampling on an identical prompt (llama.cpp CUDA at temp 0 is
 * not bit-deterministic) -- and "retry" should mean re-sampling synthesis. If
 * packetHash varies, retrieval contributes and a retry must re-run the whole
 * sub-task. Decides the retry design instead of assuming it.
 *
 * scoreQueryComplexity is pinned to 'simple' so every run takes the regex
 * planner -- the exact condition real decomposed sub-tasks run under
 * (allowLLMPlanning: false), with no LLM-planner variance muddying the reads.
 *
 * Usage: npm run compile && node out/evaluation/subTaskFlakinessProbe.js
 */
import * as crypto from 'crypto';
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
import { EvidencePacketBuilder } from '../query/evidencePacketBuilder';
import { EvidencePacket } from '../query/evidencePacket';
import * as inferencerModule from '../ollama/inferencer';
import * as complexityModule from '../query/planning/complexityScorer';
import { RepositoryContext } from '../context/repositoryContext';
import { retrySynthesisWithGateFeedback } from '../query/subTaskRetry';
import { getCraftConnectPath } from './craftconnectPath';

function fakeContextForRetry(workspaceRoot: string): RepositoryContext {
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

const RUNS_PER_QUESTION = 6;

const QUESTIONS = [
    { id: 'sub-1-agents', question: 'Identify all agents involved in the mission execution pipeline. (Focus on: execute_mission, DATA_DIR, start_mission, run_mission, MissionOrchestratorAgent)' },
    { id: 'sub-4-disk', question: 'Locate where the final mission report is stored on disk. (Focus on: execute_mission, DATA_DIR, start_mission, run_mission, MissionOrchestratorAgent)' }
];

const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

async function main(): Promise<void> {
    const workspaceRoot = path.resolve(getCraftConnectPath());
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    const outputChannel = { appendLine: (_msg: string) => undefined };

    // Pin the regex-planner path: real decomposed sub-tasks run with
    // allowLLMPlanning=false, and the probe must match that exactly.
    const originalScore = complexityModule.scoreQueryComplexity;
    (complexityModule as any).scoreQueryComplexity = (query: string, hasHistory?: boolean) => ({
        ...originalScore(query, hasHistory),
        classification: 'simple' as const
    });

    for (const q of QUESTIONS) {
        console.log(`\n================ ${q.id} (${RUNS_PER_QUESTION} runs) ================`);
        for (let run = 1; run <= RUNS_PER_QUESTION; run++) {
            let packetHash = '?';
            const originalBuildPacket = EvidencePacketBuilder.prototype.buildPacket;
            EvidencePacketBuilder.prototype.buildPacket = async function patched(this: EvidencePacketBuilder, query: string, plan: any, retrievalResult?: any): Promise<EvidencePacket> {
                const packet = await originalBuildPacket.call(this, query, plan, retrievalResult);
                const ids = [...packet.items.map(i => String(i.id)), '|', ...packet.facts.map(f => String(f.id))].sort();
                packetHash = sha1(ids.join(','));
                return packet;
            };

            let promptHash = '?';
            const originalStreamChat = inferencerModule.streamChat;
            (inferencerModule as any).streamChat = function wrapped(context: RepositoryContext, messages: Array<{ role: string; content: string }>, model?: string, signal?: AbortSignal, keepAlive?: string): AsyncGenerator<string> {
                // The answer call is the only large one on this pinned path.
                const serialized = JSON.stringify(messages);
                if (serialized.length > 5000) {
                    promptHash = sha1(serialized);
                }
                return originalStreamChat(context, messages, model, signal, keepAlive);
            };

            try {
                const harness = new QueryPipelineHarness({ workspaceRoot, repoguideDir, outputChannel: outputChannel as any });
                await harness.init();
                const golden: GoldenQuestion = { id: `${q.id}-r${run}`, type: 'flow', question: q.question, expectedAnswer: '', requiresLocations: false };
                const { output } = await harness.runQuestion(golden);
                const gate = output.telemetry?.answerGate;
                const rawAnswer = output.telemetry?.synthesizedAnswer ?? output.answer;
                let retryNote = '';
                // Phase 2 of the probe: when the initial answer blocks, run the REAL
                // retry-with-gate-feedback (same helper the dispatcher uses, real
                // model) and record whether it recovers -- the honest recovery-rate
                // measurement the retry policy is justified (or rejected) by.
                if (gate?.outcome === 'block' && output.telemetry?.packet) {
                    const context = fakeContextForRetry(workspaceRoot);
                    const retry = await retrySynthesisWithGateFeedback(
                        output.telemetry.packet,
                        gate,
                        { checkNumericClaims: true, checkQuotedStrings: true, checkFilePaths: true },
                        async messages => {
                            let out = '';
                            for await (const chunk of originalStreamChat(context, messages)) { out += chunk; }
                            return out;
                        },
                        undefined,
                        workspaceRoot
                    );
                    retryNote = ` | RETRY: ${retry.recovered ? 'RECOVERED' : 'still blocked (' + (retry.gate.diagnostics[0] ?? '') + ')'}`;
                }
                console.log(`run ${run}: packet=${packetHash} prompt=${promptHash} answer=${sha1(rawAnswer)} gate=${gate?.outcome} ${gate?.outcome === 'block' ? 'diag=' + JSON.stringify(gate?.diagnostics?.[0] ?? '') : ''}${retryNote}`);
            } finally {
                EvidencePacketBuilder.prototype.buildPacket = originalBuildPacket;
                (inferencerModule as any).streamChat = originalStreamChat;
            }
        }
    }
    (complexityModule as any).scoreQueryComplexity = originalScore;
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
