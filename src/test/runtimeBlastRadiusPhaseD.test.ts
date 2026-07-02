import { DatabaseSync } from 'node:sqlite';
import { RepositoryBrainOrchestrator } from '../orchestrator/repositoryBrainOrchestrator';
import { OrchestratorStore } from '../orchestrator/orchestratorStore';
import { createRuntimeBlastRadiusSchema } from '../runtime/blast_radius/runtimeBlastRadiusSchema';
import { RuntimeBlastRadiusStore } from '../runtime/blast_radius/runtimeBlastRadiusStore';
import { RuntimeBlastRadiusCalculator } from '../runtime/blast_radius/runtimeBlastRadiusCalculator';
import { RuntimeBlastRadiusBuilder } from '../runtime/blast_radius/runtimeBlastRadiusBuilder';
import { RuntimeDependencyQueryEngine } from '../runtime/dependencies/runtimeDependencyQueryEngine';
import { createRuntimeDependencySchema } from '../runtime/dependencies/runtimeDependencySchema';
import { RuntimeDependencyStore } from '../runtime/dependencies/runtimeDependencyStore';
import * as assert from 'assert';

async function runTests() {
    const db = new DatabaseSync(':memory:');
    
    // We need health schema to store the health records and orchestrator schema
    db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_health_history (
            component_id TEXT,
            status TEXT,
            computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    
    createRuntimeDependencySchema(db);
    createRuntimeBlastRadiusSchema(db);

    const healthStmt = db.prepare(`INSERT INTO runtime_health_history (component_id, status) VALUES (?, ?)`);
    healthStmt.run('database_gateway', 'CRITICAL');

    const depStore = new RuntimeDependencyStore(db);

    depStore.appendEvidence({
        evidence_id: 'e1',
        source_component_id: 'user_service',
        target_component_id: 'database_gateway',
        dependency_type: 'HARD_DEPENDENCY',
        evidence_source: 'EXPLICIT_CONFIG',
        raw_confidence: 1.0
    });
    depStore.appendEvidence({
        evidence_id: 'e2',
        source_component_id: 'auth_api',
        target_component_id: 'user_service',
        dependency_type: 'HARD_DEPENDENCY',
        evidence_source: 'EXPLICIT_CONFIG',
        raw_confidence: 1.0
    });

    const orchStore = new OrchestratorStore(db);
    const queryEngine = new RuntimeDependencyQueryEngine(db);
    const calculator = new RuntimeBlastRadiusCalculator(queryEngine);
    const radiusStore = new RuntimeBlastRadiusStore(db);
    const radiusBuilder = new RuntimeBlastRadiusBuilder(db, calculator, radiusStore);

    const executedSteps: string[] = [];
    const mockBuilder = (name: string) => ({
        build: async () => { executedSteps.push(name); }
    });

    const builders: any = {
        authorExpertise: mockBuilder('authorExpertise'),
        logicalCoupling: mockBuilder('logicalCoupling'),
        driftEngine: mockBuilder('driftEngine'),
        knowledgeHotspots: mockBuilder('knowledgeHotspots'),
        knowledgeValidity: mockBuilder('knowledgeValidity'),
        architecturalEvolution: mockBuilder('architecturalEvolution'),
        testCoverage: mockBuilder('testCoverage'),
        decisionOutcomes: mockBuilder('decisionOutcomes'),
        causalReasoning: mockBuilder('causalReasoning'),
        incidentBuilder: mockBuilder('incidentBuilder'),
        incidentIntelligence: mockBuilder('incidentIntelligence'),
        changeImpact: mockBuilder('changeImpact'),
        predictionAccountability: mockBuilder('predictionAccountability'),
        runtimeIntelligence: mockBuilder('runtimeIntelligence'),
        runtimeDependency: {
            build: async () => { executedSteps.push('runtimeDependency'); }
        },
        runtimeBlastRadius: {
            build: async (cycleId: string) => {
                executedSteps.push('runtimeBlastRadius');
                await radiusBuilder.build(cycleId);
            }
        }
    };

    const orchestrator = new RepositoryBrainOrchestrator(orchStore, builders);

    console.log("Running T_D1, T_D2, T_D5...");
    await orchestrator.runFullRebuild();

    const idx26 = executedSteps.indexOf('runtimeDependency');
    const idx27 = executedSteps.indexOf('runtimeBlastRadius');
    assert.ok(idx26 !== -1 && idx27 === idx26 + 1, "T_D1 Failed: Execution order");

    const rows = db.prepare(`SELECT * FROM runtime_blast_radius`).all() as any[];
    assert.ok(rows.length > 0, "T_D5 Failed: No records inserted");
    const cycleId1 = rows[0].orchestrator_cycle_id;
    assert.ok(rows.every(r => r.orchestrator_cycle_id === cycleId1), "T_D2 Failed: Cycle ID not propagated");
    const authApiRow = rows.find(r => r.target_component_id === 'auth_api');
    assert.ok(authApiRow, "T_D5 Failed: target missing");

    console.log("Running T_D6: Historical Boundary Validation");
    healthStmt.run('user_service', 'DEGRADED');
    await orchestrator.runFullRebuild();
    const rows2 = db.prepare(`SELECT * FROM runtime_blast_radius`).all() as any[];
    const cycles = new Set(rows2.map(r => r.orchestrator_cycle_id));
    assert.ok(cycles.size === 2, "T_D6 Failed: Historical boundaries not isolated");

    console.log("Running T_D3: Failure Isolation Validation");
    builders.runtimeBlastRadius = {
        build: async (cycleId: string) => {
            executedSteps.push('runtimeBlastRadius_fail');
            throw new Error("Fatal Calculator Error");
        }
    };
    await orchestrator.runFullRebuild();
    assert.ok(executedSteps.includes('runtimeBlastRadius_fail'), "T_D3 Failed: Did not execute");
    assert.ok(orchStore.getState()?.status === 'COMPLETED', "T_D3 Failed: Orchestrator did not survive failure");

    console.log("Running T_D4: Component 26 Protection Validation");
    builders.runtimeBlastRadius = undefined;
    executedSteps.length = 0;
    await orchestrator.runFullRebuild();
    assert.ok(!executedSteps.includes('runtimeBlastRadius'), "T_D4 Failed: Component 27 still ran");
    assert.ok(executedSteps.includes('runtimeDependency'), "T_D4 Failed: Component 26 did not run");

    console.log("Running T_D7: Rollback Validation");
    db.exec(`DROP TABLE runtime_blast_radius`);
    builders.runtimeBlastRadius = {
        build: async (cycleId: string) => {
            await radiusBuilder.build(cycleId);
        }
    };
    await orchestrator.runFullRebuild(); 
    assert.ok(orchStore.getState()?.status === 'COMPLETED', "T_D7 Failed: Orchestrator failed due to SQL error");

    console.log("All Phase D tests passed!");
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});
