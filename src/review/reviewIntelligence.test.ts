import { describe, test, expect, beforeEach } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { ReviewIntelligenceStore } from './reviewIntelligenceStore';
import { ReviewIntelligenceEngine } from './reviewIntelligenceEngine';
import { ReviewIntelligenceQueryEngine } from './reviewIntelligenceQueryEngine';

describe('Review Intelligence Engine', () => {
    let db: DatabaseSync;
    let store: ReviewIntelligenceStore;
    let engine: ReviewIntelligenceEngine;
    let query: ReviewIntelligenceQueryEngine;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        
        // Mock dependencies
        db.exec(`
            CREATE TABLE adr_code_links (id TEXT PRIMARY KEY, adr_id TEXT, node_id TEXT);
            CREATE TABLE intent_aware_impacts (id TEXT PRIMARY KEY, root_node_id TEXT, governance_score REAL);
            CREATE TABLE impact_nodes (impact_id TEXT, node_id TEXT);
            CREATE TABLE logical_coupling_edges (source_path TEXT, target_path TEXT, confidence REAL, co_change_count INTEGER);
            CREATE TABLE author_expertise (author_email TEXT, author_name TEXT, entity_type TEXT, entity_id TEXT, coverage_percentage REAL, knowledge_age_days INTEGER, expertise_score REAL);
            CREATE TABLE architectural_health (entity_id TEXT PRIMARY KEY, entity_type TEXT, health_score REAL);
            CREATE TABLE knowledge_hotspots (entity_id TEXT PRIMARY KEY, hotspot_score REAL, severity TEXT, bus_factor INTEGER);
        `);

        store = new ReviewIntelligenceStore(db);
        engine = new ReviewIntelligenceEngine(db, store);
        query = new ReviewIntelligenceQueryEngine(db);
    });

    test('Generates basic recommendation', () => {
        db.exec(`
            INSERT INTO adr_code_links (id, adr_id, node_id) VALUES ('l1', 'ADR-1', 'auth.ts');
            INSERT INTO architectural_health (entity_id, entity_type, health_score) VALUES ('ADR-1', 'ADR', 80);
            INSERT INTO knowledge_hotspots (entity_id, hotspot_score, severity, bus_factor) VALUES ('ADR-1', 40, 'MEDIUM', 3);
            INSERT INTO author_expertise (author_email, author_name, entity_type, entity_id, expertise_score, knowledge_age_days) 
            VALUES ('alice@ex.com', 'Alice', 'FILE', 'auth.ts', 100, 10);
        `);

        const rec = engine.generateRecommendation('pr-1', ['auth.ts']);
        
        expect(rec.changeId).toBe('pr-1');
        expect(rec.riskLevel).toBeDefined(); // (20 + 40 + 0 + 0)/4 = 15 => LOW
        
        const scope = query.getReviewScope(rec.id);
        expect(scope.length).toBe(1);
        expect(scope[0].filePath).toBe('auth.ts');
        
        const reviewers = query.getSuggestedReviewers(rec.id);
        expect(reviewers.length).toBe(1);
        expect(reviewers[0].authorEmail).toBe('alice@ex.com');
    });

    test('Backup reviewer boost for bus factor 1', () => {
        db.exec(`
            INSERT INTO adr_code_links (id, adr_id, node_id) VALUES ('l1', 'ADR-1', 'auth.ts');
            INSERT INTO knowledge_hotspots (entity_id, hotspot_score, severity, bus_factor) VALUES ('ADR-1', 95, 'CRITICAL', 1);
            
            -- Alice is the primary expert
            INSERT INTO author_expertise (author_email, author_name, entity_type, entity_id, expertise_score, knowledge_age_days) 
            VALUES ('alice@ex.com', 'Alice', 'FILE', 'auth.ts', 1000, 10);
            
            -- Bob is a backup (raw score 200, base score 20%)
            INSERT INTO author_expertise (author_email, author_name, entity_type, entity_id, expertise_score, knowledge_age_days) 
            VALUES ('bob@ex.com', 'Bob', 'FILE', 'auth.ts', 200, 10);
        `);

        const rec = engine.generateRecommendation('pr-2', ['auth.ts']);
        const reviewers = query.getSuggestedReviewers(rec.id);
        
        // Alice base 100 * 1.0 = 100
        // Bob base 20. Boosted 2x = 40.
        expect(reviewers.length).toBe(2);
        
        const alice = reviewers.find(r => r.authorEmail === 'alice@ex.com');
        const bob = reviewers.find(r => r.authorEmail === 'bob@ex.com');
        
        expect(alice!.reviewerScore).toBeCloseTo(100);
        expect(bob!.reviewerScore).toBeCloseTo(40);
        
        // Ensure outcome is saved
        store.saveOutcome({
            reviewId: 'out-1',
            entityType: 'ADR',
            entityId: 'ADR-1',
            reviewerEmail: 'bob@ex.com',
            reviewerName: 'Bob',
            reviewerAccepted: true,
            defectsFound: 1,
            postMergeIncidents: 0,
            reviewDurationHours: 2.5,
            createdAt: new Date()
        });

        const outcomes = query.getReviewOutcomes('bob@ex.com');
        expect(outcomes.length).toBe(1);
        expect(outcomes[0].defectsFound).toBe(1);
    });

    test('Scope expands using intent and logical coupling but deduplicates', () => {
        db.exec(`
            -- Impact graph
            INSERT INTO intent_aware_impacts (id, root_node_id, governance_score) VALUES ('i1', 'auth.ts', 50);
            INSERT INTO impact_nodes (impact_id, node_id) VALUES ('i1', 'db.ts');
            
            -- Logical Coupling
            INSERT INTO logical_coupling_edges (source_path, target_path, confidence, co_change_count) VALUES ('auth.ts', 'api.ts', 0.8, 10);
            INSERT INTO logical_coupling_edges (source_path, target_path, confidence, co_change_count) VALUES ('db.ts', 'api.ts', 0.8, 10);

            INSERT INTO author_expertise (author_email, author_name, entity_type, entity_id, expertise_score, knowledge_age_days) 
            VALUES ('alice@ex.com', 'Alice', 'FILE', 'auth.ts', 100, 10);
        `);

        const rec = engine.generateRecommendation('pr-3', ['auth.ts']);
        const scopes = query.getReviewScope(rec.id);
        
        // Scope should contain: auth.ts, db.ts, api.ts (deduplicated)
        expect(scopes.length).toBe(3);
        const paths = scopes.map(s => s.filePath);
        expect(paths).toContain('auth.ts');
        expect(paths).toContain('db.ts');
        expect(paths).toContain('api.ts');
    });

    test('Attributes review outcomes to specific entity (ADR)', () => {
        store.saveOutcome({
            reviewId: 'out-adr',
            entityType: 'ADR',
            entityId: 'ADR-42',
            reviewerEmail: 'charlie@ex.com',
            reviewerName: 'Charlie',
            reviewerAccepted: false,
            defectsFound: 3,
            postMergeIncidents: 1,
            reviewDurationHours: 1.5,
            createdAt: new Date()
        });

        const row = db.prepare(`SELECT * FROM review_outcomes WHERE entity_type = 'ADR' AND entity_id = 'ADR-42'`).get() as any;
        expect(row).toBeDefined();
        expect(row.defects_found).toBe(3);
        expect(row.post_merge_incidents).toBe(1);
    });
});
