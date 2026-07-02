import { DatabaseSync } from 'node:sqlite';
import { RepositoryBrainOrchestrator } from '../orchestrator/repositoryBrainOrchestrator';
import { OrchestratorStore } from '../orchestrator/orchestratorStore';
import { createRuntimeBlastRadiusSchema } from '../runtime/blast_radius/runtimeBlastRadiusSchema';
import { RuntimeBlastRadiusStore } from '../runtime/blast_radius/runtimeBlastRadiusStore';
import { RuntimeBlastRadiusCalculator, BlastRadiusExplanation } from '../runtime/blast_radius/runtimeBlastRadiusCalculator';
import { RuntimeBlastRadiusBuilder } from '../runtime/blast_radius/runtimeBlastRadiusBuilder';
import { RuntimeDependencyQueryEngine } from '../runtime/dependencies/runtimeDependencyQueryEngine';
import { createRuntimeDependencySchema } from '../runtime/dependencies/runtimeDependencySchema';
import { RuntimeDependencyStore } from '../runtime/dependencies/runtimeDependencyStore';
import { RuntimeBlastRadiusQueryEngine } from '../runtime/blast_radius/runtimeBlastRadiusQueryEngine';
import * as assert from 'assert';

async function runTests() {
    console.log("Starting Phase E Production Verification Sprint");

    const db = new DatabaseSync(':memory:');
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_health_history (
            component_id TEXT,
            status TEXT,
            computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    
    createRuntimeDependencySchema(db);
    createRuntimeBlastRadiusSchema(db);

    const depStore = new RuntimeDependencyStore(db);
    const queryEngine = new RuntimeDependencyQueryEngine(db);
    const calculator = new RuntimeBlastRadiusCalculator(queryEngine);
    const radiusStore = new RuntimeBlastRadiusStore(db);
    const readQueryEngine = new RuntimeBlastRadiusQueryEngine(db);

    // Helper to inject edges
    const addEdge = (src: string, tgt: string, conf: number = 1.0, type: string = 'HARD_DEPENDENCY') => {
        depStore.appendEvidence({
            evidence_id: require('crypto').randomUUID(),
            source_component_id: src,
            target_component_id: tgt,
            dependency_type: type,
            evidence_source: 'EXPLICIT_CONFIG',
            raw_confidence: conf
        });
    };

    console.log("CATEGORY_1: Real Blast Radius Generation");
    addEdge('user_service', 'database_gateway');
    addEdge('auth_api', 'user_service');

    const res1 = calculator.calculate('cat1', [{ component_id: 'database_gateway', riskScore: 1.0 }]);
    radiusStore.saveBatch(res1);

    const r1 = readQueryEngine.getBlastRadiusScore('user_service', 'cat1');
    const r2 = readQueryEngine.getBlastRadiusScore('auth_api', 'cat1');
    assert.ok(r1 > 0, "Cat 1 Failed: user_service received 0 risk");
    assert.ok(r2 > 0, "Cat 1 Failed: auth_api received 0 risk");

    console.log("CATEGORY_2: Multi-Source Outage Simulation");
    addEdge('auth_api_2', 'database_gateway');
    addEdge('auth_api_2', 'cache_cluster');

    const res2 = calculator.calculate('cat2', [
        { component_id: 'database_gateway', riskScore: 0.8 },
        { component_id: 'cache_cluster', riskScore: 0.6 }
    ]);
    radiusStore.saveBatch(res2);

    const expl2: BlastRadiusExplanation = readQueryEngine.getBlastRadiusExplanation('database_gateway', 'auth_api_2', 'cat2')!;
    const expectedRisk = 1 - ((1 - 0.8) * (1 - 0.6));
    assert.strictEqual(expl2.finalAggregatedRisk, Number(expectedRisk.toFixed(4)), "Cat 2 Failed: Probabilistic union incorrect");

    console.log("CATEGORY_3: Maximum Path Envelope Validation");
    addEdge('B', 'A');
    addEdge('C', 'A', 0.5); // weak link
    addEdge('D', 'B');
    addEdge('D', 'C');

    const res3 = calculator.calculate('cat3', [{ component_id: 'A', riskScore: 1.0 }]);
    radiusStore.saveBatch(res3);

    const expl3: BlastRadiusExplanation = readQueryEngine.getBlastRadiusExplanation('A', 'D', 'cat3')!;
    assert.strictEqual(expl3.contributingSources.length, 1, "Cat 3 Failed: Path inflated");
    assert.deepStrictEqual(expl3.contributingSources[0].envelopePath, ['A', 'B', 'D'], "Cat 3 Failed: Wrong path chosen");

    console.log("CATEGORY_4: Deep Chain Decay Validation");
    const hops = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10', 'N11'];
    for (let i = 1; i < hops.length; i++) {
        addEdge(hops[i], hops[i-1]);
    }
    const res4 = calculator.calculate('cat4', [{ component_id: 'N1', riskScore: 1.0 }]);
    radiusStore.saveBatch(res4);
    
    const r11 = readQueryEngine.getBlastRadiusScore('N11', 'cat4');
    assert.ok(r11 > 0, "Cat 4 Failed: Deep chain zeroed out");
    const expectedR11 = Math.pow(0.85, 9);
    assert.strictEqual(r11.toFixed(4), expectedR11.toFixed(4), "Cat 4 Failed: Decay math incorrect");

    console.log("CATEGORY_5: Historical Reconstruction Validation");
    const cycles = ['cycle_1', 'cycle_2', 'cycle_3'];
    for (const c of cycles) {
        radiusStore.saveBatch([{
            orchestrator_cycle_id: c,
            target_component_id: 'history_target',
            blast_radius_score: 0.99,
            explanation_json: '{}'
        }]);
    }
    assert.strictEqual(readQueryEngine.getBlastRadiusScore('history_target', 'cycle_1'), 0.99, "Cat 5 Failed");
    assert.strictEqual(readQueryEngine.getBlastRadiusScore('history_target', 'cycle_2'), 0.99, "Cat 5 Failed");

    console.log("CATEGORY_6: Failure Isolation Validation");
    const orchStore = new OrchestratorStore(db);
    const mockBuilder = () => ({ build: async () => {} });
    const builders: any = {
        authorExpertise: mockBuilder(),
        logicalCoupling: mockBuilder(),
        driftEngine: mockBuilder(),
        knowledgeHotspots: mockBuilder(),
        knowledgeValidity: mockBuilder(),
        architecturalEvolution: mockBuilder(),
        testCoverage: mockBuilder(),
        decisionOutcomes: mockBuilder(),
        causalReasoning: mockBuilder(),
        incidentBuilder: mockBuilder(),
        incidentIntelligence: mockBuilder(),
        changeImpact: mockBuilder(),
        predictionAccountability: mockBuilder(),
        runtimeIntelligence: mockBuilder(),
        runtimeDependency: mockBuilder(),
        runtimeBlastRadius: {
            build: async () => { throw new Error("Cat 6 Fatal"); }
        }
    };
    const orchestrator = new RepositoryBrainOrchestrator(orchStore, builders);
    await orchestrator.runFullRebuild();
    assert.strictEqual(orchStore.getState()?.status, 'COMPLETED', "Cat 6 Failed");

    console.log("CATEGORY_7: Rollback Validation");
    db.exec(`DROP TABLE runtime_blast_radius`);
    builders.runtimeBlastRadius = {
        build: async (cycleId: string) => {
            const builder = new RuntimeBlastRadiusBuilder(db, calculator, radiusStore);
            await builder.build(cycleId);
        }
    };
    await orchestrator.runFullRebuild();
    assert.strictEqual(orchStore.getState()?.status, 'COMPLETED', "Cat 7 Failed");

    console.log("All Phase E Verifications Passed!");
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});
