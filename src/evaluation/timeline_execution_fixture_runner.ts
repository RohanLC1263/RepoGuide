import { FIXTURES } from "./ingestion_fixture_library";
import { MemoryIngestionPipeline } from "../memory/ingestion/memoryIngestionPipeline";
import { InMemoryMemoryStore } from "../memory/inMemoryMemoryStore";
import { ValidationPipeline } from "../memory/ingestion/validationPipeline";
import { DeduplicationService } from "../memory/ingestion/deduplicationService";
import { ConflictResolutionService } from "../memory/ingestion/conflictResolutionService";
import { PromotionService } from "../memory/ingestion/promotionService";
import { InMemoryEphemeralMemoryRepository } from "../memory/ingestion/ephemeralMemoryRepository";
import { InMemoryTimelineStore } from "../memory/lifecycle/inMemoryTimelineStore";
import { TimelineEventEmitter } from "../memory/lifecycle/timelineEventEmitter";

async function run() {
    console.log("Starting Timeline Infrastructure Fixture Runner...\n");
    let passed = 0;
    let failed = 0;

    for (const test of FIXTURES) {
        console.log(`Executing: ${test.fixture.id} - ${test.fixture.description}`);
        
        const store = new InMemoryMemoryStore();
        for (const record of test.fixture.initialLanceDbState) {
            await store.create(record);
        }

        const timelineStore = new InMemoryTimelineStore();
        const timelineEmitter = new TimelineEventEmitter(timelineStore);
        const ephemeralRepo = new InMemoryEphemeralMemoryRepository();
        
        const pipeline = new MemoryIngestionPipeline(
            store,
            new ValidationPipeline(),
            new DeduplicationService(store),
            new ConflictResolutionService(store),
            new PromotionService(ephemeralRepo),
            timelineEmitter
        );

        let finalState = 'unknown';

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

        const allEvents = await timelineStore.getAllEvents();
        const actualEventTypes = allEvents.map(e => e.eventType);
        
        let success = true;

        if (finalState !== test.expected.finalMemoryState) {
            console.error(`  [FAIL] Expected state ${test.expected.finalMemoryState}, got ${finalState}`);
            success = false;
        }

        // Verify Expected Timeline Events
        // NOTE: Our test expectedTimelineEvents in FIXTURES might need 'created' added for promotion cases
        // since promotion now emits BOTH created and promoted.
        const expectedEvents = [...(test.expected.expectedTimelineEvents || [])];
        const promotedIdx = expectedEvents.indexOf('promoted');
        if (promotedIdx !== -1 && !expectedEvents.includes('created')) {
            expectedEvents.splice(promotedIdx, 0, 'created');
        }

        // Check if all expected events are present and in the correct relative order
        let expectedIdx = 0;
        for (const actualEvent of actualEventTypes) {
            if (expectedIdx < expectedEvents.length && actualEvent === expectedEvents[expectedIdx]) {
                expectedIdx++;
            }
        }

        if (expectedIdx < expectedEvents.length) {
            console.error(`  [FAIL] Expected timeline events: [${expectedEvents.join(', ')}], got: [${actualEventTypes.join(', ')}]`);
            success = false;
        }

        // Verify Event Timestamps are monotonically increasing
        let lastTime = 0;
        for (const evt of allEvents) {
            const t = new Date(evt.timestamp).getTime();
            if (t < lastTime) {
                console.error(`  [FAIL] Event timestamps are not strictly ordered: ${evt.eventId}`);
                success = false;
            }
            lastTime = t;
        }

        if (success) {
            console.log(`  [PASS] Events: [${actualEventTypes.join(', ')}]`);
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
