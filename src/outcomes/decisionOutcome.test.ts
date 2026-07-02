import { describe, test, expect, beforeEach } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { DecisionOutcomeStore } from './decisionOutcomeStore';
import { DecisionOutcomeBuilder } from './decisionOutcomeBuilder';
import { DecisionOutcomeQueryEngine } from './decisionOutcomeQueryEngine';

describe('Decision Outcome Tracker', () => {
    let db: DatabaseSync;
    let store: DecisionOutcomeStore;
    let builder: DecisionOutcomeBuilder;
    let query: DecisionOutcomeQueryEngine;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        
        // Mock all upstream tables needed for aggregation
        db.exec(`
            CREATE TABLE architectural_health_history (entity_type TEXT, entity_id TEXT, snapshot_date TEXT, health_score REAL, active_findings INTEGER, critical_findings INTEGER);
            CREATE TABLE validity_history (validity_id TEXT, snapshot_date TEXT, validity_score REAL, confidence_score REAL);
            CREATE TABLE knowledge_validity (id TEXT, entity_type TEXT, entity_id TEXT, validity_score REAL, confidence_score REAL);
            CREATE TABLE evolution_entities (id TEXT, entity_type TEXT, entity_id TEXT, first_seen_at TEXT, last_seen_at TEXT, current_state TEXT, change_count INTEGER, status TEXT);
            CREATE TABLE evolution_events (id TEXT, entity_id TEXT, timestamp TEXT, event_type TEXT, old_value TEXT, new_value TEXT, importance_score INTEGER);
            CREATE TABLE review_outcomes (review_id TEXT, entity_type TEXT, entity_id TEXT, reviewer_email TEXT, reviewer_name TEXT, reviewer_accepted INTEGER, defects_found INTEGER, post_merge_incidents INTEGER, review_duration_hours REAL, created_at TEXT);
            CREATE TABLE incident_events (id TEXT, entity_type TEXT, entity_id TEXT, incident_type TEXT, source_type TEXT, severity TEXT, timestamp TEXT, resolved_at TEXT, root_cause_desc TEXT);
        `);

        store = new DecisionOutcomeStore(db);
        builder = new DecisionOutcomeBuilder(db, store);
        query = new DecisionOutcomeQueryEngine(db);
    });

    test('SUCCESSFUL Classification & Logarithmic Confidence', async () => {
        // ADR-1: Improving Health (80->95), Improving Validity (80->95), 0 Review Failures, 0 Incidents
        db.exec(`
            INSERT INTO architectural_health_history VALUES ('ADR', 'ADR-1', '2023-01-01', 80, 0, 0);
            INSERT INTO architectural_health_history VALUES ('ADR', 'ADR-1', '2023-01-02', 95, 0, 0);
            
            INSERT INTO knowledge_validity VALUES ('v1', 'ADR', 'ADR-1', 95, 100);
            INSERT INTO validity_history VALUES ('v1', '2023-01-01', 80, 100);
            INSERT INTO validity_history VALUES ('v1', '2023-01-02', 95, 100);

            -- Add 11 more evolution events to boost confidence (Total evidence = 2+2+11 = 15)
            INSERT INTO evolution_entities VALUES ('ee1', 'ADR', 'ADR-1', '2023-01-01', '2023-01-02', 'ACTIVE', 11, 'ACTIVE');
        `);

        for (let i = 0; i < 11; i++) {
            db.exec(`INSERT INTO evolution_events VALUES ('ev${i}', 'ADR-1', '2023-01-01', 'CHANGE', '', '', 1);`);
        }

        await builder.build();

        const outcome = query.getOutcome('ADR', 'ADR-1');
        expect(outcome).toBeDefined();
        expect(outcome!.outcomeType).toBe('SUCCESSFUL');
        expect(outcome!.healthTrend).toBe('IMPROVING');
        expect(outcome!.validityTrend).toBe('IMPROVING');
        
        // Penalties: Health: 5, Validity: 5, Evolution: 5 (since events > 10). Score = 100 - 15 = 85
        expect(outcome!.outcomeScore).toBe(85);

        // Confidence: 15 items => log10(16) * 40 = 1.204 * 40 ≈ 48.16
        expect(outcome!.evidenceCount).toBe(15);
        expect(Math.round(outcome!.confidenceScore)).toBe(48);

        // History snapshot created
        const history = query.getOutcomeHistory('ADR', 'ADR-1');
        expect(history.length).toBe(1);
        expect(history[0].outcomeType).toBe('SUCCESSFUL');
    });

    test('STABLE Classification & Day-1 Trend Handling', async () => {
        // ADR-2: Day 1 (Only 1 snapshot). Should default to STABLE trend.
        db.exec(`
            INSERT INTO architectural_health_history VALUES ('ADR', 'ADR-2', '2023-01-01', 90, 0, 0);
            INSERT INTO knowledge_validity VALUES ('v2', 'ADR', 'ADR-2', 90, 100);
            INSERT INTO validity_history VALUES ('v2', '2023-01-01', 90, 100);
            
            INSERT INTO review_outcomes VALUES ('r1', 'ADR', 'ADR-2', 'test@test.com', 'Test', 1, 0, 0, 1, '2023-01-01');
        `);

        await builder.build();

        const outcome = query.getOutcome('ADR', 'ADR-2');
        expect(outcome!.outcomeType).toBe('STABLE');
        expect(outcome!.healthTrend).toBe('STABLE');
        expect(outcome!.validityTrend).toBe('STABLE');
        expect(outcome!.outcomeScore).toBe(80); // 100 - 10 (health) - 10 (validity)
        expect(outcome!.evidenceCount).toBe(3); // 1 health, 1 validity, 1 review
    });

    test('DEGRADING Classification', async () => {
        // ADR-3: Degrading health
        db.exec(`
            INSERT INTO architectural_health_history VALUES ('ADR', 'ADR-3', '2023-01-01', 95, 0, 0);
            INSERT INTO architectural_health_history VALUES ('ADR', 'ADR-3', '2023-01-02', 80, 0, 0);
        `);

        await builder.build();

        const outcome = query.getOutcome('ADR', 'ADR-3');
        expect(outcome!.outcomeType).toBe('DEGRADING');
        expect(outcome!.healthTrend).toBe('DEGRADING');
        expect(outcome!.validityTrend).toBe('STABLE'); // fallback
    });

    test('FAILED Classification & Score Bounds', async () => {
        // ADR-4: Critical health (20), many review failures, 5 incidents
        db.exec(`
            INSERT INTO architectural_health_history VALUES ('ADR', 'ADR-4', '2023-01-01', 20, 0, 0);
            INSERT INTO review_outcomes VALUES ('r2', 'ADR', 'ADR-4', 'a@a.com', 'A', 0, 5, 0, 1, '2023-01-01');
            INSERT INTO review_outcomes VALUES ('r3', 'ADR', 'ADR-4', 'b@b.com', 'B', 0, 5, 0, 1, '2023-01-01');
            INSERT INTO incident_events VALUES ('i1', 'ADR', 'ADR-4', 'BUG', 'JIRA', 'HIGH', '2023-01-01', NULL, 'test');
            INSERT INTO incident_events VALUES ('i2', 'ADR', 'ADR-4', 'BUG', 'JIRA', 'HIGH', '2023-01-01', NULL, 'test');
            INSERT INTO incident_events VALUES ('i3', 'ADR', 'ADR-4', 'BUG', 'JIRA', 'HIGH', '2023-01-01', NULL, 'test');
        `);

        await builder.build();

        const outcome = query.getOutcome('ADR', 'ADR-4');
        expect(outcome!.outcomeType).toBe('FAILED');
        expect(outcome!.outcomeScore).toBe(0); // Bounded to 0
        expect(outcome!.reviewFailureCount).toBe(2);
        expect(outcome!.incidentCount).toBe(3);
    });

    test('High Evidence yields 100 Confidence', async () => {
        // ADR-5: 500 events
        db.exec(`INSERT INTO knowledge_validity VALUES ('v5', 'ADR', 'ADR-5', 100, 100);`);
        for (let i = 0; i < 500; i++) {
            db.exec(`INSERT INTO validity_history VALUES ('v5', '2023-01-${i}', 100, 100);`);
        }

        await builder.build();

        const outcome = query.getOutcome('ADR', 'ADR-5');
        expect(outcome!.confidenceScore).toBe(100); // Bounded to 100
    });
});
