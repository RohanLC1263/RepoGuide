import { DatabaseSync } from 'node:sqlite';
import { createRuntimeBlastRadiusSchema } from '../runtime/blast_radius/runtimeBlastRadiusSchema';
import { RuntimeBlastRadiusStore, BlastRadiusRecord } from '../runtime/blast_radius/runtimeBlastRadiusStore';
import * as assert from 'assert';

async function runTests() {
    const db = new DatabaseSync(':memory:');
    
    console.log("Running T_A1: Schema Creation");
    createRuntimeBlastRadiusSchema(db);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_blast_radius'`).all();
    assert.strictEqual(tables.length, 1, "T_A1 Failed: Table not created");

    const store = new RuntimeBlastRadiusStore(db);

    console.log("Running T_A2: Batch Transaction Validation");
    const cycle1 = 'cycle-1111';
    const batch: BlastRadiusRecord[] = [];
    for (let i = 0; i < 50; i++) {
        batch.push({
            orchestrator_cycle_id: cycle1,
            target_component_id: `comp_${i}`,
            blast_radius_score: 0.85,
            explanation_json: '{"test": "payload"}'
        });
    }
    store.saveBatch(batch);
    const result1 = store.getByCycleId(cycle1);
    assert.strictEqual(result1.length, 50, "T_A2 Failed: Batch insert failed");

    console.log("Running T_A3: Rollback Validation");
    const cycle2 = 'cycle-2222';
    const invalidBatch: any[] = [
        {
            orchestrator_cycle_id: cycle2,
            target_component_id: 'valid_comp',
            blast_radius_score: 0.5,
            explanation_json: '{}'
        },
        {
            orchestrator_cycle_id: cycle2, // Missing fields to force SQL error
        }
    ];
    let caught = false;
    try {
        store.saveBatch(invalidBatch as BlastRadiusRecord[]);
    } catch (e) {
        caught = true;
    }
    assert.ok(caught, "T_A3 Failed: Expected transaction to throw");
    const result2 = store.getByCycleId(cycle2);
    assert.strictEqual(result2.length, 0, "T_A3 Failed: Rollback did not cleanly revert partial inserts");

    console.log("Running T_A4: Cycle Isolation Validation");
    const cycle3 = 'cycle-3333';
    store.saveBatch([
        { orchestrator_cycle_id: cycle3, target_component_id: 'c1', blast_radius_score: 0.1, explanation_json: '{}' }
    ]);
    const r1 = store.getByCycleId(cycle1);
    const r3 = store.getByCycleId(cycle3);
    assert.strictEqual(r1.length, 50, "T_A4 Failed: Isolation breach on cycle 1");
    assert.strictEqual(r3.length, 1, "T_A4 Failed: Isolation breach on cycle 3");

    console.log("Running T_A5: Explanation Payload Persistence");
    const complexJson = JSON.stringify({
        target: "auth_api",
        finalAggregatedRisk: 0.88,
        unionCalculation: "1 - (1-0.80)*(1-0.40)",
        contributingSources: [
            { source: "db", envelopePath: ["db", "api"], dependencyTypes: ["HARD"], sourceRisk: 0.8 }
        ]
    });
    const cycle4 = 'cycle-4444';
    store.saveBatch([
        { orchestrator_cycle_id: cycle4, target_component_id: 'auth_api', blast_radius_score: 0.88, explanation_json: complexJson }
    ]);
    const r4 = store.getByCycleId(cycle4);
    assert.strictEqual(r4[0].explanation_json, complexJson, "T_A5 Failed: JSON payload corrupted");

    console.log("All Phase A tests passed!");
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});
