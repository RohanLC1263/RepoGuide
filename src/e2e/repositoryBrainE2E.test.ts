import { describe, test, beforeAll, expect } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { RepositoryBrainOrchestrator, BrainBuilders } from '../orchestrator/repositoryBrainOrchestrator';
import { OrchestratorStore } from '../orchestrator/orchestratorStore';
import { KnowledgeHotspotStore } from '../hotspots/knowledgeHotspotStore';
import { DriftStore } from '../drift/driftStore';
import { KnowledgeValidityStore } from '../validity/knowledgeValidityStore';
import { EvolutionStore } from '../evolution/evolutionStore';
import { AuthorExpertiseStore } from '../ownership/authorExpertiseStore';
import { LogicalCouplingStore } from '../evolution/logicalCouplingStore';
import { IntentAwareBlastRadiusStore } from '../impact/intentAwareBlastRadiusStore';
import { ReviewIntelligenceStore } from '../review/reviewIntelligenceStore';

import { DiagnosticsEngine } from '../diagnostics/diagnosticsEngine';

describe('Repository Brain Hardening E2E (T0 -> T3)', () => {
    let db: DatabaseSync;
    let orchestrator: RepositoryBrainOrchestrator;
    let diagnostics: DiagnosticsEngine;

    beforeAll(() => {
        db = new DatabaseSync(':memory:');
        
        const orchestratorStore = new OrchestratorStore(db);
        new KnowledgeHotspotStore(db);
        new DriftStore(db);
        new KnowledgeValidityStore(db);
        new EvolutionStore(db);
        new AuthorExpertiseStore(db);
        new LogicalCouplingStore(db);
        new IntentAwareBlastRadiusStore(db);
        new ReviewIntelligenceStore(db);

        // Dummy builders that execute raw SQL to simulate the pipeline since full builder DI is complex
        const mockBuilders: BrainBuilders = {
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
            changeImpact: { build: async () => {} },
            predictionAccountability: { build: async () => {} }
        };

        orchestrator = new RepositoryBrainOrchestrator(orchestratorStore, mockBuilders);
        diagnostics = new DiagnosticsEngine(db);
        
        // Seed base tables
        db.exec(`
            CREATE TABLE adr_code_links (id TEXT, adr_id TEXT, node_id TEXT);
            CREATE TABLE adrs (id TEXT, status TEXT);
            INSERT INTO adrs VALUES ('ADR-1', 'ACCEPTED');
            INSERT INTO adr_code_links VALUES ('1', 'ADR-1', 'src/auth/auth.ts');
        `);
    });

    test('T0 Baseline: Initialize Architecture', async () => {
        // Mock the outcome of builders
        db.exec(`
            INSERT INTO author_expertise (author_email, entity_type, entity_id, expertise_score) VALUES ('alice@test.com', 'FILE', 'src/auth/auth.ts', 100);
            INSERT INTO knowledge_hotspots (id, entity_type, entity_id, expert_count) VALUES ('HOTSPOT|ADR|ADR-1', 'ADR', 'ADR-1', 1);
            INSERT INTO architectural_health (entity_id, entity_type, health_score) VALUES ('ADR-1', 'ADR', 100);
            INSERT INTO knowledge_validity (id, entity_type, entity_id, validity_score) VALUES ('VAL-ADR-1', 'ADR', 'ADR-1', 100);
            INSERT INTO evolution_entities (id, entity_type, entity_id) VALUES ('EV-ADR-1', 'ADR', 'ADR-1');
            INSERT INTO review_recommendations (id, change_id) VALUES ('REC-1', 'PR-1');
            INSERT INTO review_scope (recommendation_id) VALUES ('REC-1');
        `);
        
        await orchestrator.runFullRebuild();
        expect(() => diagnostics.runDiagnostics()).not.toThrow();
    });

    test('T1: Diagnostic Fails when Expert Count mismatches Bus Factor', async () => {
        db.exec(`
            UPDATE knowledge_hotspots SET expert_count = 5 WHERE entity_id = 'ADR-1';
        `);
        
        expect(() => diagnostics.runDiagnostics()).toThrow(/Expert mismatch detected/);
        
        // Fix it
        db.exec(`
            UPDATE knowledge_hotspots SET expert_count = 1 WHERE entity_id = 'ADR-1';
        `);
    });

    test('T2: Diagnostic Fails when Health degraded but no Drift Findings', async () => {
        db.exec(`
            UPDATE architectural_health SET health_score = 70 WHERE entity_id = 'ADR-1';
        `);

        expect(() => diagnostics.runDiagnostics()).toThrow(/Health score < 100 but no active drift/);

        // Fix it
        db.exec(`
            INSERT INTO drift_findings (id, entity_id, resolution_state) VALUES ('DRIFT-1', 'ADR-1', 'ACTIVE');
        `);
        expect(() => diagnostics.runDiagnostics()).not.toThrow();
    });

    test('T3: Diagnostic Fails when Validity is penalized but no Evidence', async () => {
        db.exec(`
            UPDATE knowledge_validity SET validity_score = 40 WHERE entity_id = 'ADR-1';
        `);

        expect(() => diagnostics.runDiagnostics()).toThrow(/Validity score < 100 but no evidence/);

        // Fix it
        db.exec(`
            INSERT INTO validity_evidence (validity_id) VALUES ('VAL-ADR-1');
        `);
        expect(() => diagnostics.runDiagnostics()).not.toThrow();
    });
});
