import { DatabaseSync } from 'node:sqlite';
import { createRuntimeDependencySchema } from '../runtime/dependencies/runtimeDependencySchema';
import { RuntimeDependencyStore } from '../runtime/dependencies/runtimeDependencyStore';
import { RuntimeDependencyDiscoveryBuilder } from '../runtime/dependencies/runtimeDependencyDiscoveryBuilder';
import { RuntimeDependencyQueryEngine } from '../runtime/dependencies/runtimeDependencyQueryEngine';
import { RepositoryBrainOrchestrator, BrainBuilders } from '../orchestrator/repositoryBrainOrchestrator';
import { OrchestratorStore } from '../orchestrator/orchestratorStore';
import { RepositoryBuilder } from '../orchestrator/orchestratorTypes';
import * as assert from 'assert';

async function runTests() {
    const db = new DatabaseSync(':memory:');
    createRuntimeDependencySchema(db);
    const store = new RuntimeDependencyStore(db);
    const builder = new RuntimeDependencyDiscoveryBuilder(db, store);
    const engine = new RuntimeDependencyQueryEngine(db);

    console.log("Running Verification Category 1: Real Dependency Graph Creation");
    builder.discoverExplicitDependencies([
        { component: 'auth_api', dependencies: ['user_service', 'cache_service'] },
        { component: 'user_service', dependencies: ['database_gateway'] },
        { component: 'cache_service', dependencies: ['database_gateway'] }
    ]);
    const activeGraph = store.getActiveGraph();
    assert.strictEqual(activeGraph.length, 4, "Cat 1 Failed: Should have 4 edges");
    
    console.log("Running Verification Category 2: Historical Reconstruction");
    db.exec(`DELETE FROM runtime_dependency_evidence`);
    const day1 = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const day5 = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const day10 = new Date(Date.now()).toISOString();
    
    // Day 1
    store.appendEvidence({
        evidence_id: 'v2_1', source_component_id: 'auth_api', target_component_id: 'user_service',
        dependency_type: 'HARD', evidence_source: 'TRACE', raw_confidence: 1.0, discovered_at: day1
    });
    // Day 5
    store.appendEvidence({
        evidence_id: 'v2_2', source_component_id: 'auth_api', target_component_id: 'cache_service',
        dependency_type: 'HARD', evidence_source: 'TRACE', raw_confidence: 1.0, discovered_at: day5
    });
    // Day 10 Tombstone
    store.appendEvidence({
        evidence_id: 'v2_3', source_component_id: 'auth_api', target_component_id: 'cache_service',
        dependency_type: 'TOMBSTONE', evidence_source: 'CONFIG', raw_confidence: 0, discovered_at: day10
    });

    const queryPointInTime = (timestamp: string) => {
        return db.prepare(`
            SELECT source_component_id, target_component_id 
            FROM runtime_dependency_evidence e
            WHERE discovered_at <= ? AND dependency_type != 'TOMBSTONE'
            AND NOT EXISTS (
                SELECT 1 FROM runtime_dependency_evidence t
                WHERE t.dependency_type = 'TOMBSTONE' 
                AND t.discovered_at <= ?
                AND t.source_component_id = e.source_component_id
                AND t.target_component_id = e.target_component_id
            )
        `).all(timestamp, timestamp) as any[];
    };
    
    assert.strictEqual(queryPointInTime(day1).length, 1, "Cat 2 Failed: Day 1");
    assert.strictEqual(queryPointInTime(day5).length, 2, "Cat 2 Failed: Day 5");
    assert.strictEqual(queryPointInTime(day10).length, 1, "Cat 2 Failed: Day 10");

    console.log("Running Verification Category 3: Recency Decay Validation");
    db.exec(`DELETE FROM runtime_dependency_evidence`);
    const day35 = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    store.appendEvidence({
        evidence_id: 'v3_1', source_component_id: 'api', target_component_id: 'db1',
        dependency_type: 'HARD', evidence_source: 'TRACE', raw_confidence: 1.0 // Fresh
    });
    store.appendEvidence({
        evidence_id: 'v3_2', source_component_id: 'api', target_component_id: 'db2',
        dependency_type: 'HARD', evidence_source: 'TRACE', raw_confidence: 1.0, discovered_at: day1 // 10 days old
    });
    store.appendEvidence({
        evidence_id: 'v3_3', source_component_id: 'api', target_component_id: 'db3',
        dependency_type: 'HARD', evidence_source: 'TRACE', raw_confidence: 1.0, discovered_at: day35 // 35 days old
    });
    
    const decGraph = store.getActiveGraph();
    const c1 = decGraph.find(e => e.target_component_id === 'db1').final_confidence;
    const c2 = decGraph.find(e => e.target_component_id === 'db2').final_confidence;
    const c3 = decGraph.find(e => e.target_component_id === 'db3').final_confidence;
    assert.strictEqual(c1, 1.0, "Cat 3 Failed: Fresh");
    assert.ok(c2 < 1.0 && c2 > 0.5, "Cat 3 Failed: 10 days");
    assert.ok(c3 < 0.5 && c3 > 0, "Cat 3 Failed: 35 days");

    console.log("Running Verification Category 4: Path Resolution");
    db.exec(`DELETE FROM runtime_dependency_evidence`);
    builder.discoverExplicitDependencies([
        { component: 'auth_api', dependencies: ['user_service', 'cache_service'] },
        { component: 'user_service', dependencies: ['database_gateway'] },
        { component: 'cache_service', dependencies: ['database_gateway'] }
    ]);
    const paths = engine.getAllDependencyPaths('database_gateway', 'auth_api');
    assert.strictEqual(paths.length, 2, "Cat 4 Failed: Expected 2 paths");
    const shortest = engine.getShortestPath('database_gateway', 'auth_api');
    assert.strictEqual(shortest.length, 3, "Cat 4 Failed: Shortest path length");
    const expl = engine.getConfidenceExplanation('auth_api', 'user_service');
    assert.strictEqual(expl.finalConfidence, 1.0, "Cat 4 Failed: Expl");

    console.log("Running Verification Category 5: Cycle Safety");
    builder.discoverExplicitDependencies([
        { component: 'A', dependencies: ['B'] },
        { component: 'B', dependencies: ['C'] },
        { component: 'C', dependencies: ['A'] }
    ]);
    const cycTransitive = engine.getTransitiveDependents('A');
    assert.ok(cycTransitive.includes('B') && cycTransitive.includes('C'), "Cat 5 Failed: Transitive");
    const cycPaths = engine.getAllDependencyPaths('C', 'A');
    assert.ok(cycPaths.length >= 1, "Cat 5 Failed: All Paths Cycle");
    const cycShortest = engine.getShortestPath('C', 'A');
    assert.ok(cycShortest.length >= 2, "Cat 5 Failed: Shortest Path Cycle");

    console.log("Running Verification Category 6: Orchestrator E2E");
    db.exec(`
        CREATE TABLE IF NOT EXISTS orchestrator_state (
            id TEXT PRIMARY KEY, last_full_rebuild_start TEXT, last_full_rebuild_end TEXT, status TEXT, failed_at_step TEXT, diagnostics TEXT
        );
        CREATE TABLE IF NOT EXISTS runtime_health_history (
            component_id TEXT, health_score REAL, status TEXT, computed_at DATETIME
        );
        DELETE FROM runtime_health_history;
    `);
    const t0 = Date.now();
    for(let i = 0; i < 3; i++) {
        const time = t0 + i * 100000;
        db.prepare(`INSERT INTO runtime_health_history (component_id, status, computed_at) VALUES (?, 'DEGRADED', ?)`).run('e2e_db', new Date(time).toISOString());
        db.prepare(`INSERT INTO runtime_health_history (component_id, status, computed_at) VALUES (?, 'DEGRADED', ?)`).run('e2e_api', new Date(time + 5000).toISOString());
    }
    
    const oStore = new OrchestratorStore(db);
    let mockFired = false;
    const createMock = (name: string): RepositoryBuilder => ({ build: async () => {} });
    const builders: BrainBuilders = {
        authorExpertise: createMock('A'), logicalCoupling: createMock('B'), driftEngine: createMock('C'),
        knowledgeHotspots: createMock('D'), knowledgeValidity: createMock('E'), architecturalEvolution: createMock('F'),
        testCoverage: createMock('G'), decisionOutcomes: createMock('H'), causalReasoning: createMock('I'),
        incidentBuilder: createMock('J'), incidentIntelligence: createMock('K'), changeImpact: createMock('L'),
        predictionAccountability: createMock('M'), runtimeIntelligence: createMock('N'),
        runtimeDependency: {
            build: async () => {
                mockFired = true;
                builder.discoverTemporalCorrelations();
            }
        }
    };
    const orchestrator = new RepositoryBrainOrchestrator(oStore, builders);
    await orchestrator.runFullRebuild();
    assert.ok(mockFired, "Cat 6 Failed: Orchestrator didn't fire builder");
    const e2eEvidence = store.getAllEvidence().filter(e => e.source_component_id === 'e2e_api' && e.target_component_id === 'e2e_db');
    assert.strictEqual(e2eEvidence.length, 1, "Cat 6 Failed: Engine didn't extract temporal history");

    console.log("Running Verification Category 7: Rollback Validation");
    db.exec(`DROP VIEW IF EXISTS runtime_component_dependencies`);
    db.exec(`DROP TABLE IF EXISTS runtime_dependency_evidence`);
    
    let crash = false;
    builders.runtimeDependency = { build: async () => { store.getAllEvidence(); } }; // Force error
    try {
        await orchestrator.runFullRebuild();
    } catch (e) {
        crash = true;
    }
    assert.strictEqual(crash, false, "Cat 7 Failed: Orchestrator crashed");
    assert.strictEqual(oStore.getState()?.status, 'COMPLETED', "Cat 7 Failed: Status not completed");

    console.log("All Phase E tests passed!");
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});
