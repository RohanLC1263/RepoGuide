import { expect, test, describe, beforeEach, afterEach, jest } from '@jest/globals';
import { ADRStore } from './adrStore';
import { ADRParser } from './adrParser';
import { ADRDiscoveryEngine } from './adrDiscoveryEngine';
import { ADRIngestionEngine } from './adrIngestionEngine';
import { ADRQueryEngine } from './adrQueryEngine';
import * as path from 'path';

class MockDiscoveryEngine extends ADRDiscoveryEngine {
    constructor() {
        super('/mock/workspace');
    }
    public async discover(): Promise<string[]> {
        return [
            '/mock/workspace/docs/adr/0001-init.md',
            '/mock/workspace/docs/adr/0002-use-sqlite.md'
        ];
    }
}

// Mock fs to intercept readFile
jest.mock('fs', () => ({
    ...(jest.requireActual('fs') as any),
    promises: {
        ...(jest.requireActual('fs') as any).promises,
        readFile: jest.fn().mockImplementation((p: any) => {
            if (p.includes('0001')) {
                return Promise.resolve(`# 1. Init
## Status
Accepted

## Context
We need to start.

## Decision
We will build it.

## Consequences
It works.`);
            }
            if (p.includes('0002')) {
                return Promise.resolve(`# 2. Use SQLite
## Status
SuperSeded by [ADR 0005](0005-use-postgres.md)

## Context
We need storage.

## Decision
We will use SQLite.

## Consequences
It is fast.`);
            }
            return Promise.resolve('');
        })
    }
}));

describe('ADR Ingestion Engine', () => {
    let adrStore: ADRStore;
    let parser: ADRParser;
    let discovery: MockDiscoveryEngine;
    let ingestionEngine: ADRIngestionEngine;
    let queryEngine: ADRQueryEngine;

    beforeEach(() => {
        adrStore = new ADRStore(':memory:');
        parser = new ADRParser();
        discovery = new MockDiscoveryEngine();
        ingestionEngine = new ADRIngestionEngine(adrStore, discovery, parser, '/mock/workspace', 'local-repo');
        queryEngine = new ADRQueryEngine(adrStore);
    });

    afterEach(() => {
        adrStore.close();
        jest.clearAllMocks();
    });

    test('Parser extracts ADREntity and References from MADR format', () => {
        const content = `
# 14. Use JSON for Graph
## Status
Proposed
## Context
We need to store the graph.
## Decision
Use JSON.
## Consequences
High memory usage.
## References
Supersedes [ADR 12](0012-use-xml.md)
        `;
        
        const { adr, references } = parser.parse(content, 'docs/adr/0014-use-json.md', 'repo-1');
        
        expect(adr.id).toBe('0014-use-json');
        expect(adr.number).toBe('0014');
        expect(adr.status).toBe('PROPOSED');
        expect(adr.context).toBe('We need to store the graph.');
        expect(adr.decision).toBe('Use JSON.');
        expect(adr.consequences).toBe('High memory usage.');
        expect(adr.parserConfidence).toBe('HIGH');
        
        expect(references.length).toBe(1);
        expect(references[0].targetAdrId).toBe('0012-use-xml');
        expect(references[0].relation).toBe('SUPERSEDES');
    });

    test('Ingestion Engine incrementally syncs ADRs using sourceHash', async () => {
        const stats = await ingestionEngine.syncIncremental();
        
        expect(stats.adrsProcessed).toBe(2);
        
        // Second sync should be a no-op due to identical hash
        const stats2 = await ingestionEngine.syncIncremental();
        expect(stats2.adrsProcessed).toBe(0);
        
        const adrs = await queryEngine.listADRs();
        expect(adrs.length).toBe(2);
        
        // Check Status normalization
        const initAdr = adrs.find(a => a.id === '0001-init')!;
        expect(initAdr.status).toBe('ACCEPTED');
        
        const sqliteAdr = adrs.find(a => a.id === '0002-use-sqlite')!;
        expect(sqliteAdr.status).toBe('SUPERSEDED');
        
        const refs = await queryEngine.getReferences(sqliteAdr.id);
        expect(refs.length).toBe(1);
        expect(refs[0].targetAdrId).toBe('0005-use-postgres');
    });

    test('Query Engine supports specific lookups', async () => {
        await ingestionEngine.syncIncremental();
        
        const accepted = await queryEngine.listAcceptedADRs();
        expect(accepted.length).toBe(1);
        expect(accepted[0].id).toBe('0001-init');
        
        const search = await queryEngine.searchByTitle('use sqlite');
        expect(search.length).toBe(1);
        expect(search[0].id).toBe('0002-use-sqlite');
    });
});
