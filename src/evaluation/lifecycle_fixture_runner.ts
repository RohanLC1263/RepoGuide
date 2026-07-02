import { calculateValueScore } from "../memory/lifecycle/memoryValueCalculator";
import { InMemoryValueRepository } from "../memory/lifecycle/inMemoryValueRepository";
import { DormancyService } from "../memory/lifecycle/dormancyService";
import { BudgetEnforcementService } from "../memory/lifecycle/budgetEnforcementService";
import { LifecycleAwareRetriever } from "../memory/lifecycle/lifecycleAwareRetriever";
import { InMemoryTimelineStore } from "../memory/lifecycle/inMemoryTimelineStore";
import { TimelineEventEmitter } from "../memory/lifecycle/timelineEventEmitter";
import { InMemoryMemoryStore } from "../memory/inMemoryMemoryStore";

async function run() {
    console.log("Starting Lifecycle Services Phase B Fixture Runner...\n");
    let passed = 0;
    let failed = 0;

    // Common setup
    const valueRepo = new InMemoryValueRepository();
    const timelineStore = new InMemoryTimelineStore();
    const timelineEmitter = new TimelineEventEmitter(timelineStore);
    const dormancyService = new DormancyService(valueRepo, timelineEmitter);
    const budgetService = new BudgetEnforcementService(valueRepo, dormancyService);
    const memoryStore = new InMemoryMemoryStore();
    
    // Using MemoryStore itself as the inner retriever (since InMemoryMemoryStore implements MemoryRetriever too)
    // Actually we need to make sure the types match. We will cast it or wrap it if necessary.
    // InMemoryMemoryStore has `search` instead of `retrieve` in its signature initially, 
    // but the prompt says MemoryRetriever has `retrieve(query: MemoryQuery)`. 
    // We will build a simple wrapper.
    const innerRetriever = {
        retrieve: async (q: any) => memoryStore.search(q)
    };
    const retriever = new LifecycleAwareRetriever(innerRetriever, valueRepo);

    const assertPass = (name: string) => {
        console.log(`  [PASS] ${name}`);
        passed++;
    };
    const assertFail = (name: string, msg: string) => {
        console.error(`  [FAIL] ${name} - ${msg}`);
        failed++;
    };

    // Fixture 1: Value Score Calculation
    console.log("Executing: Fixture 1 - Value Score Calculation");
    const score = calculateValueScore({
        confidence: 0.9,
        usageFrequency: 0.8,
        impactScore: 0.8,
        recencyScore: 1.0,
        humanWeight: 1.0 // High human author weight
    });
    if (score > 0.8) assertPass("Fixture 1"); else assertFail("Fixture 1", `Expected > 0.8, got ${score}`);

    // Fixture 2: Dormancy Trigger
    console.log("Executing: Fixture 2 - Dormancy Trigger");
    await valueRepo.upsert({
        memoryId: "mem-low",
        repositoryId: "repo-1",
        confidence: 0.2, usageFrequency: 0.1, impactScore: 0.1, recencyScore: 0.1, humanWeight: 0.0,
        valueScore: 0.2,
        status: "active"
    });
    await dormancyService.evaluateMemory("mem-low");
    const meta2 = await valueRepo.getMetadata("mem-low");
    const events2 = await timelineStore.getEvents("mem-low");
    if (meta2?.status === "dormant" && events2.some(e => e.eventType === "dormant")) {
        assertPass("Fixture 2");
    } else {
        assertFail("Fixture 2", "Failed to transition to dormant or emit event");
    }

    // Fixture 3: Budget Enforcement
    console.log("Executing: Fixture 3 - Budget Enforcement");
    for (let i = 0; i < 5001; i++) {
        await valueRepo.upsert({
            memoryId: `mem-budget-${i}`,
            repositoryId: "repo-budget",
            confidence: 0.5, usageFrequency: 0.5, impactScore: 0.5, recencyScore: 0.5, humanWeight: 0.5,
            valueScore: i === 0 ? 0.05 : 0.8, // Make the first one the lowest value
            status: "active"
        });
    }
    await budgetService.enforceBudget("repo-budget");
    const activeBudget = await valueRepo.getAllActiveMetadata("repo-budget");
    const lowestMeta = await valueRepo.getMetadata("mem-budget-0");
    if (activeBudget.length === 5000 && lowestMeta?.status === "dormant") {
        assertPass("Fixture 3");
    } else {
        assertFail("Fixture 3", `Expected 5000 active, got ${activeBudget.length}. Lowest status: ${lowestMeta?.status}`);
    }

    // Fixture 4: Dormant Retrieval Exclusion
    console.log("Executing: Fixture 4 - Dormant Retrieval Exclusion");
    // Seed MemoryStore
    await memoryStore.create({ id: "mem-active", repositoryId: "repo-ret", content: "active fact", scope: "repo", scopeKeys: [], tags: [], stale: false, provenance: { authorType: 'user', timestamp: 'now' } } as any);
    await memoryStore.create({ id: "mem-dormant", repositoryId: "repo-ret", content: "dormant fact", scope: "repo", scopeKeys: [], tags: [], stale: false, provenance: { authorType: 'mentor', timestamp: 'now' } } as any);
    
    // Active memory doesn't strictly need metadata, or if it does it defaults to active
    await valueRepo.upsert({ memoryId: "mem-dormant", repositoryId: "repo-ret", confidence: 0, usageFrequency: 0, impactScore: 0, recencyScore: 0, humanWeight: 0, valueScore: 0, status: "dormant" });

    // Assuming our innerRetriever returns all created for the empty query 
    // (Wait, InMemoryStore auto-generates IDs like mem-1, mem-2. We need to be careful. Let's just create records directly)
    // Actually, I'll bypass store creation logic for testing and inject directly if needed. Or just use the search return.
    const allRecords = await memoryStore.search({});
    const activeRecordId = allRecords.find(r => r.content === "active fact")?.id || "";
    const dormantRecordId = allRecords.find(r => r.content === "dormant fact")?.id || "";
    
    // We must update the valueRepo with the REAL ids assigned by InMemoryStore
    await valueRepo.upsert({ memoryId: dormantRecordId, repositoryId: "repo-ret", confidence: 0, usageFrequency: 0, impactScore: 0, recencyScore: 0, humanWeight: 0, valueScore: 0, status: "dormant" });

    const retrieved = await retriever.retrieve({});
    if (retrieved.some(r => r.id === dormantRecordId)) {
        assertFail("Fixture 4", "Dormant memory was retrieved");
    } else if (!retrieved.some(r => r.id === activeRecordId)) {
        assertFail("Fixture 4", "Active memory was missing");
    } else {
        assertPass("Fixture 4");
    }

    // Fixture 5: Dormant Reactivation
    console.log("Executing: Fixture 5 - Dormant Reactivation");
    await dormancyService.reactivateMemory(dormantRecordId);
    const reactivatedMeta = await valueRepo.getMetadata(dormantRecordId);
    if (reactivatedMeta?.status === "active") {
        assertPass("Fixture 5");
    } else {
        assertFail("Fixture 5", "Memory failed to reactivate");
    }

    // Fixture 6: Retrieval Yield Validation
    console.log("Executing: Fixture 6 - Retrieval Yield Validation");
    const telemetry = retriever.getLastTelemetry();
    if (telemetry && telemetry.retrievalYield < 1.0 && telemetry.rawRetrieved > telemetry.activeReturned) {
        assertPass("Fixture 6");
    } else {
        assertFail("Fixture 6", `Yield incorrect. Raw: ${telemetry?.rawRetrieved}, Active: ${telemetry?.activeReturned}, Yield: ${telemetry?.retrievalYield}`);
    }

    console.log(`\nResults: ${passed} Passed, ${failed} Failed.`);
    if (failed > 0) {
        process.exit(1);
    }
}

run().catch(console.error);
