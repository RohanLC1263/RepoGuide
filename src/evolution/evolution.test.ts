import { describe, test, expect, beforeEach } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { EvolutionStore } from './evolutionStore';
import { EvolutionBuilder } from './evolutionBuilder';
import { EvolutionQueryEngine } from './evolutionQueryEngine';

describe('Architectural Evolution Engine', () => {
    let db: DatabaseSync;
    let store: EvolutionStore;
    let builder: EvolutionBuilder;
    let query: EvolutionQueryEngine;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        
        db.exec(`
            CREATE TABLE adrs (id TEXT PRIMARY KEY, title TEXT);
            CREATE TABLE adr_code_links (id TEXT PRIMARY KEY, adr_id TEXT, node_id TEXT);
            CREATE TABLE architectural_health (entity_id TEXT PRIMARY KEY, entity_type TEXT, health_score REAL, trend TEXT);
            CREATE TABLE knowledge_validity (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, validity_score REAL, trend TEXT);
            CREATE TABLE knowledge_hotspots (entity_id TEXT PRIMARY KEY, hotspot_score REAL, severity TEXT, bus_factor INTEGER);
        `);

        store = new EvolutionStore(db);
        builder = new EvolutionBuilder(db, store);
        query = new EvolutionQueryEngine(db);
    });

    test('First run creates emerging entity and baseline snapshot', () => {
        db.exec(`
            INSERT INTO adrs (id, title) VALUES ('ADR-1', 'Auth');
            INSERT INTO adr_code_links (id, adr_id, node_id) VALUES ('l1', 'ADR-1', 'auth.ts');
            INSERT INTO architectural_health (entity_id, entity_type, health_score, trend) VALUES ('ADR-1', 'ADR', 100, 'STABLE');
            INSERT INTO knowledge_validity (id, entity_type, entity_id, validity_score, trend) VALUES ('v1', 'ADR', 'ADR-1', 100, 'STABLE');
            INSERT INTO knowledge_hotspots (entity_id, hotspot_score, severity, bus_factor) VALUES ('ADR-1', 10, 'LOW', 3);
        `);

        builder.buildForADR('ADR-1');

        const timeline = query.getTimeline('ADR-1');
        expect(timeline.snapshots.length).toBe(1);
        expect(timeline.snapshots[0].healthScore).toBe(100);
        expect(timeline.snapshots[0].nodeCount).toBe(1);

        const events = query.getEvolutionEvents('ADR-1');
        expect(events.length).toBe(1);
        expect(events[0].eventType).toBe('CREATED');
        expect(events[0].importanceScore).toBe(10); // Baseline creation score

        const entity = store.getEntity('ADR-1');
        expect(entity!.status).toBe('EMERGING');
    });

    test('Subsequent run with deltas records events and milestones', () => {
        // Setup initial state
        db.exec(`
            INSERT INTO adrs (id, title) VALUES ('ADR-2', 'DB');
            INSERT INTO adr_code_links (id, adr_id, node_id) VALUES ('l1', 'ADR-2', 'db.ts');
            INSERT INTO architectural_health (entity_id, entity_type, health_score, trend) VALUES ('ADR-2', 'ADR', 90, 'STABLE');
            INSERT INTO knowledge_validity (id, entity_type, entity_id, validity_score, trend) VALUES ('v1', 'ADR', 'ADR-2', 90, 'STABLE');
            INSERT INTO knowledge_hotspots (entity_id, hotspot_score, severity, bus_factor) VALUES ('ADR-2', 20, 'LOW', 2);
        `);

        // First build
        builder.buildForADR('ADR-2');

        // Fast forward time for the entity artificially so it isn't EMERGING
        const entity = store.getEntity('ADR-2')!;
        entity.firstSeenAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
        store.saveEntity(entity);

        // Mutate current state
        db.exec(`
            UPDATE architectural_health SET health_score = 70 WHERE entity_id = 'ADR-2';
            UPDATE knowledge_hotspots SET bus_factor = 1 WHERE entity_id = 'ADR-2';
            INSERT INTO adr_code_links (id, adr_id, node_id) VALUES ('l2', 'ADR-2', 'repo.ts');
            INSERT INTO adr_code_links (id, adr_id, node_id) VALUES ('l3', 'ADR-2', 'store.ts');
        `);

        // Second build
        builder.buildForADR('ADR-2');

        const events = query.getEvolutionEvents('ADR-2');
        
        // Expected events: HEALTH_CHANGED, RISK_CHANGED, EXPANDED, plus potentially MILESTONES (Health dropped below 80, Bus factor 1)
        const types = events.map(e => e.eventType);
        expect(types).toContain('HEALTH_CHANGED');
        expect(types).toContain('RISK_CHANGED');
        expect(types).toContain('EXPANDED');
        expect(types).toContain('EVOLUTION_MILESTONE');

        const milestones = query.getMilestones('ADR-2');
        expect(milestones.length).toBeGreaterThanOrEqual(2); // Health dropping <80 and BusFactor to 1

        const timeline = query.getTimeline('ADR-2');
        // Because of our daily snapshot ON CONFLICT DO UPDATE, running it on the same day just updates the daily snapshot.
        // So there's still 1 snapshot in history with the latest state!
        expect(timeline.snapshots.length).toBe(1);
        expect(timeline.snapshots[0].healthScore).toBe(70);
        expect(timeline.snapshots[0].busFactor).toBe(1);
        expect(timeline.snapshots[0].nodeCount).toBe(3);
    });

    test('Size-normalized velocity suppresses noise on massive subsystems', () => {
        db.exec(`
            INSERT INTO adrs (id, title) VALUES ('ADR-3', 'MassiveCore');
        `);

        // Fake massive size
        for(let i=0; i<1000; i++) {
            db.exec(`INSERT INTO adr_code_links (id, adr_id, node_id) VALUES ('l${i}', 'ADR-3', 'file${i}.ts')`);
        }

        builder.buildForADR('ADR-3');
        
        const entity = store.getEntity('ADR-3')!;
        entity.firstSeenAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // 1 year ago
        store.saveEntity(entity);

        // Generate some events
        db.exec(`
            INSERT INTO evolution_events (id, entity_id, timestamp, event_type, old_value, new_value, importance_score)
            VALUES ('e1', 'ADR-3', '2023-01-01', 'EXPANDED', '1000', '1010', 10);
            INSERT INTO evolution_events (id, entity_id, timestamp, event_type, old_value, new_value, importance_score)
            VALUES ('e2', 'ADR-3', '2023-01-02', 'HEALTH_CHANGED', '100', '95', 40);
        `);

        builder.buildForADR('ADR-3');
        
        const finalEntity = store.getEntity('ADR-3')!;
        // total importance = 10 + 40 = 50. 
        // 50 / 100 = 0.5. 
        // daysActive = 365. sizeFactor = log10(1000) = 3.
        // velocity = 0.5 / (365 * 3) = ~0.0004
        expect(finalEntity.evolutionVelocity).toBeLessThan(0.01);
    });
});
