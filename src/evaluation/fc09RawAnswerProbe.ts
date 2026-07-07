/**
 * One-off probe: runs fc-09 and captures the RAW model answer handed to
 * AnswerGate.verify() before any blocking, so the remaining fence/path
 * diagnostics can be judged against the real files -- genuine fabrication
 * (correct block) vs. another comparison false positive (fix it).
 *
 * Usage: npm run compile && node out/evaluation/fc09RawAnswerProbe.js
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
import { AnswerGate } from '../query/answerGate';

async function main(): Promise<void> {
    const workspaceRoot = path.resolve(process.env.CRAFTCONNECT_PATH ?? 'C:\\Users\\rohan\\Downloads\\CraftConnect');
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    const outputChannel = { appendLine: (_m: string) => undefined };

    const originalVerify = AnswerGate.prototype.verify;
    AnswerGate.prototype.verify = function patchedVerify(this: AnswerGate, answer: string, packet: any, policy?: any, wsRoot?: string) {
        console.log('===== RAW PRE-GATE ANSWER =====');
        console.log(answer);
        console.log('===== END RAW ANSWER =====');
        return originalVerify.call(this, answer, packet, policy, wsRoot);
    };

    const harness = new QueryPipelineHarness({ workspaceRoot, repoguideDir, outputChannel: outputChannel as any });
    await harness.init();
    const golden: GoldenQuestion = {
        id: 'fc-09-generate-listing-path',
        type: 'flow',
        question: "When studio_write.py's generate_listing_from_interview endpoint runs, does it reach the same orchestrator used for mission creation, or a separate code path?",
        expectedAnswer: '',
        requiresLocations: false
    };
    const { output } = await harness.runQuestion(golden);
    console.log('\nGate outcome:', output.telemetry?.answerGate?.outcome);
    console.log('Diagnostics:', JSON.stringify(output.telemetry?.answerGate?.diagnostics, null, 2));
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
