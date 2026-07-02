import { describe, test, beforeAll, expect } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { RepositoryBrainOrchestrator, BrainBuilders } from '../orchestrator/repositoryBrainOrchestrator';
import { OrchestratorStore } from '../orchestrator/orchestratorStore';

import { IntentAwareBlastRadiusEngine } from '../impact/intentAwareBlastRadiusEngine';
import { IntentAwareBlastRadiusStore } from '../impact/intentAwareBlastRadiusStore';
import { AuthorExpertiseBuilder } from '../ownership/authorExpertiseBuilder';
import { AuthorExpertiseStore } from '../ownership/authorExpertiseStore';
import { LogicalCouplingBuilder } from '../evolution/logicalCouplingBuilder';
import { LogicalCouplingStore } from '../evolution/logicalCouplingStore';
import { DriftRuleEngine } from '../drift/driftRuleEngine';
import { DriftBuilder } from '../drift/driftBuilder';
import { DriftStore } from '../drift/driftStore';
import { KnowledgeHotspotBuilder } from '../hotspots/knowledgeHotspotBuilder';
import { KnowledgeHotspotStore } from '../hotspots/knowledgeHotspotStore';
import { ReviewIntelligenceEngine } from '../review/reviewIntelligenceEngine';
import { ReviewIntelligenceStore } from '../review/reviewIntelligenceStore';
import { KnowledgeValidityBuilder } from '../validity/knowledgeValidityBuilder';
import { KnowledgeValidityStore } from '../validity/knowledgeValidityStore';
import { EvolutionBuilder } from '../evolution/evolutionBuilder';
import { EvolutionStore } from '../evolution/evolutionStore';
import { DecisionOutcomeBuilder } from '../outcomes/decisionOutcomeBuilder';
import { DecisionOutcomeStore } from '../outcomes/decisionOutcomeStore';
import { CausalReasoningBuilder } from '../causal/causalReasoningBuilder';
import { CausalReasoningStore } from '../causal/causalReasoningStore';
import { TestCoverageBuilder } from '../coverage/testCoverageBuilder';
import { TestCoverageStore } from '../coverage/testCoverageStore';

import { DiagnosticsEngine } from '../diagnostics/diagnosticsEngine';

