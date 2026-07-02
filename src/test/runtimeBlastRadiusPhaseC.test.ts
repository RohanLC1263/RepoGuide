import { DatabaseSync } from 'node:sqlite';
import { createRuntimeBlastRadiusSchema } from '../runtime/blast_radius/runtimeBlastRadiusSchema';
import { RuntimeBlastRadiusStore } from '../runtime/blast_radius/runtimeBlastRadiusStore';
import { RuntimeBlastRadiusQueryEngine } from '../runtime/blast_radius/runtimeBlastRadiusQueryEngine';
import { BlastRadiusExplanation } from '../runtime/blast_radius/runtimeBlastRadiusCalculator';
import * as assert from 'assert';

async function runTests() {
    const db = new DatabaseSync(':memory:');
    createRuntimeBlastRadiusSchema(db);
    const store = new RuntimeBlastRadiusStore(db);
    const queryEngine = new RuntimeBlastRadiusQueryEngine(db);

    console.log("Running T_C6: Empty Graph Safety");
    assert.deepStrictEqual(queryEngine.getBlastRadius('any'), [], "T_C6 Failed: getBlastRadius empty");
    assert.deepStrictEqual(queryEngine.getAffectedComponents('any'), [], "T_C6 Failed: getAffectedComponents empty");
    assert.deepStrictEqual(queryEngine.getCriticalPaths('any'), [], "T_C6 Failed: getCriticalPaths empty");
    assert.strictEqual(queryEngine.getBlastRadiusExplanation('s', 't'), null, "T_C6 Failed: getBlastRadiusExplanation empty");
    assert.strictEqual(queryEngine.getBlastRadiusScore('any'), 0, "T_C6 Failed: getBlastRadiusScore empty");

    // Populate Data
    const cycle1 = 'cycle-1111';
    const expl1: BlastRadiusExplanation = {
        target: 'Target_A',
        finalAggregatedRisk: 0.85,
        orchestratorCycleId: cycle1,
        unionCalculation: '1 - (1-0.85)',
        contributingSources: [
            {
                source: 'Source_A',
                envelopePath: ['Source_A', 'Mid_1', 'Target_A'],
                dependencyTypes: ['HARD_DEPENDENCY', 'HARD_DEPENDENCY'],
                sourceRisk: 1.0,
                distanceDecayApplied: 0.85,
                propagatedEnvelopeRisk: 0.85
            }
        ]
    };

    const cycle2 = 'cycle-2222';
    const expl2: BlastRadiusExplanation = {
        target: 'Target_B',
        finalAggregatedRisk: 0.40,
        orchestratorCycleId: cycle2,
        unionCalculation: '1 - (1-0.40)',
        contributingSources: [
            {
                source: 'Source_A',
                envelopePath: ['Source_A', 'Target_B'],
                dependencyTypes: ['CORRELATED_DEPENDENCY'],
                sourceRisk: 1.0,
                distanceDecayApplied: 1.0,
                propagatedEnvelopeRisk: 0.40
            }
        ]
    };

    store.saveBatch([
        { orchestrator_cycle_id: cycle1, target_component_id: 'Target_A', blast_radius_score: 0.85, explanation_json: JSON.stringify(expl1) }
    ]);
    // Small delay to ensure generated_at orders correctly if needed, though they are explicitly queried by cycle id
    await new Promise(r => setTimeout(r, 100));
    store.saveBatch([
        { orchestrator_cycle_id: cycle2, target_component_id: 'Target_B', blast_radius_score: 0.40, explanation_json: JSON.stringify(expl2) }
    ]);

    console.log("Running T_C1: Blast Radius Retrieval");
    const affected = queryEngine.getAffectedComponents('Source_A', cycle1);
    assert.deepStrictEqual(affected, ['Target_A'], "T_C1 Failed: Expected Target_A");
    
    const radius = queryEngine.getBlastRadius('Source_A', cycle1);
    assert.strictEqual(radius[0].target, 'Target_A');
    assert.strictEqual(radius[0].risk, 0.85);

    console.log("Running T_C2: Critical Path Filtering");
    const critical1 = queryEngine.getCriticalPaths('Source_A', cycle1);
    assert.strictEqual(critical1.length, 1, "T_C2 Failed: Expected 1 critical path");
    assert.deepStrictEqual(critical1[0], ['Source_A', 'Mid_1', 'Target_A']);

    const critical2 = queryEngine.getCriticalPaths('Source_A', cycle2);
    assert.strictEqual(critical2.length, 0, "T_C2 Failed: Path < 0.70 should be excluded");

    console.log("Running T_C3: Explanation Retrieval");
    const payload = queryEngine.getBlastRadiusExplanation('Source_A', 'Target_A', cycle1);
    assert.notStrictEqual(payload, null, "T_C3 Failed: Payload not found");
    assert.strictEqual(payload!.finalAggregatedRisk, 0.85);
    assert.strictEqual(payload!.contributingSources[0].source, 'Source_A');

    console.log("Running T_C4: Aggregated Risk Lookup");
    const score = queryEngine.getBlastRadiusScore('Target_A', cycle1);
    assert.strictEqual(score, 0.85, "T_C4 Failed: Risk score mismatch");

    console.log("Running T_C5: Cycle Isolation Validation");
    const c1Paths = queryEngine.getCriticalPaths('Source_A', cycle1);
    const c2Paths = queryEngine.getCriticalPaths('Source_A', cycle2);
    assert.notDeepStrictEqual(c1Paths, c2Paths, "T_C5 Failed: Cycles bleed together");

    console.log("All Phase C tests passed!");
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});
