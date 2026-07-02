import { describe, test, expect, beforeEach } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { CausalReasoningStore } from './causalReasoningStore';
import { CausalReasoningBuilder } from './causalReasoningBuilder';
import { CausalReasoningQueryEngine } from './causalReasoningQueryEngine';

describe('Causal Reasoning Engine', () => {
    let db: DatabaseSync;
    let store: CausalReasoningStore;
    let builder: CausalReasoningBuilder;
    let query: CausalReasoningQueryEngine;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        
        // Setup schemas for upstream dependencies to satisfy tests
        db.exec(`
            CREATE TABLE decision_outcomes (id TEXT, entity_type TEXT, entity_id TEXT, outcome_type TEXT, health_trend TEXT);
            CREATE TABLE architectural_health_history (entity_type TEXT, entity_id TEXT, snapshot_date TEXT, health_score REAL);
            CREATE TABLE knowledge_validity (id TEXT, entity_type TEXT, entity_id TEXT);
            CREATE TABLE validity_history (validity_id TEXT, snapshot_date TEXT, validity_score REAL);
            CREATE TABLE knowledge_hotspots (id TEXT, entity_type TEXT, entity_id TEXT);
            CREATE TABLE hotspot_history (hotspot_id TEXT, snapshot_date TEXT, hotspot_score REAL);
            CREATE TABLE review_outcomes (entity_type TEXT, entity_id TEXT, created_at TEXT, is_approved INTEGER, defects_found INTEGER, security_issues INTEGER);
            CREATE TABLE incident_events (entity_type TEXT, entity_id TEXT, timestamp TEXT);
        `);

        store = new CausalReasoningStore(db);
        builder = new CausalReasoningBuilder(db, store);
        query = new CausalReasoningQueryEngine(store);
    });

    test('Identifies simple causal chain and constructs relationships', async () => {
        db.exec(`
            INSERT INTO decision_outcomes VALUES ('o1', 'ADR', 'ADR-1', 'FAILED', 'DEGRADING');
            
            -- Day 1: Health Drops
            INSERT INTO architectural_health_history VALUES ('ADR', 'ADR-1', '2023-01-01', 90);
            INSERT INTO architectural_health_history VALUES ('ADR', 'ADR-1', '2023-01-02', 70); -- Drop 20

            -- Day 3: Hotspot Escalates
            INSERT INTO knowledge_hotspots VALUES ('h1', 'ADR', 'ADR-1');
            INSERT INTO hotspot_history VALUES ('h1', '2023-01-01', 10);
            INSERT INTO hotspot_history VALUES ('h1', '2023-01-03', 40); -- Escalate 30
        `);

        await builder.build();

        const explanation = query.getExplanation('ADR', 'ADR-1');
        expect(explanation).toBeDefined();
        expect(explanation!.explanationType).toBe('FAILURE');

        const factors = query.getFactors(explanation!.id);
        expect(factors.length).toBe(2);

        const chains = query.getChains(explanation!.id);
        expect(chains.length).toBe(1);
        expect(chains[0].relationship).toBe('CONTRIBUTED_TO'); // because contribution > 30

        const rootCause = query.getRootCause('ADR', 'ADR-1');
        expect(rootCause!.factorType).toBe('HOTSPOT'); // impact 30 > impact 20
    });

    test('Identifies intra-day CORRELATED_WITH relationship', async () => {
        db.exec(`
            INSERT INTO decision_outcomes VALUES ('o2', 'ADR', 'ADR-2', 'FAILED', 'DEGRADING');
            
            -- Same Day: Health Drops and Validity Drops
            INSERT INTO architectural_health_history VALUES ('ADR', 'ADR-2', '2023-01-01', 90);
            INSERT INTO architectural_health_history VALUES ('ADR', 'ADR-2', '2023-01-02', 70); 

            INSERT INTO knowledge_validity VALUES ('v1', 'ADR', 'ADR-2');
            INSERT INTO validity_history VALUES ('v1', '2023-01-01', 90);
            INSERT INTO validity_history VALUES ('v1', '2023-01-02', 70); 
        `);

        await builder.build();

        const explanation = query.getExplanation('ADR', 'ADR-2');
        const chains = query.getChains(explanation!.id);
        
        expect(chains.length).toBe(1);
        expect(chains[0].relationship).toBe('CORRELATED_WITH'); 
    });

    test('Confidence Model relies on Signal Agreement', async () => {
        db.exec(`
            INSERT INTO decision_outcomes VALUES ('o3', 'ADR', 'ADR-3', 'FAILED', 'DEGRADING');
            
            -- 3 different signals
            INSERT INTO architectural_health_history VALUES ('ADR', 'ADR-3', '2023-01-01', 90);
            INSERT INTO architectural_health_history VALUES ('ADR', 'ADR-3', '2023-01-02', 70); 

            INSERT INTO knowledge_validity VALUES ('v2', 'ADR', 'ADR-3');
            INSERT INTO validity_history VALUES ('v2', '2023-01-02', 90);
            INSERT INTO validity_history VALUES ('v2', '2023-01-03', 70); 

            INSERT INTO incident_events VALUES ('ADR', 'ADR-3', '2023-01-04');
        `);

        await builder.build();

        const explanation = query.getExplanation('ADR', 'ADR-3');
        // 3 unique signals = 60. Depth = 3 = 30. Total = 90. Plus 10 bonus = 100.
        expect(explanation!.confidenceScore).toBe(100);
    });
});
