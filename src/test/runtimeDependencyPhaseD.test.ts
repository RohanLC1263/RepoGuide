import { DatabaseSync } from 'node:sqlite';
import { createRuntimeDependencySchema } from '../runtime/dependencies/runtimeDependencySchema';
import { RuntimeDependencyStore } from '../runtime/dependencies/runtimeDependencyStore';
import { RuntimeDependencyDiscoveryBuilder } from '../runtime/dependencies/runtimeDependencyDiscoveryBuilder';
import { RepositoryBrainOrchestrator, BrainBuilders } from '../orchestrator/repositoryBrainOrchestrator';
import { OrchestratorStore } from '../orchestrator/orchestratorStore';
import { RepositoryBuilder } from '../orchestrator/orchestratorTypes';
import * as assert from 'assert';

async function runTests() {
    const db = new DatabaseSync(':memory:');
    const store = new OrchestratorStore(db);
    createRuntimeDependencySchema(db);
    const dependencyStore = new RuntimeDependencyStore(db);
    const dependencyBuilder = new RuntimeDependencyDiscoveryBuilder(db, dependencyStore);

    // Mock Builders
    const executedSteps: string[] = [];
    const createMockBuilder = (name: string, shouldThrow: boolean = false): RepositoryBuilder => ({
        build: async () => {
            executedSteps.push(name);
            if (shouldThrow) throw new Error(`${name} Failed`);
        }
    });

    const builders: BrainBuilders = {
        authorExpertise: createMockBuilder('AuthorExpertise'),
        logicalCoupling: createMockBuilder('LogicalCoupling'),
        driftEngine: createMockBuilder('ArchitecturalDrift'),
        knowledgeHotspots: createMockBuilder('KnowledgeHotspots'),
        knowledgeValidity: createMockBuilder('KnowledgeValidity'),
        architecturalEvolution: createMockBuilder('ArchitecturalEvolution'),
        testCoverage: createMockBuilder('TestCoverage'),
        decisionOutcomes: createMockBuilder('DecisionOutcomes'),
        causalReasoning: createMockBuilder('CausalReasoning'),
        incidentBuilder: createMockBuilder('IncidentBuilder'),
        incidentIntelligence: createMockBuilder('IncidentIntelligence'),
        changeImpact: createMockBuilder('ChangeImpact'),
        predictionAccountability: createMockBuilder('PredictionAccountability'),
        runtimeIntelligence: createMockBuilder('RuntimeIntelligence'),
        runtimeDependency: {
            build: async () => {
                executedSteps.push('RuntimeDependency');
                dependencyBuilder.discoverExplicitDependencies([{ component: 'test_a', dependencies: ['test_b'] }]);
            }
        }
    };

    const orchestrator = new RepositoryBrainOrchestrator(store, builders);

    console.log("Running Test D1: Successful Execution");
    await orchestrator.runFullRebuild();
    const rtIndex = executedSteps.indexOf('RuntimeIntelligence');
    const rdIndex = executedSteps.indexOf('RuntimeDependency');
    assert.ok(rtIndex !== -1, "RuntimeIntelligence did not run");
    assert.ok(rdIndex !== -1, "RuntimeDependency did not run");
    assert.strictEqual(rdIndex, rtIndex + 1, "RuntimeDependency did not execute immediately after RuntimeIntelligence");

    console.log("Running Test D2: Failure Isolation");
    builders.runtimeDependency!.build = async () => {
        throw new Error("Simulated Discovery Failure");
    };
    executedSteps.length = 0; // Clear execution history
    await orchestrator.runFullRebuild();
    assert.ok(executedSteps.includes('IncidentIntelligence'), "Orchestrator failed to continue after RuntimeDependency throw");
    const state = store.getState();
    assert.strictEqual(state?.status, 'COMPLETED', "Orchestrator status should be COMPLETED");

    console.log("Running Test D3: Component 25 Protection");
    // Disable Component 26 by removing builder
    delete builders.runtimeDependency;
    executedSteps.length = 0;
    await orchestrator.runFullRebuild();
    assert.ok(executedSteps.includes('RuntimeIntelligence'), "RuntimeIntelligence failed to execute when Dependency builder was undefined");

    console.log("Running Test D4: Graph Population");
    // Restore and fix builder
    builders.runtimeDependency = {
        build: async () => {
            dependencyBuilder.discoverExplicitDependencies([{ component: 'api', dependencies: ['db'] }]);
        }
    };
    await orchestrator.runFullRebuild();
    const evidence = dependencyStore.getAllEvidence();
    assert.ok(evidence.some(e => e.source_component_id === 'api' && e.target_component_id === 'db'), "Graph was not populated during orchestrator run");

    console.log("Running Test D5: Temporal Discovery Execution");
    db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_health_history (
            component_id TEXT,
            health_score REAL,
            status TEXT,
            computed_at DATETIME
        );
    `);
    const t0 = Date.now();
    for(let i = 0; i < 3; i++) {
        const time = t0 + i * 100000;
        db.prepare(`INSERT INTO runtime_health_history (component_id, status, computed_at) VALUES (?, 'DEGRADED', ?)`).run('t_db', new Date(time).toISOString());
        db.prepare(`INSERT INTO runtime_health_history (component_id, status, computed_at) VALUES (?, 'DEGRADED', ?)`).run('t_api', new Date(time + 5000).toISOString());
    }
    builders.runtimeDependency = {
        build: async () => {
            dependencyBuilder.discoverTemporalCorrelations();
        }
    };
    await orchestrator.runFullRebuild();
    const corrEvidence = dependencyStore.getAllEvidence().filter(e => e.source_component_id === 't_api' && e.target_component_id === 't_db');
    assert.strictEqual(corrEvidence.length, 1, "Temporal edges were not populated during orchestrator run");

    console.log("Running Test D6: Rollback Validation");
    db.exec(`DROP VIEW IF EXISTS runtime_component_dependencies`);
    db.exec(`DROP TABLE IF EXISTS runtime_dependency_evidence`);
    
    // Ensure orchestrator survives if queries fail due to missing table
    builders.runtimeDependency = {
        build: async () => {
            dependencyStore.getAllEvidence(); // This will throw because table doesn't exist
        }
    };
    
    let crash = false;
    try {
        await orchestrator.runFullRebuild();
    } catch (e) {
        crash = true;
    }
    assert.strictEqual(crash, false, "Orchestrator crashed after tables were dropped");
    assert.strictEqual(store.getState()?.status, 'COMPLETED');

    console.log("All Phase D tests passed!");
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});
