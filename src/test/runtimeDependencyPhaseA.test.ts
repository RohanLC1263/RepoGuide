import { DatabaseSync } from 'node:sqlite';
import { createRuntimeDependencySchema } from '../runtime/dependencies/runtimeDependencySchema';
import { RuntimeDependencyStore } from '../runtime/dependencies/runtimeDependencyStore';
import * as assert from 'assert';

async function runTests() {
    const db = new DatabaseSync(':memory:');
    createRuntimeDependencySchema(db);
    const store = new RuntimeDependencyStore(db);

    console.log("Running Test A1: Schema Creation");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='view'").all() as any[];
    const names = tables.map(t => t.name);
    assert.ok(names.includes('runtime_dependency_evidence'), "Ledger table missing");
    assert.ok(names.includes('runtime_component_dependencies'), "View missing");

    console.log("Running Test A2: Append-Only Ledger");
    store.appendEvidence({
        evidence_id: 'ev1',
        source_component_id: 'auth_api',
        target_component_id: 'user_service',
        dependency_type: 'CALL_DEPENDENCY',
        evidence_source: 'RUNTIME_TRACE',
        raw_confidence: 0.9
    });
    store.appendEvidence({
        evidence_id: 'ev2',
        source_component_id: 'auth_api',
        target_component_id: 'user_service',
        dependency_type: 'CALL_DEPENDENCY',
        evidence_source: 'RUNTIME_TRACE',
        raw_confidence: 0.8
    });
    const allEvidence = store.getAllEvidence();
    assert.strictEqual(allEvidence.length, 2, "Evidence was not preserved");

    console.log("Running Test A3: Confidence Aggregation");
    store.appendEvidence({
        evidence_id: 'ev3',
        source_component_id: 'auth_api',
        target_component_id: 'user_service',
        dependency_type: 'CALL_DEPENDENCY',
        evidence_source: 'EXPLICIT_CONFIG',
        raw_confidence: 1.0
    });
    store.appendEvidence({
        evidence_id: 'ev4',
        source_component_id: 'auth_api',
        target_component_id: 'user_service',
        dependency_type: 'CALL_DEPENDENCY',
        evidence_source: 'TEMPORAL_CORRELATION',
        raw_confidence: 0.6
    });
    
    let activeGraph = store.getActiveGraph();
    let authToUser = activeGraph.find(e => e.source_component_id === 'auth_api');
    assert.strictEqual(authToUser.corroboration_count, 3, "Corroboration count should be 3");
    // Base is 1.0 (EXPLICIT), 2 extra sources -> 1.0 + 0.2 = 1.2 -> capped at 1.0
    assert.strictEqual(authToUser.final_confidence, 1.0, "Confidence aggregation failed");

    console.log("Running Test A4: Recency Decay");
    // Clear db
    db.exec('DELETE FROM runtime_dependency_evidence');
    // Insert 35 day old trace
    store.appendEvidence({
        evidence_id: 'ev5',
        source_component_id: 'api',
        target_component_id: 'db',
        dependency_type: 'CALL_DEPENDENCY',
        evidence_source: 'RUNTIME_TRACE',
        raw_confidence: 1.0,
        discovered_at: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString()
    });
    // Insert 1 day old trace
    store.appendEvidence({
        evidence_id: 'ev6',
        source_component_id: 'api',
        target_component_id: 'db',
        dependency_type: 'CALL_DEPENDENCY',
        evidence_source: 'TEMPORAL_CORRELATION',
        raw_confidence: 0.5,
        discovered_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
    });
    
    activeGraph = store.getActiveGraph();
    let apiToDb = activeGraph.find(e => e.source_component_id === 'api');
    // 35 day old trace: 1.0 * 0.5 * (1.0 - 5/60) = 0.5 * 0.916 = ~0.458
    // 1 day old correlation: 0.5 * 1.0 = 0.5
    // Max of these is 0.5. Corroboration +0.1 => 0.6
    assert.ok(Math.abs(apiToDb.final_confidence - 0.6) < 0.05, "Recency decay incorrect: " + apiToDb.final_confidence);

    console.log("Running Test A5: Tombstone Validation");
    store.appendEvidence({
        evidence_id: 'tomb1',
        source_component_id: 'api',
        target_component_id: 'db',
        dependency_type: 'TOMBSTONE',
        evidence_source: 'EXPLICIT_CONFIG',
        raw_confidence: 0.0
    });
    activeGraph = store.getActiveGraph();
    assert.strictEqual(activeGraph.length, 0, "Tombstone failed to remove edge");

    console.log("Running Test A6: Pruning Validation");
    db.exec('DELETE FROM runtime_dependency_evidence');
    store.appendEvidence({
        evidence_id: 'ev7',
        source_component_id: 'old_api',
        target_component_id: 'cache',
        dependency_type: 'CALL_DEPENDENCY',
        evidence_source: 'RUNTIME_TRACE',
        raw_confidence: 1.0,
        discovered_at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString()
    });
    store.appendEvidence({
        evidence_id: 'ev8',
        source_component_id: 'old_api',
        target_component_id: 'cache',
        dependency_type: 'CALL_DEPENDENCY',
        evidence_source: 'EXPLICIT_CONFIG',
        raw_confidence: 1.0,
        discovered_at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString()
    });
    
    store.pruneGhostNodes();
    const remaining = store.getAllEvidence();
    assert.strictEqual(remaining.length, 1, "Pruning removed wrong number of rows");
    assert.strictEqual(remaining[0].evidence_source, 'EXPLICIT_CONFIG', "Pruning removed EXPLICIT_CONFIG");

    console.log("All Phase A tests passed!");
}

runTests().catch(console.error);
