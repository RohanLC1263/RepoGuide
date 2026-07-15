/**
 * One-off sanity check (investigation-only, no production code modified): rc-04
 * ("What rate limit does the /api/auth/me endpoint enforce...") answers "the
 * evidence provided does not determine..." even with a real, rebuilt index. This
 * checks directly whether app/core/ratelimit.py and/or app/routers/auth.py (the
 * two real files that would actually answer this) were present in the evidence
 * packet handed to the model, to tell apart a retrieval-ranking gap from a
 * synthesis/gate-strictness gap.
 *
 * Usage: npm run compile && node out/evaluation/rc04CitationCheck.js
 */
import * as path from 'path';
import * as moduleObj from 'module';

function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = {
        workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_k: string, f: unknown) => f }) },
        window: { createOutputChannel: () => ({ appendLine: console.log, show: () => undefined, dispose: () => undefined }) },
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
    const workspaceRoot = path.resolve(getCraftConnectPath());
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

    const golden: GoldenQuestion = {
        id: 'rc-04-ratelimit',
        type: 'uncertainty',
        question: "What rate limit does the /api/auth/me endpoint enforce, and what happens when a client exceeds it?",
        expectedAnswer: '',
        requiresLocations: false
    };

    const { output } = await harness.runQuestion(golden);

    console.log('\n=== Answer ===');
    console.log(output.answer);
    console.log('\n=== Gate ===', output.telemetry?.answerGate?.outcome);

    const packet = capturedPackets[0];
    console.log(`\n=== Evidence packet: ${packet.items.length} items ===`);
    const files = packet.items.map(i => i.file);
    const uniqueFiles = Array.from(new Set(files));
    console.log(`Unique files in packet: ${uniqueFiles.length}`);

    const relevantFiles = uniqueFiles.filter(f => /ratelimit|routers[\\/]auth\.py|core[\\/]auth\.py/i.test(f));
    console.log(`\nFiles matching ratelimit.py / routers/auth.py / core/auth.py: ${JSON.stringify(relevantFiles, null, 2)}`);

    if (relevantFiles.length === 0) {
        console.log('\n=> NOT PRESENT in the evidence packet -- this is a retrieval-ranking gap.');
    } else {
        console.log('\n=> PRESENT in the evidence packet -- inspecting the actual item content:');
        for (const item of packet.items.filter(i => relevantFiles.includes(i.file))) {
            console.log(`  [${item.file}:${item.startLine}-${item.endLine}] (${item.type}, score=${item.score})`);
            console.log('  content:', item.content.slice(0, 300).replace(/\n/g, '\\n'));
        }
        console.log('\n=> Since real evidence was present but the model still declined to assert it, this is a synthesis/gate-strictness gap, not a retrieval gap.');
    }

    console.log('\n=== All unique files in packet (for reference) ===');
    console.log(JSON.stringify(uniqueFiles, null, 2));
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
