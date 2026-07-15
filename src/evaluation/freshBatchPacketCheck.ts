/**
 * One-off investigation script (no production code modified): for a handful of
 * fc-* questions from craftconnectFreshDogfoodBatch.ts whose answers looked
 * either blocked-for-fabrication or suspiciously under-confident, dumps the
 * real evidence packet (files + content) handed to the model, to tell a
 * retrieval gap (determinative file never surfaced) apart from a synthesis
 * gap (evidence was there but the model didn't use it) or a genuine gate
 * false-positive.
 *
 * Usage: npm run compile && node out/evaluation/freshBatchPacketCheck.js
 */
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
import { getCraftConnectPath } from './craftconnectPath';

async function main(): Promise<void> {
    const workspaceRoot = path.resolve(getCraftConnectPath());
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    const outputChannel = { appendLine: (msg: string) => console.log(msg) };

    const questions: Array<{ id: string; question: string; checkFor: RegExp }> = [
        { id: 'fc-02-seal-lock', question: "What enforces the lock after a mission is sealed via POST /api/mission/{id}/seal -- can a sealed mission still be edited, and if so how is that prevented or allowed?", checkFor: /studio_write\.py|mission_report\.json/i },
        { id: 'fc-03-community-engine-dead', question: "Is app/core/community_engine.py actually wired into the running app, or is it something else entirely?", checkFor: /main\.py/i },
        { id: 'fc-04-rag-agent-vs-engine', question: "What's the real difference between app/agents/rag_retriever_agent.py and app/agents/rag_retrieval_engine.py -- is one of them dead code?", checkFor: /main\.py/i },
        { id: 'fc-05-orchestrator-backup', question: "Is app/agents/mission_orchestrator.backup.py still used by anything in the running app?", checkFor: /backup\.py/i },
        { id: 'fc-06-redis-usage', question: "Does CraftConnect use Redis anywhere, and if so, what is it actually used for?", checkFor: /community_engine\.py/i },
        { id: 'fc-08-orchestrator-vs-coordinator', question: "How does app/main.py's global orchestrator relate to app/agents/orchestrator/mission_coordinator.py -- are they the same thing, competing implementations, or does one wrap the other?", checkFor: /self\.coordinator|MissionCoordinator\(/i }
    ];

    for (const q of questions) {
        const capturedPackets: EvidencePacket[] = [];
        const originalBuildPacket = EvidencePacketBuilder.prototype.buildPacket;
        EvidencePacketBuilder.prototype.buildPacket = async function patchedBuildPacket(this: EvidencePacketBuilder, query: string, plan: any, retrievalResult?: any): Promise<EvidencePacket> {
            const packet = await originalBuildPacket.call(this, query, plan, retrievalResult);
            capturedPackets.push(packet);
            return packet;
        };

        // Fresh harness per question so one question's monkeypatch/state doesn't bleed into the next.
        const harness = new QueryPipelineHarness({ workspaceRoot, repoguideDir, outputChannel: outputChannel as any });
        await harness.init();

        const golden: GoldenQuestion = { id: q.id, type: 'explanation', question: q.question, expectedAnswer: '', requiresLocations: false };
        await harness.runQuestion(golden);
        EvidencePacketBuilder.prototype.buildPacket = originalBuildPacket;

        const packet = capturedPackets[0];
        const files = Array.from(new Set(packet.items.map(i => i.file)));
        console.log(`\n${'='.repeat(70)}\n${q.id}: ${files.length} unique files in packet`);

        const matchingItems = packet.items.filter(i => q.checkFor.test(i.file) || q.checkFor.test(i.content));
        if (matchingItems.length === 0) {
            console.log(`=> NOT PRESENT (no item matches ${q.checkFor}) -- retrieval gap.`);
        } else {
            console.log(`=> PRESENT (${matchingItems.length} matching item(s)):`);
            for (const item of matchingItems.slice(0, 5)) {
                console.log(`  [${item.file}:${item.startLine}-${item.endLine}] (${item.type}, score=${item.score})`);
                console.log('  content:', item.content.slice(0, 400).replace(/\n/g, '\\n'));
            }
        }
        console.log('All files:', JSON.stringify(files));
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