describe('End-to-End Repository Brain Simulation (T0 -> T4)', () => {
    let db: DatabaseSync;
    let orchestrator: RepositoryBrainOrchestrator;
    let diagnostics: DiagnosticsEngine;

    // We'll retain stores to manually mock Git/PR events
    let reviewStore: ReviewIntelligenceStore;
    let validityStore: KnowledgeValidityStore;
    let driftStore: DriftStore;

    beforeAll(() => {
        db = new DatabaseSync(':memory:');
        
        const orchestratorStore = new OrchestratorStore(db);
        
        // Initialize Stores
        const blastRadiusStore = new IntentAwareBlastRadiusStore(db);
        const expertiseStore = new AuthorExpertiseStore(db);
        const couplingStore = new LogicalCouplingStore(db);
        driftStore = new DriftStore(db);
        const hotspotStore = new KnowledgeHotspotStore(db);
        reviewStore = new ReviewIntelligenceStore(db);
        validityStore = new KnowledgeValidityStore(db);
        const evolutionStore = new EvolutionStore(db);

        // Define builders with their real implementations
        const intentAwareBlastRadius = { analyzeNodes: async (nodes: string[]) => {} }; // Mocked
        const authorExpertise = new AuthorExpertiseBuilder(db, expertiseStore);
        const logicalCoupling = new LogicalCouplingBuilder(db, couplingStore);
        const driftBuilder = new DriftBuilder(db);
        const driftEngine = new DriftRuleEngine(db);
        const knowledgeHotspots = new KnowledgeHotspotBuilder(db);
        const reviewIntelligence = new ReviewIntelligenceEngine(db, reviewStore);
        const knowledgeValidity = new KnowledgeValidityBuilder(db, validityStore);
        const architecturalEvolution = new EvolutionBuilder(db, evolutionStore);
        const decisionOutcomeStore = new DecisionOutcomeStore(db);
        const decisionOutcomes = new DecisionOutcomeBuilder(db, decisionOutcomeStore);
        const causalReasoningStore = new CausalReasoningStore(db);
        const causalReasoning = new CausalReasoningBuilder(db, causalReasoningStore);
        const testCoverageStore = new TestCoverageStore(db);
        const testCoverage = new TestCoverageBuilder(db, testCoverageStore);

        const builders: BrainBuilders = {
            authorExpertise,
            logicalCoupling,
            driftEngine: driftBuilder,
            knowledgeHotspots,
            knowledgeValidity,
            architecturalEvolution,
            testCoverage,
            decisionOutcomes,
            causalReasoning,
            incidentBuilder: { build: async () => {} } as any,
            incidentIntelligence: { build: async () => {} } as any,
            changeImpact: { build: async () => {} } as any,
            predictionAccountability: { build: async () => {} } as any
        };

        orchestrator = new RepositoryBrainOrchestrator(orchestratorStore, builders);
        diagnostics = new DiagnosticsEngine(db);

        // Seed initial metadata that external ingestion engines would normally provide
        db.exec(`
            -- Program Graph
            CREATE TABLE IF NOT EXISTS program_nodes (id TEXT PRIMARY KEY, type TEXT, file_path TEXT);
            CREATE TABLE IF NOT EXISTS program_edges (source_id TEXT, target_id TEXT, edge_type TEXT);
            
            INSERT INTO program_nodes VALUES ('src/auth/auth.ts', 'FILE', 'src/auth/auth.ts');
            INSERT INTO program_nodes VALUES ('src/db/db.ts', 'FILE', 'src/db/db.ts');
            INSERT INTO program_edges VALUES ('src/auth/auth.ts', 'src/db/db.ts', 'IMPORTS');

            -- ADRs
            CREATE TABLE IF NOT EXISTS adrs (id TEXT PRIMARY KEY, title TEXT, status TEXT);
            CREATE TABLE IF NOT EXISTS adr_code_links (id TEXT PRIMARY KEY, adr_id TEXT, node_id TEXT);
            
            INSERT INTO adrs VALUES ('ADR-1', 'Use Auth0', 'ACCEPTED');
            INSERT INTO adr_code_links VALUES ('link1', 'ADR-1', 'src/auth/auth.ts');
            
            -- Commits for Expertise
            CREATE TABLE IF NOT EXISTS commits (hash TEXT PRIMARY KEY, author_email TEXT, author_name TEXT, timestamp TEXT);
            CREATE TABLE IF NOT EXISTS commit_files (commit_hash TEXT, file_path TEXT, status TEXT, additions INTEGER, deletions INTEGER);
        `);
    });

    test('T0 Baseline: Initial State', async () => {
        // Run full rebuild with no commits yet
        await orchestrator.runFullRebuild();
        expect(() => diagnostics.runDiagnostics()).not.toThrow();

        // Health should be 100
        const h = db.prepare(`SELECT health_score FROM architectural_health WHERE entity_id = 'ADR-1'`).get() as any;
        expect(h).toBeDefined();
        expect(h.health_score).toBe(100);
    });

    test('T1 Team Expansion: Add Commits, evaluate Expertise and Hotspots', async () => {
        db.exec(`
            INSERT INTO commits VALUES ('c1', 'alice@ex.com', 'Alice', '${new Date().toISOString()}');
            INSERT INTO commit_files VALUES ('c1', 'src/auth/auth.ts', 'M', 100, 10);
            
            INSERT INTO commits VALUES ('c2', 'alice@ex.com', 'Alice', '${new Date().toISOString()}');
            INSERT INTO commit_files VALUES ('c2', 'src/auth/auth.ts', 'M', 50, 0);
        `);

        await orchestrator.runFullRebuild();
        expect(() => diagnostics.runDiagnostics()).not.toThrow();

        // Alice should be an expert, giving ADR-1 a bus factor of 1
        const expertise = db.prepare(`SELECT expertise_score FROM author_expertise WHERE author_email = 'alice@ex.com' AND entity_id = 'src/auth/auth.ts'`).get() as any;
        expect(expertise).toBeDefined();

        const hotspot = db.prepare(`SELECT bus_factor FROM knowledge_hotspots WHERE entity_id = 'ADR-1'`).get() as any;
        expect(hotspot.bus_factor).toBe(1);
    });

    test('T2 Drift Introduction: Add violations, evaluate Health', async () => {
        // Drift requires actual findings or rules. We'll simulate finding by directly inserting.
        // Wait, the orchestrator calls executeRules, which will wipe findings if we insert them manually.
        // We'll mock the drift rule engine to just add a finding, or we can use the actual rule engine if we seed program graph.
        // For simplicity, after orchestrator runs, we manually add drift and re-run?
        // DriftRuleEngine drops findings. So we have to insert drift using its expected input tables.
        // Alternatively, since DriftRuleEngine relies on drift rules, we can seed a rule.
        
        db.exec(`
            CREATE TABLE IF NOT EXISTS adr_rules (id TEXT, adr_id TEXT, rule_type TEXT, pattern TEXT);
            INSERT INTO adr_rules VALUES ('r1', 'ADR-1', 'MUST_IMPORT', 'src/db/db.ts');
            -- Wait, if it already imports it, no drift.
            -- Let's add a forbidden import rule to create drift.
            INSERT INTO adr_rules VALUES ('r2', 'ADR-1', 'FORBIDDEN_IMPORT', 'src/db/db.ts');
        `);

        await orchestrator.runFullRebuild();
        expect(() => diagnostics.runDiagnostics()).not.toThrow();

        const health = db.prepare(`SELECT health_score FROM architectural_health WHERE entity_id = 'ADR-1'`).get() as any;
        expect(health.health_score).toBeLessThan(100);
    });

    test('T3 Review Failure: Add incidents, evaluate Validity', async () => {
        // Add a review outcome with incidents
        reviewStore.saveOutcome({
            reviewId: 'rev1',
            entityType: 'ADR',
            entityId: 'ADR-1',
            reviewerEmail: 'bob@ex.com',
            reviewerName: 'Bob',
            reviewerAccepted: true,
            defectsFound: 5,
            postMergeIncidents: 2,
            reviewDurationHours: 1,
            createdAt: new Date()
        });

        await orchestrator.runFullRebuild();
        expect(() => diagnostics.runDiagnostics()).not.toThrow();

        const val = db.prepare(`SELECT validity_score FROM knowledge_validity WHERE entity_id = 'ADR-1'`).get() as any;
        expect(val.validity_score).toBeLessThan(100);
    });

    test('T4 Governance Recovery: Fix drift', async () => {
        // Remove the drift-causing rule
        db.exec(`DELETE FROM adr_rules WHERE id = 'r2'`);
        
        await orchestrator.runFullRebuild();
        expect(() => diagnostics.runDiagnostics()).not.toThrow();

        const health = db.prepare(`SELECT health_score FROM architectural_health WHERE entity_id = 'ADR-1'`).get() as any;
        expect(health.health_score).toBe(100);
    });
});
