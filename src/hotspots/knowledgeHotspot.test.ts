import { describe, test, expect, beforeEach } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeHotspotStore } from './knowledgeHotspotStore';
import { KnowledgeHotspotBuilder } from './knowledgeHotspotBuilder';
import { KnowledgeHotspotQueryEngine } from './knowledgeHotspotQueryEngine';

describe('Knowledge Hotspot Engine', () => {
    let db: DatabaseSync;
    let store: KnowledgeHotspotStore;
    let builder: KnowledgeHotspotBuilder;
    let query: KnowledgeHotspotQueryEngine;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        
        // Mock dependencies
        db.exec(`
            CREATE TABLE adr_code_links (id TEXT PRIMARY KEY, adr_id TEXT, node_id TEXT);
            CREATE TABLE intent_aware_impacts (id TEXT PRIMARY KEY, root_node_id TEXT, governance_score REAL);
            CREATE TABLE logical_coupling_edges (source_path TEXT, target_path TEXT, confidence REAL, co_change_count INTEGER);
            CREATE TABLE author_expertise (author_email TEXT, entity_id TEXT, coverage_percentage REAL, knowledge_age_days INTEGER, expertise_score REAL);
            CREATE TABLE architectural_health (entity_id TEXT PRIMARY KEY, entity_type TEXT, health_score REAL);
        `);

        store = new KnowledgeHotspotStore(db);
        builder = new KnowledgeHotspotBuilder(db);
        query = new KnowledgeHotspotQueryEngine(store);
    });

    test('Computes Hotspot with concentration score correctly', () => {
        // Setup an ADR with low health
        db.exec(`INSERT INTO architectural_health (entity_id, entity_type, health_score) VALUES ('ADR-1', 'ADR', 20.0);`);
        
        // Link node to ADR
        db.exec(`INSERT INTO adr_code_links (id, adr_id, node_id) VALUES ('L1', 'ADR-1', 'file.ts');`);
        
        // Setup Blast Radius Impact
        db.exec(`INSERT INTO intent_aware_impacts (id, root_node_id, governance_score) VALUES ('I1', 'file.ts', 80.0);`);
        
        // Setup experts (Bus Factor = 1, Concentration = 0.8)
        db.exec(`
            INSERT INTO author_expertise (author_email, entity_id, coverage_percentage, knowledge_age_days, expertise_score)
            VALUES 
            ('alice@test.com', 'ADR-1', 1.0, 10, 80.0),
            ('bob@test.com', 'ADR-1', 0.1, 10, 20.0); -- low coverage, no bus factor
        `);

        builder.build();

        const hotspots = query.getHotspots();
        expect(hotspots.length).toBe(1);

        const h = hotspots[0];
        expect(h.healthScore).toBe(20.0);
        expect(h.blastRadiusScore).toBe(80.0);
        expect(h.couplingScore).toBe(0.0); // No coupling defined
        expect(h.busFactor).toBe(1); // Only Alice
        expect(h.expertCount).toBe(2);
        expect(h.knowledgeConcentrationScore).toBe(0.8); // 80 / 100
        
        // Calculation: 
        // BaseRisk = ((100-20)*0.4) + (80*0.3) + (0*0.3) = (80*0.4)+24 = 32 + 24 = 56
        // HotspotScore = 56 * 1.5 (BF=1) = 84
        expect(h.hotspotScore).toBe(84.0);
        expect(h.severity).toBe('CRITICAL');
    });

    test('Excludes stale experts from Bus Factor', () => {
        db.exec(`INSERT INTO architectural_health (entity_id, entity_type, health_score) VALUES ('ADR-1', 'ADR', 80.0);`);
        db.exec(`
            INSERT INTO author_expertise (author_email, entity_id, coverage_percentage, knowledge_age_days, expertise_score)
            VALUES 
            ('alice@test.com', 'ADR-1', 1.0, 400, 100.0); -- Stale
        `);

        builder.build();

        const h = query.getHotspot('ADR-1');
        expect(h).toBeDefined();
        expect(h!.busFactor).toBe(0); // Alice is stale
        expect(h!.expertCount).toBe(1);
        expect(h!.knowledgeConcentrationScore).toBe(1.0); // 100/100
        
        // BaseRisk = (20*0.4) = 8
        // Multiplier = 2.0
        // Score = 16
        expect(h!.hotspotScore).toBe(16.0);
        expect(h!.severity).toBe('LOW');
    });

    test('Coupling Density Normalization', () => {
        db.exec(`INSERT INTO architectural_health (entity_id, entity_type, health_score) VALUES ('ADR-1', 'ADR', 100.0);`);
        db.exec(`INSERT INTO architectural_health (entity_id, entity_type, health_score) VALUES ('ADR-2', 'ADR', 100.0);`);
        
        // ADR-1 has 2 files
        db.exec(`INSERT INTO adr_code_links (id, adr_id, node_id) VALUES ('L1', 'ADR-1', 'f1.ts');`);
        db.exec(`INSERT INTO adr_code_links (id, adr_id, node_id) VALUES ('L2', 'ADR-1', 'f2.ts');`);
        db.exec(`INSERT INTO adr_code_links (id, adr_id, node_id) VALUES ('L3', 'ADR-2', 'ext.ts');`);
        
        // 3 coupling edges from ADR-1 to outside
        db.exec(`INSERT INTO logical_coupling_edges (source_path, target_path) VALUES ('f1.ts', 'ext.ts');`);
        db.exec(`INSERT INTO logical_coupling_edges (source_path, target_path) VALUES ('f2.ts', 'ext.ts');`);
        db.exec(`INSERT INTO logical_coupling_edges (source_path, target_path) VALUES ('f1.ts', 'other.ts');`);

        builder.build();

        const h1 = query.getHotspot('ADR-1');
        // density = 3 edges / 2 nodes = 1.5
        // score = 1.5 * 10 = 15.0
        expect(h1!.couplingScore).toBe(15.0);
    });
});
