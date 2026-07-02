import { DatabaseSync } from 'node:sqlite';
import { createRuntimeDependencySchema } from '../runtime/dependencies/runtimeDependencySchema';
import { RuntimeDependencyStore } from '../runtime/dependencies/runtimeDependencyStore';
import { RuntimeDependencyQueryEngine } from '../runtime/dependencies/runtimeDependencyQueryEngine';
import * as assert from 'assert';

async function runTests() {
    const db = new DatabaseSync(':memory:');
    createRuntimeDependencySchema(db);
    const store = new RuntimeDependencyStore(db);
    const engine = new RuntimeDependencyQueryEngine(db);

    // Setup: auth_api -> user_service -> database_gateway
    // In our evidence ledger, source = depender, target = dependee
    // So source: auth_api, target: user_service
    store.appendEvidence({
        evidence_id: 'ev1',
        source_component_id: 'auth_api',
        target_component_id: 'user_service',
        dependency_type: 'CALL_DEPENDENCY',
        evidence_source: 'RUNTIME_TRACE',
        raw_confidence: 1.0
    });
    store.appendEvidence({
        evidence_id: 'ev2',
        source_component_id: 'user_service',
        target_component_id: 'database_gateway',
        dependency_type: 'CALL_DEPENDENCY',
        evidence_source: 'RUNTIME_TRACE',
        raw_confidence: 1.0
    });
    store.appendEvidence({
        evidence_id: 'ev3', // Add corroboration for explanation API
        source_component_id: 'user_service',
        target_component_id: 'database_gateway',
        dependency_type: 'CALL_DEPENDENCY',
        evidence_source: 'TEMPORAL_CORRELATION',
        raw_confidence: 0.6,
        discovered_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() // 10 days old to force decay
    });

    console.log("Running Test B1: getDirectDependencies");
    let direct = engine.getDirectDependencies('auth_api');
    assert.deepStrictEqual(direct, ['user_service'], "B1 Failed");

    console.log("Running Test B2: getDependents");
    let dependents = engine.getDependents('user_service');
    assert.deepStrictEqual(dependents, ['auth_api'], "B2 Failed");

    console.log("Running Test B3: getTransitiveDependents");
    let transitive = engine.getTransitiveDependents('database_gateway');
    assert.ok(transitive.includes('user_service') && transitive.includes('auth_api'), "B3 Failed");

    console.log("Running Test B4: Cycle Safety Test");
    // Inject A -> B, B -> A
    store.appendEvidence({
        evidence_id: 'cyc1', source_component_id: 'A', target_component_id: 'B', dependency_type: 'CALL', evidence_source: 'TRACE', raw_confidence: 1.0
    });
    store.appendEvidence({
        evidence_id: 'cyc2', source_component_id: 'B', target_component_id: 'A', dependency_type: 'CALL', evidence_source: 'TRACE', raw_confidence: 1.0
    });
    let cycDependents = engine.getTransitiveDependents('B');
    assert.ok(cycDependents.includes('A'), "B4 Failed (Cycle)");
    
    console.log("Running Test B5: getShortestPath");
    let path = engine.getShortestPath('database_gateway', 'auth_api');
    assert.deepStrictEqual(path, ['database_gateway', 'user_service', 'auth_api'], "B5 Failed");

    console.log("Running Test B6: getAllDependencyPaths");
    // Add redundant path: database_gateway -> cache_service -> auth_api
    store.appendEvidence({
        evidence_id: 'red1', source_component_id: 'cache_service', target_component_id: 'database_gateway', dependency_type: 'DATA', evidence_source: 'TRACE', raw_confidence: 1.0
    });
    store.appendEvidence({
        evidence_id: 'red2', source_component_id: 'auth_api', target_component_id: 'cache_service', dependency_type: 'CALL', evidence_source: 'TRACE', raw_confidence: 1.0
    });
    let allPaths = engine.getAllDependencyPaths('database_gateway', 'auth_api');
    assert.strictEqual(allPaths.length, 2, "B6 Failed: Should find 2 paths");

    console.log("Running Test B7: getConfidenceExplanation");
    let expl = engine.getConfidenceExplanation('user_service', 'database_gateway');
    assert.strictEqual(expl.baseConfidence, 1.0, "Explanation base incorrect");
    assert.ok(expl.corroborationBonus === 0.1, "Explanation corroboration incorrect: " + expl.corroborationBonus);
    assert.ok(expl.evidenceSources.includes('RUNTIME_TRACE'), "Explanation sources incorrect");
    assert.ok(expl.evidenceSources.includes('TEMPORAL_CORRELATION'), "Explanation sources incorrect");
    
    console.log("All Phase B tests passed!");
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});
