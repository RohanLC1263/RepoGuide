import * as path from 'path';
import * as fs from 'fs';
import { EvidencePacketBuilder } from '../query/evidencePacketBuilder';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { FactStore } from '../store/factStore';
import { LogicalUnitBm25Store } from '../store/logicalUnitBm25Store';
import { LanceStore } from '../store/lanceStore';
import { ProgramGraphStore } from '../store/programGraphStore';
import { buildEvidencePlan } from '../query/evidencePlanner';

async function main() {
    const workspaceRoot = path.resolve(__dirname, '../../eval_repos/axios');
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    
    console.log("Initializing stores...");
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

    const questions = [
        "What is Axios?",
        "Explain the request lifecycle.",
        "How do interceptors work?",
        "What is AxiosHeaders responsible for?",
        "Trace a request from API call to network dispatch."
    ];

    const expectedFiles = [
        ['lib/core/Axios.js', 'lib/axios.js'],
        ['lib/core/dispatchRequest.js', 'lib/adapters/http.js', 'lib/adapters/xhr.js'],
        ['lib/core/InterceptorManager.js', 'lib/core/Axios.js'],
        ['lib/core/AxiosHeaders.js', 'lib/helpers/parseHeaders.js'],
        ['lib/core/Axios.js', 'lib/core/dispatchRequest.js', 'lib/adapters/http.js', 'lib/adapters/xhr.js']
    ];

    console.log(`\n\n=== INVESTIGATION F: INDEX INTEGRITY ===`);
    const allUnits = await unitStore.getAll();
    const allFacts = await factStore.queryFacts({ limit: Number.POSITIVE_INFINITY });
    let vectorCount = 0;
    try {
        vectorCount = await lanceStore.getChunkCount();
    } catch (e) {
        // ignore
    }
    
    const indexedFiles = new Set(allUnits.map((u: any) => u.filePath));
    console.log(`Total Indexed Files: ${indexedFiles.size}`);
    console.log(`Total Logical Units: ${allUnits.length}`);
    console.log(`Total Facts: ${allFacts.length}`);
    console.log(`Total Vectors in LanceDB: ${vectorCount}`);
    
    // Check if vectors match units
    console.log(`Vector/Unit Ratio: ${(allUnits.length > 0 ? (vectorCount / allUnits.length * 100).toFixed(2) : '0.00')}%`);

    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const expected = expectedFiles[i];
        console.log(`\n======================================================`);
        console.log(`QUESTION ${i + 1}: ${q}`);
        console.log(`Expected Files: ${expected.join(', ')}`);
        console.log(`======================================================`);

        // A. BM25 Retrieval
        console.log(`\n--- BM25 Top 50 ---`);
        const bm25Results = await bm25Store.search(q, 50);
        const bm25FilesFound = new Set();
        bm25Results.slice(0, 10).forEach((r: any) => {
            console.log(`[BM25 ${r.score.toFixed(3)}] ${r.filePath}`);
            bm25FilesFound.add(r.filePath);
        });
        const bm25Recall = expected.filter(f => bm25Results.some((r: any) => r.filePath.toLowerCase().includes(f.toLowerCase()))).length;
        console.log(`BM25 Recall (Expected Files Found): ${bm25Recall} / ${expected.length}`);

        // B. Vector Retrieval
        console.log(`\n--- Vector Top 50 ---`);
        let vectorResults: any[] = [];
        try {
            // Using searchByKeywords as a fallback since embeddings aren't generated directly here, 
            // but we can check if any vectors exist at all.
            vectorResults = await lanceStore.searchByKeywords(q.split(' '));
        } catch(e: any) {
            console.log(`Vector search failed: ${e.message}`);
        }
        vectorResults.slice(0, 10).forEach((r: any) => {
            console.log(`[Vector ${r.score?.toFixed(3) || 'N/A'}] ${r.filePath}`);
        });
        const vectorRecall = expected.filter(f => vectorResults.some((r: any) => r.filePath.toLowerCase().includes(f.toLowerCase()))).length;
        console.log(`Vector Recall (Expected Files Found): ${vectorRecall} / ${expected.length}`);

        // D. Graph Expansion / Fact Distribution
        const plan = buildEvidencePlan(q);
        const builder = new EvidencePacketBuilder({
            unitStore, factStore, bm25Store, programGraphStore
        }, workspaceRoot);
        const packet = await builder.buildPacket(q, plan);
        
        console.log(`\n--- Graph Expansion (Facts) ---`);
        const factTypes: Record<string, number> = {};
        packet.facts.forEach(f => {
            const type = f.type || 'unknown';
            factTypes[type] = (factTypes[type] || 0) + 1;
        });
        console.log(`Fact Types Distribution:`);
        Object.entries(factTypes).forEach(([type, count]) => {
            console.log(`  - ${type}: ${count}`);
        });
        
        const uniqueFactIds = new Set(packet.facts.map(f => f.id)).size;
        console.log(`Total Facts: ${packet.facts.length}`);
        console.log(`Unique Fact IDs: ${uniqueFactIds}`);
        console.log(`Duplication Rate: ${(packet.facts.length > 0 ? ((packet.facts.length - uniqueFactIds) / packet.facts.length * 100).toFixed(2) : '0.00')}%`);

        // C. Fusion Analysis (Packet Items)
        console.log(`\n--- Fusion & Source Attribution (Top 20 Packet Items) ---`);
        const sourceCounts: Record<string, number> = {};
        const sortedItems = [...packet.items].sort((a,b) => b.score - a.score);
        sortedItems.slice(0, 20).forEach(item => {
            console.log(`[Item ${item.score.toFixed(3)}] [${item.retrieval_signal}] ${item.file}`);
            const src = item.retrieval_signal || 'unknown';
            sourceCounts[src] = (sourceCounts[src] || 0) + 1;
        });
        console.log(`\nTop 20 Retriever Contribution:`);
        Object.entries(sourceCounts).forEach(([src, count]) => {
            console.log(`  - ${src}: ${count}`);
        });
        
        // E. Retrieval Coverage
        console.log(`\n--- Retrieval Coverage (Expected vs Actual in Packet Items) ---`);
        const actualFiles = new Set(packet.items.map(i => i.file));
        const found = expected.filter(f => [...actualFiles].some(af => af.toLowerCase().includes(f.toLowerCase())));
        const missed = expected.filter(f => !found.includes(f));
        console.log(`Found: ${found.length > 0 ? found.join(', ') : 'None'}`);
        console.log(`Missed: ${missed.length > 0 ? missed.join(', ') : 'None'}`);
    }
}

main().catch(console.error);
