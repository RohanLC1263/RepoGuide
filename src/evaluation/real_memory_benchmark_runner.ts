import { LocalEmbeddingProvider } from '../memory/embeddings/localEmbeddingProvider';
import { LanceDbMemoryStore } from '../memory/lanceDbMemoryStore';
import { LanceDbMemoryRetriever } from '../memory/lanceDbMemoryRetriever';
import { InMemoryValueRepository } from '../memory/lifecycle/inMemoryValueRepository';
import { LifecycleAwareRetriever } from '../memory/lifecycle/lifecycleAwareRetriever';
import { benchmarkCorpus, benchmarkQueries } from './benchmark_fixture_loader';
import * as path from 'path';
import * as fs from 'fs';

async function runRealBenchmark() {
    console.log("[Benchmark] Initializing real Memory dependencies...");
    
    const dbPath = path.join(process.cwd(), '.repoguide', 'benchmark_lancedb_' + Date.now());
    console.log(`[Benchmark] DB Path: ${dbPath}`);

    const embeddingProvider = new LocalEmbeddingProvider();
    await embeddingProvider.initialize(); // Uses @xenova/transformers

    const memoryStore = new LanceDbMemoryStore(embeddingProvider, dbPath);
    await memoryStore.initialize();

    const valueRepo = new InMemoryValueRepository();
    const pureRetriever = new LanceDbMemoryRetriever(memoryStore);
    const retriever = new LifecycleAwareRetriever(pureRetriever, valueRepo);

    console.log(`[Benchmark] Seeding ${benchmarkCorpus.length} memories into LanceDB...`);
    for (const record of benchmarkCorpus) {
        await memoryStore.create({
            ...record,
            repositoryId: 'bench-repo'
        });
    }

    console.log(`[Benchmark] Executing ${benchmarkQueries.length} queries...`);

    let hitsAt1 = 0;
    let hitsAt3 = 0;
    let hitsAt5 = 0;
    let sumPrecisionAt3 = 0;
    let sumMrr = 0;

    const resultsLog = [];

    for (const q of benchmarkQueries) {
        const results = await retriever.retrieve({
            repositoryIds: ['bench-repo'],
            textQuery: q.text,
            limit: 5
        });

        let foundRank = -1;
        let relevantInTop3 = 0;

        for (let i = 0; i < results.length; i++) {
            const isRelevant = results[i].tags.includes(q.expectedTag);
            if (isRelevant) {
                if (foundRank === -1) foundRank = i + 1;
                if (i < 3) relevantInTop3++;
            }
        }

        if (foundRank === 1) hitsAt1++;
        if (foundRank >= 1 && foundRank <= 3) hitsAt3++;
        if (foundRank >= 1 && foundRank <= 5) hitsAt5++;
        
        if (foundRank !== -1) {
            sumMrr += (1.0 / foundRank);
        }

        // Calculate Precision@3
        const maxExpected = 1; // Since there is exactly 1 golden memory per query in this benchmark
        const precisionDenom = Math.min(3, Math.max(1, results.length));
        const pAt3 = relevantInTop3 / Math.min(precisionDenom, maxExpected); 
        sumPrecisionAt3 += pAt3;

        resultsLog.push({
            queryId: q.id,
            query: q.text,
            expectedTag: q.expectedTag,
            retrievedCount: results.length,
            bestRank: foundRank,
            topTags: results.map(r => r.tags.join(','))
        });
    }

    const n = benchmarkQueries.length;
    const finalMetrics = {
        hitAt1: hitsAt1 / n,
        hitAt3: hitsAt3 / n,
        hitAt5: hitsAt5 / n,
        precisionAt3: sumPrecisionAt3 / n,
        mrr: sumMrr / n
    };

    console.log("\n=== REAL BENCHMARK METRICS ===");
    console.log(`Hit@1: ${(finalMetrics.hitAt1 * 100).toFixed(1)}%`);
    console.log(`Hit@3: ${(finalMetrics.hitAt3 * 100).toFixed(1)}%`);
    console.log(`Hit@5: ${(finalMetrics.hitAt5 * 100).toFixed(1)}%`);
    console.log(`Precision@3: ${(finalMetrics.precisionAt3 * 100).toFixed(1)}%`);
    console.log(`MRR: ${finalMetrics.mrr.toFixed(3)}`);

    fs.writeFileSync('benchmark_results_raw.json', JSON.stringify({ metrics: finalMetrics, logs: resultsLog }, null, 2));
    console.log("\n[Benchmark] Complete. Raw results saved to benchmark_results_raw.json");
}

if (require.main === module) {
    runRealBenchmark().catch(console.error);
}
