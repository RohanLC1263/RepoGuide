import test from 'node:test';
import * as assert from 'node:assert/strict';
import { ProgramGraphProvider } from '../../query/programGraphProvider';
import { ProgramGraphStore } from '../../store/programGraphStore';
import { EvidenceProviderRequest } from '../../query/retrievalProvider';

/**
 * Regression test for the high-degree-symbol truncation bug: the get_dependents/
 * get_dependencies identity check matches the requested symbol against a
 * `graph_symbol_node` item, but the provider used to emit that anchor AFTER the
 * dependency list. For a high-degree symbol the dependency list exceeded the item
 * cap and truncated the anchor off, so a real, well-connected symbol reported
 * `found: false`. Fix: emit the anchor first so it survives truncation.
 */

// A synthetic graph store where 'HighDegree' has far more dependents than the cap.
function highDegreeStore(dependentCount: number): ProgramGraphStore {
    const node = (id: string, symbol?: string) => ({
        id, symbol, filePath: `src/${id}.ts`, type: 'function', startLine: 1, endLine: 2,
        role: 'implementation', uuid: id
    });
    const dependents = Array.from({ length: dependentCount }, (_, i) => node(`dep${i}`, `Dep${i}`));
    return {
        getNodesBySymbol: (sym: string) => (sym === 'HighDegree' ? ['node_HighDegree'] : []),
        getNode: (id: string) => (id === 'node_HighDegree' ? node('node_HighDegree', 'HighDegree') : node(id)),
        getDependents: (sym: string) => (sym === 'HighDegree'
            ? { callers: dependents, readers: [], importers: [], instantiators: [], fallbackConsumers: [], confidence: 'HIGH' }
            : { callers: [], readers: [], importers: [], instantiators: [], fallbackConsumers: [], confidence: 'LOW' }),
        getDependencies: (sym: string) => (sym === 'HighDegree'
            ? { callees: dependents, readTargets: [], importTargets: [], instantiationTargets: [], fallbackTargets: [], confidence: 'HIGH' }
            : { callees: [], readTargets: [], importTargets: [], instantiationTargets: [], fallbackTargets: [], confidence: 'LOW' }),
        getOutboundEdges: () => []
    } as unknown as ProgramGraphStore;
}

function request(maxItems: number): EvidenceProviderRequest {
    return {
        requestId: 'r', planId: 'p', query: 'HighDegree', category: 'dependency_analysis',
        retrievalPlan: {
            strategy: 'exact', targetSymbols: ['HighDegree'], targetFiles: [], targetConcepts: [],
            providerIds: ['program_graph'], forcedProviderIds: ['program_graph'],
            excludedRoles: [], preferredEvidenceTypes: [], maxItems, maxLatencyMs: 2500
        },
        targets: { symbols: ['HighDegree'], files: [], concepts: [] },
        limits: { maxItems, maxLatencyMs: 2500 },
        freshnessPolicy: { requireFreshEvidence: false }
    } as EvidenceProviderRequest;
}

test('the graph_symbol_node anchor survives truncation even when dependents far exceed the item cap', async () => {
    // 60 callers + 60 callees = 120 dependency items, capped at 50 -- the anchor
    // (emitted first) must still be present so the identity check can match it.
    const provider = new ProgramGraphProvider(highDegreeStore(60));
    const res = await provider.retrieve(request(50));

    const anchor = res.items.find(i => i.retrieval_signal === 'graph_symbol_node' && i.symbol === 'HighDegree');
    assert.ok(anchor, 'the requested symbol\'s graph_symbol_node anchor must survive the cap');
    assert.equal(res.items.length, 50, 'result is still capped');
    // And it is at/near the front, not buried after the dependency list.
    assert.ok(res.items.indexOf(anchor!) < 2, 'anchor should be emitted first, not after the deps');
});

test('a low-degree symbol still returns its anchor (no regression)', async () => {
    const provider = new ProgramGraphProvider(highDegreeStore(3));
    const res = await provider.retrieve(request(50));
    assert.ok(res.items.some(i => i.retrieval_signal === 'graph_symbol_node' && i.symbol === 'HighDegree'));
});
