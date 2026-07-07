/**
 * Investigation-only script (no production code modified): root-causes the
 * "evidence was in the packet but the model didn't use it" misses from the
 * fresh dogfood pass (fc-03, fc-06, fc-08).
 *
 * Leading hypothesis: buildEvidenceMessages() has NO token budget (top-50
 * facts + top-30 items by score, where one item can be a 500-line class
 * body), so answer prompts routinely reach 70-100k chars (~19-27k tokens)
 * against inferencer.ts's num_ctx=16384 -- and Ollama silently truncates
 * over-length prompts, meaning the model may literally never have seen the
 * "missed" evidence. Both evidence-present misses (fc-03: 79,078 chars,
 * fc-06: 99,624 chars) and the fc-02 fabrication (93,421 chars) were far
 * over the window; fc-08 (15,272 chars) was within it and needs a separate
 * explanation.
 *
 * Three phases:
 *   1. Needle test -- one controlled over-length prompt with distinct
 *      markers at head/middle/tail, asking the model which it can see.
 *      Establishes empirically WHICH region Ollama drops at num_ctx=16384.
 *   2. Re-run fc-03/fc-06/fc-08 capturing the EXACT messages sent to
 *      streamChat; report prompt size and the char offset of each key
 *      evidence string, so "buried vs prominent" is measured, not guessed.
 *   3. Trim test -- re-run fc-06 and fc-08 with the packet filtered down to
 *      the relevant evidence plus light context, so the prompt fits well
 *      inside the window. If the answer flips to correct, this is a
 *      packet-size problem, not a model-capability ceiling.
 *
 * Usage: npm run compile && node out/evaluation/contextTruncationProbe.js
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
import * as inferencerModule from '../ollama/inferencer';
import { RepositoryContext } from '../context/repositoryContext';

const CHARS_PER_TOKEN_ESTIMATE = 3.7; // rough, code-heavy text
const NUM_CTX = 16384;

function fakeContext(workspaceRoot: string): RepositoryContext {
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

async function collect(gen: AsyncGenerator<string>): Promise<string> {
    let out = '';
    for await (const chunk of gen) { out += chunk; }
    return out;
}

// --- Phase 1: which region survives truncation? ---
async function phase1NeedleTest(workspaceRoot: string): Promise<void> {
    console.log('\n########## PHASE 1: needle truncation test ##########');
    const context = fakeContext(workspaceRoot);

    // Build ~100k chars of filler (comparable to fc-06's real 99,624-char prompt).
    const fillerLine = (i: number) => `const value_${i} = compute_${i}(input_${i}); // routine line ${i}`;
    const lines: string[] = [];
    let approxChars = 0;
    let i = 0;
    while (approxChars < 100_000) {
        const line = fillerLine(i++);
        lines.push(line);
        approxChars += line.length + 1;
    }
    const headNeedle = 'SECRET CODE ALPHA-7391';
    const middleNeedle = 'SECRET CODE BRAVO-4826';
    const tailNeedle = 'SECRET CODE CHARLIE-1057';
    lines.splice(5, 0, `// ${headNeedle}`);
    lines.splice(Math.floor(lines.length / 2), 0, `// ${middleNeedle}`);
    lines.splice(lines.length - 5, 0, `// ${tailNeedle}`);

    const systemPrompt = `You are reading a source file. Somewhere in it are comments containing SECRET CODE markers.\n\n${lines.join('\n')}`;
    const question = 'List every SECRET CODE marker you can actually see in the file above, exactly as written. If you see none, say "none visible".';

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question }
    ];
    const totalChars = JSON.stringify(messages).length;
    console.log(`Prompt: ${totalChars} chars (~${Math.round(totalChars / CHARS_PER_TOKEN_ESTIMATE)} tokens vs num_ctx=${NUM_CTX})`);
    console.log(`Needle offsets in serialized prompt: head=${JSON.stringify(messages).indexOf('ALPHA')}, middle=${JSON.stringify(messages).indexOf('BRAVO')}, tail=${JSON.stringify(messages).indexOf('CHARLIE')}`);

    const answer = await collect(inferencerModule.streamChat(context, messages));
    console.log(`Model answer: ${answer.trim()}`);
    console.log(`Sees head (ALPHA):   ${answer.includes('ALPHA') ? 'YES' : 'NO'}`);
    console.log(`Sees middle (BRAVO): ${answer.includes('BRAVO') ? 'YES' : 'NO'}`);
    console.log(`Sees tail (CHARLIE): ${answer.includes('CHARLIE') ? 'YES' : 'NO'}`);
}

// --- Phases 2 & 3 share this runner ---
interface CaseSpec {
    id: string;
    question: string;
    /** strings whose position in the real prompt we measure */
    evidenceMarkers: string[];
    /** an item is "relevant" for the trim test if file or content matches */
    trimRelevance: RegExp;
    /** what a correct answer must mention, for a quick automated read */
    correctnessSignal: RegExp;
}

