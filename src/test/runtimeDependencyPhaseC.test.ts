import { DatabaseSync } from 'node:sqlite';
import { createRuntimeDependencySchema } from '../runtime/dependencies/runtimeDependencySchema';
import { RuntimeDependencyStore } from '../runtime/dependencies/runtimeDependencyStore';
import { RuntimeDependencyDiscoveryBuilder } from '../runtime/dependencies/runtimeDependencyDiscoveryBuilder';
import * as assert from 'assert';

async function runTests() {
    const db = new DatabaseSync(':memory:');
    createRuntimeDependencySchema(db);
    
    // Create dummy runtime_health_history table for tests
    db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_health_history (
            component_id TEXT,
            health_score REAL,
            status TEXT,
            computed_at DATETIME
        );
    `);

    const store = new RuntimeDependencyStore(db);
    const builder = new RuntimeDependencyDiscoveryBuilder(db, store);

    console.log("Running Test C1: Explicit Dependency Discovery");
    builder.discoverExplicitDependencies([{
        component: 'auth_api',
        dependencies: ['user_service']
    }]);
    let evidence = store.getAllEvidence();
    assert.strictEqual(evidence.length, 1, "C1 Failed: Should have 1 explicit edge");
    assert.strictEqual(evidence[0].source_component_id, 'auth_api');
    assert.strictEqual(evidence[0].target_component_id, 'user_service');
    assert.strictEqual(evidence[0].raw_confidence, 1.0);
    assert.strictEqual(evidence[0].evidence_source, 'EXPLICIT_CONFIG');

    console.log("Running Test C2: Macro Event Rejection");
    // Inject 5 components degrading within 10 seconds
    const t0 = Date.now();
    for (let i = 1; i <= 5; i++) {
        db.prepare(`INSERT INTO runtime_health_history (component_id, status, computed_at) VALUES (?, 'CRITICAL', ?)`).run(
            `svc_${i}`, new Date(t0 + i * 1000).toISOString()
        );
    }
    builder.discoverTemporalCorrelations();
    evidence = store.getAllEvidence().filter(e => e.evidence_source === 'TEMPORAL_CORRELATION');
    assert.strictEqual(evidence.length, 0, "C2 Failed: Macro event created correlation edges");

    console.log("Running Test C3 & C4: Directional Causality and Frequency Threshold");
    db.exec(`DELETE FROM runtime_health_history`);
    
    // We need target (db_gateway) degrading 5s before source (usr_svc)
    // Frequency = 3 times spread out > 60s
    for (let occurrence = 0; occurrence < 3; occurrence++) {
        const baseTime = t0 + occurrence * 100000; // 100 seconds apart
        // Target degrades
        db.prepare(`INSERT INTO runtime_health_history (component_id, status, computed_at) VALUES (?, 'DEGRADED', ?)`).run(
            'database_gateway', new Date(baseTime).toISOString()
        );
        // Source degrades 5 seconds later
        db.prepare(`INSERT INTO runtime_health_history (component_id, status, computed_at) VALUES (?, 'DEGRADED', ?)`).run(
            'user_service', new Date(baseTime + 5000).toISOString()
        );
    }
    
    // The test naturally verifies reverse edge is NOT inferred from the above valid occurrences.

    builder.discoverTemporalCorrelations();
    evidence = store.getAllEvidence().filter(e => e.evidence_source === 'TEMPORAL_CORRELATION');
    
    assert.strictEqual(evidence.length, 1, "C3/C4 Failed: Should have exactly 1 valid correlation edge");
    assert.strictEqual(evidence[0].source_component_id, 'user_service');
    assert.strictEqual(evidence[0].target_component_id, 'database_gateway');

    console.log("Running Test C5: Confidence Cap");
    assert.strictEqual(evidence[0].raw_confidence, 0.6, "C5 Failed: Correlation confidence must be capped at 0.6");

    console.log("All Phase C tests passed!");
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});
