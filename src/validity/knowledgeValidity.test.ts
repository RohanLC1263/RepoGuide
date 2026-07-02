import { describe, test, expect, beforeEach } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeValidityStore } from './knowledgeValidityStore';
import { KnowledgeValidityBuilder } from './knowledgeValidityBuilder';
import { KnowledgeValidityQueryEngine } from './knowledgeValidityQueryEngine';

describe('Knowledge Validity Model', () => {
    let db: DatabaseSync;
    let store: KnowledgeValidityStore;
    let builder: KnowledgeValidityBuilder;
    let query: KnowledgeValidityQueryEngine;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        
        // Mock dependencies
        db.exec(`
            CREATE TABLE adrs (id TEXT PRIMARY KEY, title TEXT);
            CREATE TABLE adr_code_links (id TEXT PRIMARY KEY, adr_id TEXT, node_id TEXT);
            CREATE TABLE author_expertise (author_email TEXT, author_name TEXT, entity_type TEXT, entity_id TEXT, coverage_percentage REAL, knowledge_age_days INTEGER, expertise_score REAL);
            CREATE TABLE architectural_health (entity_id TEXT PRIMARY KEY, entity_type TEXT, health_score REAL);
            CREATE TABLE knowledge_hotspots (entity_id TEXT PRIMARY KEY, hotspot_score REAL, severity TEXT, bus_factor INTEGER);
            CREATE TABLE drift_findings (id TEXT PRIMARY KEY, adr_id TEXT, severity TEXT, drift_type TEXT);
            CREATE TABLE review_outcomes (review_id TEXT, post_merge_incidents INTEGER, defects_found INTEGER);
        `);

        store = new KnowledgeValidityStore(db);
        builder = new KnowledgeValidityBuilder(db, store);
        query = new KnowledgeValidityQueryEngine(db);
    });

    test('High trust baseline', () => {
        db.exec(`
            INSERT INTO adrs (id, title) VALUES ('ADR-1', 'Use OAuth');
            INSERT INTO adr_code_links (id, adr_id, node_id) VALUES ('l1', 'ADR-1', 'auth.ts');
            INSERT INTO author_expertise (author_email, author_name, entity_type, entity_id, expertise_score, knowledge_age_days) 
            VALUES ('alice@ex.com', 'Alice', 'FILE', 'auth.ts', 100, 10);
            INSERT INTO architectural_health (entity_id, entity_type, health_score) VALUES ('ADR-1', 'ADR', 100);
        `);

        const validity = builder.buildForADR('ADR-1');
        
        expect(validity.validityScore).toBe(100);
        expect(validity.validityTier).toBe('VERY_HIGH');
        // Confidence should be high because we have active experts and health data
        expect(validity.confidenceScore).toBe(75);
        expect(validity.trend).toBe('STABLE');
        
        const evidence = query.getEvidence(validity.id);
        expect(evidence.length).toBe(0); // No penalties
    });

    test('Abandoned ADR with active Drift bottoms out validity', () => {
        db.exec(`
            INSERT INTO adrs (id, title) VALUES ('ADR-2', 'Use Mongo');
            INSERT INTO adr_code_links (id, adr_id, node_id) VALUES ('l2', 'ADR-2', 'db.ts');
            
            -- Expert is 2 years inactive (Penalty: 20)
            -- Bus factor 1 (Penalty: 10)
            INSERT INTO author_expertise (author_email, author_name, entity_type, entity_id, expertise_score, knowledge_age_days) 
            VALUES ('bob@ex.com', 'Bob', 'FILE', 'db.ts', 100, 800);
            INSERT INTO knowledge_hotspots (entity_id, hotspot_score, severity, bus_factor) VALUES ('ADR-2', 90, 'CRITICAL', 1);
            
            -- Health is degraded to 50 (Penalty: 15)
            INSERT INTO architectural_health (entity_id, entity_type, health_score) VALUES ('ADR-2', 'ADR', 50);

            -- 3 CRITICAL drift findings (Penalty: 40 max)
            INSERT INTO drift_findings (id, adr_id, severity, drift_type) VALUES 
            ('d1', 'ADR-2', 'CRITICAL', 'GOVERNANCE_VIOLATION'),
            ('d2', 'ADR-2', 'CRITICAL', 'EXCESSIVE_COUPLING'),
            ('d3', 'ADR-2', 'CRITICAL', 'ORPHANED_IMPLEMENTATION');
        `);

        const validity = builder.buildForADR('ADR-2');
        
        // Penalties: Expert(30) + Hotspot(20) + Health(15) + Drift(40) = 105
        // Score = Max(0, 100 - 105) = 0
        expect(validity.validityScore).toBe(0);
        expect(validity.validityTier).toBe('VERY_LOW');
        // We have all signals, so confidence is high!
        expect(validity.confidenceScore).toBe(100);
        
        const evidence = query.getEvidence(validity.id);
        expect(evidence.length).toBeGreaterThan(0);
        
        const types = evidence.map(e => e.evidenceType);
        expect(types).toContain('EXPERT');
        expect(types).toContain('HEALTH');
        expect(types).toContain('HOTSPOT');
        expect(types).toContain('DRIFT');
    });

    test('Trend degrades', () => {
        db.exec(`
            INSERT INTO adrs (id, title) VALUES ('ADR-3', 'Test Trend');
        `);
        
        // Initial state: 100
        builder.buildForADR('ADR-3');
        
        // Introduce drift
        db.exec(`
            INSERT INTO drift_findings (id, adr_id, severity, drift_type) VALUES 
            ('d4', 'ADR-3', 'CRITICAL', 'GOVERNANCE_VIOLATION');
        `);
        
        const secondValidity = builder.buildForADR('ADR-3');
        expect(secondValidity.validityScore).toBe(80);
        expect(secondValidity.trend).toBe('DEGRADING');
        
        const history = query.getValidityHistory('ADR-3');
        expect(history.length).toBe(2);
        expect(history[0].validityScore).toBe(100);
        expect(history[1].validityScore).toBe(80);
    });
});