const CASES: CaseSpec[] = [
    {
        id: 'fc-06-redis-usage',
        question: 'Does CraftConnect use Redis anywhere, and if so, what is it actually used for?',
        evidenceMarkers: ['REDIS_URL', 'redis'],
        trimRelevance: /redis|community_engine/i,
        correctnessSignal: /redis/i
    },
    {
        id: 'fc-08-orchestrator-vs-coordinator',
        question: "How does app/main.py's global orchestrator relate to app/agents/orchestrator/mission_coordinator.py -- are they the same thing, competing implementations, or does one wrap the other?",
        evidenceMarkers: ['Delegates to MissionCoordinator', 'self.coordinator'],
        trimRelevance: /coordinator|mission_orchestrator|main\.py/i,
        correctnessSignal: /wrap|delegat/i
    },
    {
        id: 'fc-03-community-engine-dead',
        question: 'Is app/core/community_engine.py actually wired into the running app, or is it something else entirely?',
        evidenceMarkers: ['CraftConnect Community Engine', 'CraftConnect API'],
        trimRelevance: /community_engine|main\.py/i,
        correctnessSignal: /separate|standalone|not (wired|included|registered)|second app|own FastAPI/i
    }
];

interface CapturedCall { messages: Array<{ role: string; content: string }>; }

