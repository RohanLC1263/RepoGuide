import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { TestCoverageStore } from './testCoverageStore';
import { TestCoverageBuilder } from './testCoverageBuilder';
import { TestCoverageQueryEngine } from './testCoverageQueryEngine';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('fs', () => {
    return {
        existsSync: jest.fn(),
        promises: {
            readFile: jest.fn()
        }
    };
});

describe('Test Coverage Component', () => {
    let db: DatabaseSync;
    let store: TestCoverageStore;
    let builder: TestCoverageBuilder;
    let engine: TestCoverageQueryEngine;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        
        // Setup dependent schemas
        db.exec(`
            CREATE TABLE adr_file_links (adr_id TEXT, file_path TEXT);
            CREATE TABLE knowledge_hotspots (entity_type TEXT, entity_id TEXT, hotspot_score REAL);
            CREATE TABLE intent_aware_impacts (target_entity_id TEXT, impact_score REAL);
            
            INSERT INTO adr_file_links (adr_id, file_path) VALUES 
            ('ADR-1', 'src/auth/authService.ts'),
            ('ADR-1', 'src/auth/authController.ts'),
            ('ADR-2', 'src/billing/billingService.ts');
            
            INSERT INTO knowledge_hotspots (entity_type, entity_id, hotspot_score) VALUES
            ('FILE', 'src/auth/authService.ts', 80),
            ('ADR', 'ADR-1', 90);
            
            INSERT INTO intent_aware_impacts (target_entity_id, impact_score) VALUES
            ('src/auth/authService.ts', 50);
        `);

        store = new TestCoverageStore(db);
        builder = new TestCoverageBuilder(db, store, '/mock/root');
        engine = new TestCoverageQueryEngine(db);
    });

    test('should insert and query coverage risk bounded correctly', async () => {
        const mockFs = (jest as any).requireMock('fs') as any;
        mockFs.existsSync.mockReturnValue(true);
        mockFs.promises.readFile.mockResolvedValue(JSON.stringify({
            'src/auth/authService.ts': { s: { '0': 1, '1': 1, '2': 0 } }, // 66% coverage
            'src/auth/authController.ts': { s: { '0': 1, '1': 1 } }, // 100% coverage
            'src/billing/billingService.ts': { s: { '0': 0, '1': 0 } } // 0% coverage
        }));

        await builder.build();

        // Check ADR aggregation (authService=2/3, authController=2/2 -> ADR-1=4/5 = 80%)
        const adr1 = engine.getCoverage('ADR', 'ADR-1');
        expect(adr1).toBeDefined();
        expect(adr1?.coveragePercent).toBe(80);
        expect(adr1?.coverageStatus).toBe('GOOD');

        // Check Subsystem aggregation ('src/auth' = 4/5 = 80%)
        const authSubsystem = engine.getCoverage('SUBSYSTEM', 'src/auth');
        expect(authSubsystem).toBeDefined();
        expect(authSubsystem?.coveragePercent).toBe(80);

        // Check Risk Calculation
        // src/auth/authService.ts: Cov=66, Hotspot=80, Blast=50
        // Penalty: (100-66)*0.5 + 80*0.25 + 50*0.25 = 17 + 20 + 12.5 = 49.5 -> MEDIUM risk
        const risk = engine.getCoverageRisk('FILE', 'src/auth/authService.ts');
        expect(risk).toBeDefined();
        expect(risk?.riskScore).toBeCloseTo(49.5);
        expect(risk?.riskLevel).toBe('MEDIUM');
    });

    test('should handle graceful skip when coverage-final.json is missing', async () => {
        const mockFs = (jest as any).requireMock('fs') as any;
        mockFs.existsSync.mockReturnValue(false); // No coverage file

        await builder.build();

        // Shouldn't crash, and should yield no entries if DB was empty
        const weak = engine.getWeakCoverage();
        expect(weak.length).toBe(0);
    });
});
