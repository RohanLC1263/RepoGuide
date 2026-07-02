import test from 'node:test';
import * as assert from 'node:assert/strict';
import { ProgramGraphBuilder } from '../graph/programGraphBuilder';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { FactStore } from '../store/factStore';
import { LogicalUnit } from '../indexing/logicalUnitTypes';
import { FactRecord } from '../indexing/factTypes';

test('Program Graph Builder', async () => {
    const mockUnits: LogicalUnit[] = [
        {
            id: 'u1',
            type: 'function',
            symbol: 'fetchData',
            filePath: 'src/api.ts',
            language: 'typescript',
            startLine: 1,
            endLine: 5,
            content: 'function fetchData() { return axios.get(); }',
            role: 'implementation',
            parseStatus: 'complete',
            extractionMethod: 'tree_sitter',
            metadata: { confidence: 'high' }
        },
        {
            id: 'u2',
            type: 'function',
            symbol: 'getData',
            filePath: 'src/api.ts',
            language: 'typescript',
            startLine: 10,
            endLine: 15,
            content: 'function getData() { return fetchData(); }',
            role: 'implementation',
            parseStatus: 'complete',
            extractionMethod: 'tree_sitter',
            metadata: { confidence: 'high' }
        }
    ];

    const mockFacts: FactRecord[] = [
        {
            factId: 'f1',
            filePath: 'src/api.ts',
            unitId: 'u2',
            symbol: 'fetchData',
            factType: 'call_site',
            value: 'fetchData',
            valueKind: 'string',
            startLine: 11,
            endLine: 11,
            extractionMethod: 'tree_sitter',
            confidence: 'high',
            sourceText: 'fetchData',
            role: 'implementation'
        }
    ];

    const mockUnitStore = {
        listIndexes: async () => mockUnits.map(u => ({
            id: u.id, type: u.type, symbol: u.symbol, filePath: u.filePath,
            language: u.language, startLine: u.startLine, endLine: u.endLine, role: u.role, parseStatus: u.parseStatus
        })),
        getUnit: async (id: string) => mockUnits.find(u => u.id === id)
    } as unknown as LogicalUnitStore;

    const mockFactStore = {
        findByType: async (type: string) => mockFacts.filter(f => f.factType === type)
    } as unknown as FactStore;

    const builder = new ProgramGraphBuilder();
    const graph = await builder.build(mockUnitStore, mockFactStore, '/repo');

    assert.ok(graph.nodes['u1']);
    assert.ok(graph.nodes['u2']);
    assert.ok(graph.nodes['file::src/api.ts']);

    const callEdges = graph.edges.filter(e => e.type === 'calls');
    assert.equal(callEdges.length, 1);
    assert.equal(callEdges[0].from, 'u2');
    assert.equal(callEdges[0].to, 'u1');

    const containsEdges = graph.edges.filter(e => e.type === 'contains');
    assert.equal(containsEdges.length, 2);
    assert.equal(containsEdges[0].from, 'file::src/api.ts');
    assert.equal(containsEdges[0].to, 'u1');
    assert.equal(containsEdges[1].from, 'file::src/api.ts');
    assert.equal(containsEdges[1].to, 'u2');
});