async function runCase(
    workspaceRoot: string,
    repoguideDir: string,
    spec: CaseSpec,
    trim: boolean
): Promise<void> {
    const outputChannel = { appendLine: (_msg: string) => undefined }; // keep probe output readable

    const captured: CapturedCall[] = [];
    const originalStreamChat = inferencerModule.streamChat;
    (inferencerModule as any).streamChat = function wrappedStreamChat(
        context: RepositoryContext,
        messages: Array<{ role: string; content: string }>,
        model?: string,
        signal?: AbortSignal,
        keepAlive?: string
    ): AsyncGenerator<string> {
        captured.push({ messages });
        return originalStreamChat(context, messages, model, signal, keepAlive);
    };

    const originalBuildPacket = EvidencePacketBuilder.prototype.buildPacket;
    let packetStats = '';
    EvidencePacketBuilder.prototype.buildPacket = async function patchedBuildPacket(this: EvidencePacketBuilder, query: string, plan: any, retrievalResult?: any): Promise<EvidencePacket> {
        const packet = await originalBuildPacket.call(this, query, plan, retrievalResult);
        packetStats = `${packet.items.length} items, ${packet.facts.length} facts, ${new Set(packet.items.map(i => i.file)).size} unique files`;
        if (!trim) {
            return packet;
        }
        const relevantItems = packet.items.filter(i => spec.trimRelevance.test(i.file) || spec.trimRelevance.test(i.content));
        const contextItems = packet.items
            .filter(i => !relevantItems.includes(i))
            .sort((a, b) => b.score - a.score)
            .slice(0, 8);
        const relevantFacts = packet.facts.filter(f => spec.trimRelevance.test(f.file) || spec.trimRelevance.test(f.content));
        const contextFacts = packet.facts
            .filter(f => !relevantFacts.includes(f))
            .sort((a, b) => b.score - a.score)
            .slice(0, 15);
        packet.items = [...relevantItems, ...contextItems];
        packet.facts = [...relevantFacts.slice(0, 20), ...contextFacts];
        packetStats += ` -> TRIMMED to ${packet.items.length} items (${relevantItems.length} relevant), ${packet.facts.length} facts`;
        return packet;
    };

    try {
        const harness = new QueryPipelineHarness({ workspaceRoot, repoguideDir, outputChannel: outputChannel as any });
        await harness.init();
        const golden: GoldenQuestion = { id: spec.id, type: 'explanation', question: spec.question, expectedAnswer: '', requiresLocations: false };
        const { output } = await harness.runQuestion(golden);

        // The answer-generation call is the largest captured call (planner calls are ~2k chars).
        const answerCall = captured.reduce((biggest, call) => {
            const size = JSON.stringify(call.messages).length;
            return size > JSON.stringify(biggest.messages).length ? call : biggest;
        }, captured[0]);
        const serialized = JSON.stringify(answerCall.messages);
        const totalChars = serialized.length;
        const estTokens = Math.round(totalChars / CHARS_PER_TOKEN_ESTIMATE);
        // With head-truncation, roughly the first (estTokens - NUM_CTX) tokens are dropped.
        const estDroppedChars = Math.max(0, Math.round((estTokens - NUM_CTX) * CHARS_PER_TOKEN_ESTIMATE));

        console.log(`\n--- ${spec.id} (${trim ? 'TRIMMED' : 'FULL'} packet) ---`);
        console.log(`Packet: ${packetStats}`);
        console.log(`Answer prompt: ${totalChars} chars (~${estTokens} tokens vs num_ctx=${NUM_CTX}${estTokens > NUM_CTX ? ' -- OVER BUDGET' : ''})`);
        for (const marker of spec.evidenceMarkers) {
            const offset = serialized.indexOf(marker);
            if (offset === -1) {
                console.log(`  marker "${marker}": NOT IN PROMPT AT ALL`);
            } else {
                const pct = ((offset / totalChars) * 100).toFixed(1);
                const inDroppedRegion = estTokens > NUM_CTX && offset < estDroppedChars;
                console.log(`  marker "${marker}": offset ${offset}/${totalChars} (${pct}% in)${inDroppedRegion ? ' -- IN ESTIMATED TRUNCATED-AWAY REGION' : ''}`);
            }
        }
        console.log(`Gate: ${output.telemetry?.answerGate?.outcome ?? 'n/a'}`);
        console.log(`Correctness signal (${spec.correctnessSignal}): ${spec.correctnessSignal.test(output.answer) ? 'PRESENT' : 'ABSENT'}`);
        console.log(`Answer:\n${output.answer}`);
    } finally {
        (inferencerModule as any).streamChat = originalStreamChat;
        EvidencePacketBuilder.prototype.buildPacket = originalBuildPacket;
    }
}

async function main(): Promise<void> {
    const workspaceRoot = path.resolve(process.env.CRAFTCONNECT_PATH ?? 'C:\\Users\\rohan\\Downloads\\CraftConnect');
    const repoguideDir = path.join(workspaceRoot, '.repoguide');

    await phase1NeedleTest(workspaceRoot);

    console.log('\n########## PHASE 2: real prompts, real offsets (FULL packets) ##########');
    for (const spec of CASES) {
        await runCase(workspaceRoot, repoguideDir, spec, false);
    }

    console.log('\n########## PHASE 3: trim test (relevant evidence + light context) ##########');
    for (const spec of CASES) {
        await runCase(workspaceRoot, repoguideDir, spec, true);
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
