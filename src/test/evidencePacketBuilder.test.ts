import test from 'node:test';
import * as assert from 'node:assert/strict';
import { EvidencePacketBuilder } from '../query/evidencePacketBuilder';
import { buildEvidencePlan } from '../query/evidencePlanner';

test('Evidence Packet Builder', async () => {
    // We mock the stores to return predictable data
    const mockUnitStore = {
        searchBySymbol: async (symbol: string) => {
            if (symbol === 'CONFIG_TIMEOUT') return [{ id: 'u1', role: 'implementation' }];
            if (symbol === 'DEFAULT_ITEMS') return [{ id: 'u2', role: 'implementation' }];
            if (symbol === 'fetchData') return [{ id: 'u3', role: 'implementation' }];
            if (symbol === 'Worker') return [{ id: 'u4', role: 'implementation' }];
            if (symbol === 'fakeHelper') return [{ id: 'u5', role: 'test' }];
            return [];
        },
        getUnit: async (id: string) => {
            if (id === 'u1') return { id: 'u1', type: 'constant_block', symbol: 'CONFIG_TIMEOUT', filePath: 'src/config.ts', language: 'typescript', startLine: 1, endLine: 1, content: 'const CONFIG_TIMEOUT = 5000;', role: 'implementation', parseStatus: 'valid' };
            if (id === 'u2') return { id: 'u2', type: 'constant_block', symbol: 'DEFAULT_ITEMS', filePath: 'src/config.ts', language: 'typescript', startLine: 2, endLine: 2, content: 'const DEFAULT_ITEMS = [];', role: 'implementation', parseStatus: 'valid' };
            if (id === 'u3') return { id: 'u3', type: 'function', symbol: 'fetchData', filePath: 'src/api.ts', language: 'typescript', startLine: 10, endLine: 20, content: 'function fetchData() {}', role: 'implementation', parseStatus: 'valid' };
            if (id === 'u4') return { id: 'u4', type: 'class', symbol: 'Worker', filePath: 'src/worker.ts', language: 'typescript', startLine: 1, endLine: 10, content: 'class Worker {}', role: 'implementation', parseStatus: 'valid' };
            if (id === 'u5') return { id: 'u5', type: 'function', symbol: 'fakeHelper', filePath: 'src/test.ts', language: 'typescript', startLine: 1, endLine: 5, content: 'function fakeHelper() {}', role: 'test', parseStatus: 'valid' };
            return undefined;
        }
    } as any;

    const mockFactStore = {
        findBySymbol: async (symbol: string, options: any = {}) => {
            if (options.excludeRoles && options.excludeRoles.includes('test') && symbol === 'fakeHelper') return [];
            
            if (symbol === 'CONFIG_TIMEOUT') return [{ factId: 'f1', filePath: 'src/config.ts', symbol: 'CONFIG_TIMEOUT', factType: 'numeric_threshold', value: 5000, confidence: 1.0, role: 'implementation' }];
            if (symbol === 'DEFAULT_ITEMS') return [{ factId: 'f2', filePath: 'src/config.ts', symbol: 'DEFAULT_ITEMS', factType: 'list_count', value: 0, confidence: 1.0, role: 'implementation' }];
            if (symbol === 'fetchData') return [{ factId: 'f3', filePath: 'src/api.ts', symbol: 'fetchData', factType: 'fallback_chain', value: 'a -> b', confidence: 0.9, role: 'implementation' }];
            if (symbol === 'Worker') return [{ factId: 'f4', filePath: 'src/worker.ts', symbol: 'Worker', factType: 'instantiation', value: 'new Worker()', confidence: 0.95, role: 'implementation' }];
            return [];
        }
    } as any;

    const mockBm25Store = {
        search: async () => {
            return []; // Return empty for BM25 to focus on exact matches
        }
    } as any;

    const stores = {
        unitStore: mockUnitStore,
        factStore: mockFactStore,
        bm25Store: mockBm25Store
    };

    const builder = new EvidencePacketBuilder(stores);

    // 1. exact threshold query retrieves numeric fact and source unit
    const plan1 = buildEvidencePlan('What is the CONFIG_TIMEOUT limit?');
    const packet1 = await builder.buildPacket(plan1.originalQuery, plan1);
    assert.ok(packet1.facts.find(f => f.type === 'numeric_threshold' && f.symbol === 'CONFIG_TIMEOUT'));
    assert.ok(packet1.items.find(i => i.symbol === 'CONFIG_TIMEOUT' && i.type === 'constant_block'));

    // 2. list count query retrieves list_count and constant block
    const plan2 = buildEvidencePlan('How many items in DEFAULT_ITEMS?');
    const packet2 = await builder.buildPacket(plan2.originalQuery, plan2);
    assert.ok(packet2.facts.find(f => f.type === 'list_count' && f.symbol === 'DEFAULT_ITEMS'));

    // 3. fallback query retrieves full function and relevant branch/fallback facts
    const plan3 = buildEvidencePlan('What is the fallback failover for fetchData?');
    const packet3 = await builder.buildPacket(plan3.originalQuery, plan3);
    assert.ok(packet3.facts.find(f => f.type === 'fallback_chain'));
    assert.ok(packet3.items.find(i => i.type === 'function'));

    // 4. dependency injection query retrieves instantiation facts and source spans
    const plan4 = buildEvidencePlan('How is Worker injected and initialized?');
    const packet4 = await builder.buildPacket(plan4.originalQuery, plan4);
    assert.ok(packet4.facts.find(f => f.type === 'instantiation'));

    // 5. non-test query never returns test/generated evidence
    const plan5 = buildEvidencePlan('What is the value of fakeHelper?');
    const packet5 = await builder.buildPacket(plan5.originalQuery, plan5);
    // Even though fakeHelper matches, it is suppressed by the builder
    assert.equal(packet5.items.length, 0);
    assert.equal(packet5.facts.length, 0);

    // 6. missing symbol returns a structured gap and no legacy fallback
    const plan6 = buildEvidencePlan('What is the limit for MISSING_SYMBOL?');
    const packet6 = await builder.buildPacket(plan6.originalQuery, plan6);
    assert.ok(packet6.gaps.find(g => g.includes('structured gap: symbol not found')));

    // 7. packet order is deterministic across 3 runs
    const run1 = await builder.buildPacket(plan1.originalQuery, plan1);
    const run2 = await builder.buildPacket(plan1.originalQuery, plan1);
    const run3 = await builder.buildPacket(plan1.originalQuery, plan1);
    assert.deepEqual(run1.facts, run2.facts);
    assert.deepEqual(run2.facts, run3.facts);
});
