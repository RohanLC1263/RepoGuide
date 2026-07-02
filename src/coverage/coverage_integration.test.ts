import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { RepositoryBrainOrchestrator } from '../orchestrator/repositoryBrainOrchestrator';
import { OrchestratorStore } from '../orchestrator/orchestratorStore';
import { DiagnosticsEngine } from '../diagnostics/diagnosticsEngine';
import { KnowledgeHotspotStore } from '../hotspots/knowledgeHotspotStore';
import { KnowledgeHotspotBuilder } from '../hotspots/knowledgeHotspotBuilder';
import { DecisionOutcomeStore } from '../outcomes/decisionOutcomeStore';
import { DecisionOutcomeBuilder } from '../outcomes/decisionOutcomeBuilder';
import { CausalReasoningStore } from '../causal/causalReasoningStore';
import { CausalReasoningBuilder } from '../causal/causalReasoningBuilder';

// Mock other builders that are not strictly necessary to test the isolated lineage
const dummyBuilder = { build: async () => {} };

describe('Coverage Integration End-to-End', () => {
    let db: DatabaseSync;
    let orchestrator: RepositoryBrainOrchestrator;
    let diagnostics: DiagnosticsEngine;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        
        // Setup schema required for health, outcomes, and causality
        db.exec(`
            CREATE TABLE adr_code_links (adr_id TEXT, node_id TEXT);
            CREATE TABLE intent_aware_impacts (root_node_id TEXT, governance_score REAL);
            CREATE TABLE logical_coupling_edges (source_path TEXT, target_path TEXT);
            CREATE TABLE author_expertise (entity_id TEXT, entity_type TEXT, author_email TEXT, expertise_score REAL, knowledge_age_days INTEGER, coverage_percentage REAL);
            
            CREATE TABLE architectural_health (entity_id TEXT PRIMARY KEY, entity_type TEXT, health_score REAL);
            CREATE TABLE architectural_health_history (entity_type TEXT, entity_id TEXT, snapshot_date TEXT, health_score REAL, active_findings INTEGER, critical_findings INTEGER);
            
            CREATE TABLE coverage_entities (entity_type TEXT, entity_id TEXT, coverage_percent REAL, covered_lines INTEGER, total_lines INTEGER, coverage_status TEXT, calculated_at TEXT);
            CREATE TABLE coverage_history (entity_type TEXT, entity_id TEXT, snapshot_date TEXT, coverage_percent REAL);
            
            CREATE TABLE validity_history (validity_id TEXT, snapshot_date TEXT, validity_score REAL);
            CREATE TABLE knowledge_validity (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, validity_score REAL);
            CREATE TABLE review_outcomes (id TEXT, entity_type TEXT, entity_id TEXT, is_approved INTEGER, defects_found INTEGER, security_issues INTEGER, created_at TEXT);
            CREATE TABLE incident_events (id TEXT, entity_type TEXT, entity_id TEXT, timestamp TEXT);

            -- Seed a perfectly healthy ADR
            INSERT INTO architectural_health VALUES ('ADR-1', 'ADR', 100);
            INSERT INTO architectural_health_history VALUES ('ADR', 'ADR-1', '2023-01-01', 100, 0, 0);
        `);

        const hotspotStore = new KnowledgeHotspotStore(db);
        const outcomeStore = new DecisionOutcomeStore(db);
        const causalStore = new CausalReasoningStore(db);
        const orchestratorStore = new OrchestratorStore(db);

        // We only instantiate the builders under test + required ones
        const builders = {
            authorExpertise: dummyBuilder as any,
            logicalCoupling: dummyBuilder as any,
            driftEngine: dummyBuilder as any,
            knowledgeHotspots: new KnowledgeHotspotBuilder(db),
            knowledgeValidity: dummyBuilder as any,
            architecturalEvolution: dummyBuilder as any,
            testCoverage: dummyBuilder as any, // We manually seed coverage for time control
            decisionOutcomes: new DecisionOutcomeBuilder(db, outcomeStore),
            causalReasoning: new CausalReasoningBuilder(db, causalStore),
            incidentBuilder: {} as any,
            incidentIntelligence: {} as any,
            changeImpact: {} as any,
            predictionAccountability: {} as any
        };

        orchestrator = new RepositoryBrainOrchestrator(orchestratorStore, builders);
        diagnostics = new DiagnosticsEngine(db);
    });

    test('Coverage Drop propagates through Health, Outcomes, and Causality', async () => {
        // T0: 95% Coverage (No Penalties)
        db.exec(`
            INSERT INTO coverage_entities VALUES ('ADR', 'ADR-1', 95, 95, 100, 'GOOD', '2023-01-02');
            INSERT INTO coverage_history VALUES ('ADR', 'ADR-1', '2023-01-02', 95);
        `);
        
        // Mock the clock to T0
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2023-01-02T12:00:00Z'));

        await orchestrator.runFullRebuild();

        let health = db.prepare(`SELECT health_score FROM architectural_health WHERE entity_id = 'ADR-1'`).get() as any;
        let outcome = db.prepare(`SELECT outcome_score, outcome_type FROM decision_outcomes WHERE entity_id = 'ADR-1'`).get() as any;

        // Health should be pristine (100)
        expect(health.health_score).toBe(100);
        // Outcome should be HIGH (100) -> SUCCESSFUL
        expect(outcome.outcome_score).toBe(100);
        expect(outcome.outcome_type).toBe('SUCCESSFUL');


        // T1: Coverage Collapses to 40% (Critical Penalty)
        db.exec(`
            DELETE FROM coverage_entities;
            INSERT INTO coverage_entities VALUES ('ADR', 'ADR-1', 40, 40, 100, 'CRITICAL', '2023-01-03');
            INSERT INTO coverage_history VALUES ('ADR', 'ADR-1', '2023-01-03', 40);
        `);
        
        // Mock the clock to T1
        jest.setSystemTime(new Date('2023-01-03T12:00:00Z'));

        await orchestrator.runFullRebuild();

        health = db.prepare(`SELECT health_score FROM architectural_health WHERE entity_id = 'ADR-1'`).get() as any;
        outcome = db.prepare(`SELECT outcome_score, outcome_type FROM decision_outcomes WHERE entity_id = 'ADR-1'`).get() as any;

        // Health penalty < 50% = -20
        expect(health.health_score).toBe(80);

        // Outcome Score should drop. Health penalty is 20. Coverage penalty is 15.
        // Base = 100 - 20 (from health) - 15 (from coverage) = 65
        expect(outcome.outcome_score).toBe(65);
        
        // Outcome Type should be DEGRADING (65 is between 50-69)
        expect(outcome.outcome_type).toBe('DEGRADING');

        // Check Causal Reasoning emitted the event
        const causalFactors = db.prepare(`
            SELECT f.factor_type
            FROM causal_factors f
            JOIN causal_explanations cx ON f.explanation_id = cx.id
            WHERE cx.target_entity_id = 'ADR-1'
        `).all() as any[];

        const factorTypes = causalFactors.map(f => f.factor_type);
        expect(factorTypes).toContain('COVERAGE_DEGRADATION');

        // Check Evidence Persisted
        const healthEvidence = db.prepare(`SELECT * FROM hotspot_evidence WHERE evidence_type = 'COVERAGE_HEALTH_PENALTY'`).all() as any[];
        expect(healthEvidence.length).toBeGreaterThan(0);

        const outcomeEvidence = db.prepare(`SELECT * FROM outcome_evidence WHERE evidence_type = 'COVERAGE'`).all() as any[];
        expect(outcomeEvidence.length).toBeGreaterThan(0);

        // Diagnostics must pass because the penalty rules are respected
        expect(() => diagnostics.runDiagnostics()).not.toThrow();

        jest.useRealTimers();
    });
});
