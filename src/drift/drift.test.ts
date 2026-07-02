import { DatabaseSync } from 'node:sqlite';
import { describe, test, expect, beforeEach } from '@jest/globals';
import { DriftStore } from './driftStore';
import { DriftBuilder } from './driftBuilder';
import { DriftQueryEngine } from './driftQueryEngine';

describe('Architectural Health Engine', () => {
    let db: DatabaseSync;
    let store: DriftStore;
    let builder: DriftBuilder;
    let query: DriftQueryEngine;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        
        // Mock external dependencies tables
        db.exec(`
            CREATE TABLE adrs (id TEXT PRIMARY KEY, created_at TEXT);
            CREATE TABLE adr_code_links (id TEXT PRIMARY KEY, adr_id TEXT, node_id TEXT);
            CREATE TABLE intent_evidence (intent_id TEXT, source_type TEXT, source_id TEXT);
            CREATE TABLE file_change_stats (path TEXT PRIMARY KEY, change_count INTEGER);
            CREATE TABLE logical_coupling_edges (source_path TEXT, target_path TEXT, confidence REAL, co_change_count INTEGER);
        `);

        store = new DriftStore(db);
        builder = new DriftBuilder(db);
        query = new DriftQueryEngine(store);
    });

    test('Detects MISSING_IMPLEMENTATION', () => {
        db.exec(`INSERT INTO adrs (id, created_at) VALUES ('ADR-1', '2020-01-01');`);
        // No adr_code_links inserted
        
        builder.build();
        
        const findings = query.getFindings();
        expect(findings.length).toBe(1);
        expect(findings[0].driftType).toBe('MISSING_IMPLEMENTATION');
        expect(findings[0].entityId).toBe('ADR-1');
        
        const health = query.getArchitecturalHealth('ADR-1');
        expect(health).toBeDefined();
        expect(health!.activeFindings).toBe(1);
    });

    test('Detects ORPHANED_IMPLEMENTATION with Hotspot Filtering', () => {
        // High change_count file with NO ADR
        db.exec(`INSERT INTO file_change_stats (path, change_count) VALUES ('src/core/OrphanedHotspot.ts', 150);`);
        // Low change_count file with NO ADR (should be ignored)
        db.exec(`INSERT INTO file_change_stats (path, change_count) VALUES ('src/utils/math.ts', 5);`);
        
        builder.build();
        
        const findings = query.getFindings();
        expect(findings.length).toBe(1);
        expect(findings[0].driftType).toBe('ORPHANED_IMPLEMENTATION');
        expect(findings[0].nodeId).toBe('src/core/OrphanedHotspot.ts');
        expect(findings[0].severity).toBe('CRITICAL'); // > 100 changes is CRITICAL
    });

    test('Detects GOVERNANCE_VIOLATION via Logical Coupling', () => {
        db.exec(`
            INSERT INTO adrs (id, created_at) VALUES ('ADR-A', '2023-01-01'), ('ADR-B', '2023-01-01');
            INSERT INTO adr_code_links (id, adr_id, node_id) VALUES 
            ('link1', 'ADR-A', 'fileA.ts'),
            ('link2', 'ADR-B', 'fileB.ts');
            
            INSERT INTO logical_coupling_edges (source_path, target_path, confidence, co_change_count) VALUES ('fileA.ts', 'fileB.ts', 0.9, 10);
        `);
        
        builder.build();
        
        const findings = query.getFindings();
        // Since GOVERNANCE_VIOLATION checks both directions if populated fully, but let's check if it caught it
        const viols = findings.filter(f => f.driftType === 'GOVERNANCE_VIOLATION');
        expect(viols.length).toBe(1);
        expect(viols[0].severity).toBe('CRITICAL');
        
        const evidence = query.getEvidenceForFinding(viols[0].id);
        expect(evidence.length).toBeGreaterThan(0);
        expect(evidence[0].evidenceType).toBe('COUPLING');
    });

    test('Detects EXCESSIVE_COUPLING', () => {
        db.exec(`
            INSERT INTO adrs (id, created_at) VALUES ('ADR-1', '2023-01-01'), ('ADR-2', '2023-01-01'), ('ADR-3', '2023-01-01'), ('ADR-4', '2023-01-01');
            INSERT INTO adr_code_links (id, adr_id, node_id) VALUES 
            ('l1', 'ADR-1', 'god_object.ts'),
            ('l2', 'ADR-2', 'file2.ts'),
            ('l3', 'ADR-3', 'file3.ts'),
            ('l4', 'ADR-4', 'file4.ts');
            
            INSERT INTO logical_coupling_edges (source_path, target_path, confidence, co_change_count) VALUES 
            ('god_object.ts', 'file2.ts', 0.9, 10),
            ('god_object.ts', 'file3.ts', 0.8, 10),
            ('god_object.ts', 'file4.ts', 0.85, 10);
        `);
        
        builder.build();
        
        const findings = query.getFindings();
        const excess = findings.find(f => f.driftType === 'EXCESSIVE_COUPLING');
        expect(excess).toBeDefined();
        expect(excess!.nodeId).toBe('god_object.ts');
        expect(excess!.severity).toBe('HIGH');
    });

    test('Resolution Lifecycle Tracking', async () => {
        // Initial state: missing implementation
        db.exec(`INSERT INTO adrs (id, created_at) VALUES ('ADR-1', '2020-01-01');`);
        
        builder.build();
        
        let findings = query.getFindings();
        expect(findings.length).toBe(1);
        expect(findings[0].resolutionState).toBe('ACTIVE');
        
        const findingId = findings[0].id;

        // Resolve it by adding code link
        db.exec(`INSERT INTO adr_code_links (id, adr_id, node_id) VALUES ('link1', 'ADR-1', 'code.ts');`);
        
        // Mock time passing by updating first_detected_at in DB directly to test lifetimeDays
        db.exec(`UPDATE drift_findings SET first_detected_at = '2020-01-01T00:00:00.000Z' WHERE id = '${findingId}'`);

        builder.build();
        
        findings = query.getFindings();
        expect(findings.filter(f => f.driftType === 'MISSING_IMPLEMENTATION').length).toBe(0);
        
        // Fetch resolved directly
        const resolvedRow = db.prepare(`SELECT * FROM drift_findings WHERE id = ?`).get(findingId) as any;
        expect(resolvedRow.resolution_state).toBe('RESOLVED');
        expect(resolvedRow.resolved_at).toBeDefined();
        expect(resolvedRow.lifetime_days).toBeGreaterThan(0);
        
        const history = query.getHistoryForFinding(findingId);
        expect(history.length).toBe(1); // One snapshot from the first build
    });
});
