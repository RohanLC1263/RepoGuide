/**
 * Investigation-only script (no production code modified) for the two
 * confirmed hallucinations found during manual CraftConnect testing:
 *  1. story_generation_agent.py / story_gen_agent.py claimed "identical"
 *  2. A fabricated __init__ body attributed to orchestrator_agent.py
 *
 * Reruns both questions 3x each against the existing index, and monkey-patches
 * EvidencePacketBuilder.prototype.buildPacket from this standalone script only
 * (not editing src/query/evidencePacketBuilder.ts) to capture the exact
 * file+content pairs passed to the model for the orchestrator question.
 *
 * Usage: npm run compile && node out/evaluation/hallucinationInvestigation.js
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
        if (id === 'vscode') return shim;
        return originalRequire.apply(this, arguments as any);
    };
}
installVscodeShim();

import { QueryPipelineHarness } from './queryPipelineHarness';
import { GoldenQuestion } from './types';
import { EvidencePacketBuilder } from '../query/evidencePacketBuilder';
import { EvidencePacket } from '../query/evidencePacket';

async function main(): Promise<void> {
    const craftconnectPath = process.env.CRAFTCONNECT_PATH ?? 'C:\\Users\\rohan\\Downloads\\CraftConnect';
    const workspaceRoot = path.resolve(craftconnectPath);
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    const outputChannel = { appendLine: (msg: string) => console.log(msg) };

    const capturedPackets: Array<{ query: string; items: Array<{ file: string; contentPreview: string }> }> = [];
    const originalBuildPacket = EvidencePacketBuilder.prototype.buildPacket;
    EvidencePacketBuilder.prototype.buildPacket = async function patchedBuildPacket(this: EvidencePacketBuilder, query: string, plan: any, retrievalResult?: any): Promise<EvidencePacket> {
        const packet = await originalBuildPacket.call(this, query, plan, retrievalResult);
        capturedPackets.push({
            query,
            items: packet.items.map(item => ({
                file: item.file,
                contentPreview: item.content.slice(0, 2000)
            }))
        });
        return packet;
    };

    const harness = new QueryPipelineHarness({ workspaceRoot, repoguideDir, outputChannel: outputChannel as any });
    await harness.init();

    const questions: Array<{ id: string; type: GoldenQuestion['type']; question: string }> = [
        { id: 'dup-story-agent', type: 'explanation', question: "There's both app/agents/story_generation_agent.py and app/agents/story_gen_agent.py — what's the difference, and which one is actually used in the mission pipeline?" },
        { id: 'dup-orchestrator', type: 'explanation', question: "There's app/agents/mission_orchestrator.py, app/agents/orchestrator_agent.py, and app/agents/orchestrator/mission_coordinator.py — which one is the real entry point for running a mission, and how do the other two relate to it?" }
    ];

    const runs: any[] = [];
    for (const q of questions) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`=== Running [${q.id}] attempt ${attempt}/3 ===`);
            const golden: GoldenQuestion = {
                id: `${q.id}-attempt${attempt}`,
                type: q.type,
                question: q.question,
                expectedAnswer: '',
                requiresLocations: false
            };
            const packetsBefore = capturedPackets.length;
            try {
                const { output } = await harness.runQuestion(golden);
                const packetsForThisRun = capturedPackets.slice(packetsBefore);
                runs.push({
                    id: q.id,
                    attempt,
                    answer: output.answer,
                    confidence: output.confidence,
                    citedFiles: output.capturedContext.citedFiles,
                    evidenceItems: packetsForThisRun.flatMap(p => p.items)
                });
            } catch (error) {
                runs.push({
                    id: q.id,
                    attempt,
                    error: error instanceof Error ? (error.stack ?? error.message) : String(error)
                });
            }
        }
    }

    const outPath = path.join(process.cwd(), 'hallucination-investigation-raw.json');
    fs.writeFileSync(outPath, JSON.stringify({ runs }, null, 2), 'utf8');
    console.log(`Raw results written to ${outPath}`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
