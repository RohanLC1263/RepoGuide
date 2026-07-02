import { DatabaseSync } from 'node:sqlite';
import { RepositoryBrainOrchestrator } from './orchestrator/repositoryBrainOrchestrator';
import { OrchestratorStore } from './orchestrator/orchestratorStore';
import { ChangeImpactStore } from './changeImpact/changeImpactStore';
import { ChangeImpactBuilder } from './changeImpact/changeImpactBuilder';
import { ChangeImpactQueryEngine } from './changeImpact/changeImpactQueryEngine';
import { RepositoryBrainEvidenceStore } from './query/repositoryBrainEvidenceStore';
import { RepositoryContext } from './context/repositoryContext';
import { buildEvidencePlan } from './query/evidencePlanner';

async function run() {
    const dbPath = ':memory:';
    const db = new DatabaseSync(dbPath);

    // Dummy mock stores/builders to populate the minimal DB required for Component 23
    db.exec(`
        CREATE TABLE incident_factors (incident_id TEXT, factor_type TEXT);
        CREATE TABLE incident_events (id TEXT, severity TEXT, created_at TEXT, entity_id TEXT, incident_type TEXT);
        CREATE TABLE incident_predictions (entity_id TEXT, entity_type TEXT, risk_score REAL, severity TEXT, confidence REAL, primary_risk_driver TEXT);
        CREATE TABLE logical_coupling (source_entity TEXT, target_entity TEXT, coupling_score REAL);
        CREATE TABLE author_expertise (author TEXT, entity_id TEXT, expertise_score REAL);
        CREATE TABLE incident_patterns (pattern_id TEXT, incident_type TEXT, factor_pattern TEXT, frequency INTEGER, confidence REAL);
    `);

    db.exec(`
        INSERT INTO incident_factors VALUES ('i1', 'LOW_COVERAGE');
        INSERT INTO incident_factors VALUES ('i2', 'BUS_FACTOR_1');
        INSERT INTO incident_factors VALUES ('i3', 'BUS_FACTOR_1');
        
        INSERT INTO incident_events VALUES ('i1', 'HIGH', '2026-06-19', 'src/auth/authService.ts', 'COVERAGE_DROP');
        INSERT INTO incident_events VALUES ('i2', 'CRITICAL', '2026-06-19', 'src/db/db.ts', 'KNOWLEDGE_LOSS');
        INSERT INTO incident_events VALUES ('i3', 'CRITICAL', '2026-06-19', 'src/auth/authService.ts', 'KNOWLEDGE_LOSS');

        INSERT INTO incident_predictions VALUES ('src/auth/authService.ts', 'FILE', 80, 'HIGH', 90, 'LOW_COVERAGE');
        INSERT INTO incident_predictions VALUES ('src/db/db.ts', 'FILE', 30, 'MEDIUM', 70, 'BUS_FACTOR_1');

        INSERT INTO logical_coupling VALUES ('src/auth/authService.ts', 'src/auth/auth_tests.ts', 95);
        
        INSERT INTO author_expertise VALUES ('Alice', 'src/auth/authService.ts', 100);
        INSERT INTO author_expertise VALUES ('Bob', 'src/auth/authService.ts', 20);
        
        INSERT INTO incident_patterns VALUES ('p1', 'COVERAGE_DROP', 'LOW_COVERAGE', 10, 85);
    `);

    const orchestratorStore = new OrchestratorStore(db);
    const changeImpactStore = new ChangeImpactStore(db);
    const changeImpactBuilder = new ChangeImpactBuilder(db, changeImpactStore);
    const changeImpactQueryEngine = new ChangeImpactQueryEngine(db);

    const builders: any = {
        authorExpertise: { build: async () => {} },
        logicalCoupling: { build: async () => {} },
        driftEngine: { build: async () => {} },
        knowledgeHotspots: { build: async () => {} },
        knowledgeValidity: { build: async () => {} },
        architecturalEvolution: { build: async () => {} },
        testCoverage: { build: async () => {} },
        decisionOutcomes: { build: async () => {} },
        causalReasoning: { build: async () => {} },
        incidentBuilder: { build: async () => {} },
        incidentIntelligence: { build: async () => {} },
        changeImpact: changeImpactBuilder
    };

    const orchestrator = new RepositoryBrainOrchestrator(orchestratorStore, builders);

    console.log("--- PERFORMANCE VERIFICATION ---");
    const t0 = performance.now();
    await orchestrator.runFullRebuild();
    const t1 = performance.now();
    console.log("Orchestrator ChangeImpact Build Time: " + (t1 - t0).toFixed(2) + "ms");

    console.log("\n--- DATABASE POPULATION AUDIT ---");
    const freqs = db.prepare('SELECT * FROM change_risk_frequencies').all();
    console.log('Frequencies count:', freqs.length);
    console.log('Sample Frequencies:', freqs);

    const preds = db.prepare('SELECT * FROM change_risk_predictions').all();
    console.log('Predictions count:', preds.length);
    console.log('Sample Predictions:', preds);

    console.log("\n--- REAL PREDICTION TRACE ---");
    const t2 = performance.now();
    const prediction = changeImpactQueryEngine.predictChangeSet(['src/auth/authService.ts'], 'Bob');
    const t3 = performance.now();
    console.log("Prediction Execution Time: " + (t3 - t2).toFixed(2) + "ms");
    console.log('Prediction Output:');
    console.log(JSON.stringify(prediction, null, 2));

    console.log("\n--- MCP ROUTING VERIFICATION ---");
    const plan = buildEvidencePlan("what happens if I modify src/auth/authService.ts?");
    console.log("Planner Output QueryType:", plan.queryType);
    console.log("Symbol Hints:", plan.symbolHints);

}

run().catch(console.error);
