import { FIXTURES } from "./ingestion_fixture_library";
import { MemoryIngestionPipeline } from "../memory/ingestion/memoryIngestionPipeline";
import { InMemoryMemoryStore } from "../memory/inMemoryMemoryStore";
import { ValidationPipeline } from "../memory/ingestion/validationPipeline";
import { DeduplicationService } from "../memory/ingestion/deduplicationService";
import { ConflictResolutionService } from "../memory/ingestion/conflictResolutionService";
import { PromotionService } from "../memory/ingestion/promotionService";
import { InMemoryEphemeralMemoryRepository } from "../memory/ingestion/ephemeralMemoryRepository";

async function run() {
    console.log("Starting Memory Ingestion Validation Sprint Runner...\n");
    let passed = 0;
    let failed = 0;

    for (const test of FIXTURES) {
        console.log(`Executing: ${test.fixture.id} - ${test.fixture.description}`);
        
        // 1. Setup isolated dependencies for this test
        const store = new InMemoryMemoryStore();
        // Pre-seed LanceDb (InMemoryStore)
        for (const record of test.fixture.initialLanceDbState) {
            await store.create(record);
        }

        const ephemeralRepo = new InMemoryEphemeralMemoryRepository();
        const pipeline = new MemoryIngestionPipeline(
            store,
            new ValidationPipeline(),
            new DeduplicationService(store),
            new ConflictResolutionService(store),
            new PromotionService(ephemeralRepo)
        );

        let finalState = 'unknown';
        let preCount = (await store.search({})).length;

        // 2. Stream observations
        for (const obs of test.fixture.inputObservations) {
            const result = await pipeline.ingest({
                content: obs.content,
                source: obs.source,
                scope: obs.scope,
                scopeKeys: ['global'],
                tags: [],
                confidence: obs.confidence,
                repositoryId: 'repo-1'
            });
            finalState = result.finalState;
        }

        let postCount = (await store.search({})).length;
        let delta = postCount - preCount;

        // 3. Verify
        let success = true;
        if (finalState !== test.expected.finalMemoryState) {
            console.error(`  [FAIL] Expected state ${test.expected.finalMemoryState}, got ${finalState}`);
            success = false;
        }
        if (delta !== test.expected.expectedMemoryCountDelta) {
            console.error(`  [FAIL] Expected delta ${test.expected.expectedMemoryCountDelta}, got ${delta}`);
            success = false;
        }

        if (test.fixture.id.includes('conflict-1')) {
            const all = await store.search({ includeStale: true });
            const oldRecord = all.find(r => r.content.includes('Jest'));
            if (!oldRecord || !oldRecord.stale) {
                console.error(`  [FAIL] Expected older record to be staled.`);
                success = false;
            }
        }

        if (success) {
            console.log(`  [PASS]`);
            passed++;
        } else {
            failed++;
        }
    }

    console.log(`\nResults: ${passed} Passed, ${failed} Failed.`);
    if (failed > 0) {
        process.exit(1);
    }
}

run().catch(console.error);
