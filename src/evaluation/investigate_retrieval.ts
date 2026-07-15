import * as path from 'path';
import { EvidencePacketBuilder } from '../query/evidencePacketBuilder';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { FactStore } from '../store/factStore';
import { LogicalUnitBm25Store } from '../store/logicalUnitBm25Store';
import { LanceStore } from '../store/lanceStore';
import { ProgramGraphStore } from '../store/programGraphStore';
import { buildEvidencePlan } from '../query/evidencePlanner';
import { EvidenceAnswerSynthesizer } from '../query/evidenceAnswerSynthesizer';
import { Logger, RepositoryContext } from '../context/repositoryContext';

async function main() {
    console.log("Initializing stores...");
    const workspaceRoot = path.resolve(__dirname, '../../eval_repos/axios');
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    
    const mockLogger: Logger = {
        appendLine: console.log,
        debug: console.log,
        info: console.log,
        warn: console.log,
        error: console.error,
        stageStart: () => {},
        stageProgress: () => {},
        stageComplete: () => {},
        stageFailed: () => {},
        artifactWritten: () => {},
        queryLog: () => {},
        repairLog: () => {}
    };

    const context: RepositoryContext = {
        workspaceRoot: workspaceRoot,
        repoguideDataDir: repoguideDir,
        getConfig: <T>(key: string, defaultValue?: T) => defaultValue as T,
        asRelativePath: (p: string) => path.relative(workspaceRoot, p),
        logger: mockLogger,
        notifyInfo: async () => {},
        notifyWarning: async () => {},
        notifyError: async () => {}
    };

    const unitStore = new LogicalUnitStore(repoguideDir);
    const factStore = new FactStore(repoguideDir);
    const bm25Store = new LogicalUnitBm25Store(repoguideDir);
    const lanceStore = new LanceStore(repoguideDir);
    const programGraphStore = new ProgramGraphStore();

    await unitStore.init(workspaceRoot);
    await factStore.init(workspaceRoot);
    await bm25Store.init();
    await lanceStore.init();
    await programGraphStore.load(workspaceRoot);

    const builder = new EvidencePacketBuilder({
        unitStore, factStore, bm25Store, programGraphStore
    }, workspaceRoot);
    
    const synthesizer = new EvidenceAnswerSynthesizer(context);

    const questions = [
        "What is Axios?",
        "Explain the request lifecycle.",
        "How do interceptors work?",
        "What is AxiosHeaders responsible for?",
        "Trace a request from API call to network dispatch."
    ];

    const models = ["qwen2.5-coder:3b", "qwen2.5-coder:7b"]; // Limiting to 3b and 7b to save time

    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        console.log(`\n\n======================================================`);
        console.log(`QUESTION ${i + 1}: ${q}`);
        console.log(`======================================================`);

        const plan = buildEvidencePlan(q);
        const packet = await builder.buildPacket(q, plan);

        console.log(`\n--- CONTEXT ASSEMBLY ---`);
        console.log(`Total Facts: ${packet.facts.length}`);
        console.log(`Total Logical Units (Items): ${packet.items.length}`);

        // Get Top 20 Facts and Top 20 Items
        const topFacts = [...packet.facts].sort((a,b) => b.score - a.score).slice(0, 20);
        const topItems = [...packet.items].sort((a,b) => b.score - a.score).slice(0, 20);

        console.log(`\n--- TOP 20 FACTS ---`);
        topFacts.forEach(f => {
            console.log(`[${f.score}] ${f.retrieval_signal} - ${f.file} (${f.type})`);
        });

        console.log(`\n--- TOP 20 ITEMS ---`);
        topItems.forEach(i => {
            console.log(`[${i.score}] ${i.retrieval_signal} - ${i.file} (${i.type})`);
        });
        
        // Compacted Packet size
        const compactedItems = [];
        const annotations = [], gaps = [], symbolMatches = [], bm25Matches = [], graphMatches = [], vectorMatches = [], memoryMatches = [];
        
        for (const item of packet.items) {
            if (item.type === 'inferred_gap') gaps.push(item);
            else if (item.type === 'annotation' || item.type === 'community_summary') annotations.push(item);
            else if (item.retrieval_signal === 'bm25') bm25Matches.push(item);
            else if (item.retrieval_signal && item.retrieval_signal.startsWith('graph_')) graphMatches.push(item);
            else if (item.retrieval_signal === 'vector') vectorMatches.push(item);
            else if (item.retrieval_signal === 'memory_bridge') memoryMatches.push(item);
            else symbolMatches.push(item);
        }
        
        compactedItems.push(...gaps);
        compactedItems.push(...annotations.slice(0, 2));
        compactedItems.push(...symbolMatches);
        compactedItems.push(...bm25Matches.slice(0, 5));
        compactedItems.push(...graphMatches.slice(0, 3));
        compactedItems.push(...vectorMatches.slice(0, 2));
        compactedItems.push(...memoryMatches.slice(0, 3));
        
        console.log(`\n--- PROMPT CONSTRUCTION ---`);
        console.log(`Items in Prompt: ${compactedItems.length}`);
        console.log(`Facts in Prompt: ${packet.facts.length} (Uncapped in compactPacketForLLM, capped to 50 in evidencePrompt)`);

        console.log(`\n--- MODEL CAPABILITY TEST ---`);
        for (const model of models) {
            console.log(`\nRunning ${model}...`);
            try {
                let answer = await synthesizer.synthesize(packet, model);
                console.log(`[${model} Answer]: ${answer.substring(0, 500)}${answer.length > 500 ? '...' : ''}`);
            } catch (e: any) {
                console.log(`[${model} Error]: ${e.message}`);
            }
        }
    }
}

main().catch(console.error);
