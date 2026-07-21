import test from 'node:test';
import * as assert from 'node:assert/strict';
import { ProgramGraphProvider } from '../../query/programGraphProvider';
import { ProgramGraphStore } from '../../store/programGraphStore';
import { EvidenceProviderRequest } from '../../query/retrievalProvider';

/**
 * Regression test for the transport-layer half of the get_dependents /
 * get_dependencies "empty result" bug. mcpServer.ts forces
 * forceProviderIds: ['symbol_index', 'program_graph'] for a bare symbol,
 * intending "run the graph regardless of how this symbol classifies". But a
 * bare symbol classifies as 'repository_exploration', which is NOT in
 * ProgramGraphProvider.queryCategories, so canHandle's category gate declined
 * the request and the tool returned an empty list even though the graph held
 * the edges. The fix: a force-selected provider (forcedProviderIds) bypasses
 * the category gate; planner-driven retrieval still gates as before.
 */

function loadedGraphStore(): ProgramGraphStore {
    return { isLoaded: () => true, getStats: () => ({ nodeCount: 1, edgeCount: 1 }) } as unknown as ProgramGraphStore;
}

function request(opts: { category: string; providerIds: string[]; forcedProviderIds?: string[] }): EvidenceProviderRequest {
    return {
        requestId: 'r', planId: 'p', query: 'StoryGenerationAgent',
        category: opts.category as EvidenceProviderRequest['category'],
        retrievalPlan: {
            strategy: 'exact', targetSymbols: ['StoryGenerationAgent'], targetFiles: [], targetConcepts: [],
            providerIds: opts.providerIds, forcedProviderIds: opts.forcedProviderIds,
            excludedRoles: [], preferredEvidenceTypes: [], maxItems: 50, maxLatencyMs: 2500
        },
        targets: { symbols: ['StoryGenerationAgent'], files: [], concepts: [] },
        limits: { maxItems: 50, maxLatencyMs: 2500 },
        freshnessPolicy: { requireFreshEvidence: false }
    } as EvidenceProviderRequest;
}

test('canHandle: force-selected on a non-graph category (repository_exploration) -> true (the get_dependents path)', () => {
    const provider = new ProgramGraphProvider(loadedGraphStore());
    const decision = provider.canHandle(request({
        category: 'repository_exploration',
        providerIds: ['symbol_index', 'program_graph'],
        forcedProviderIds: ['symbol_index', 'program_graph']
    }));
    assert.equal(decision.canHandle, true);
});

test('canHandle: same non-graph category but NOT force-selected -> false (planner-driven gate unchanged)', () => {
    const provider = new ProgramGraphProvider(loadedGraphStore());
    const decision = provider.canHandle(request({
        category: 'repository_exploration',
        providerIds: ['symbol_index', 'program_graph'] // present, but forcedProviderIds undefined
    }));
    assert.equal(decision.canHandle, false);
    assert.match(decision.reason ?? '', /does not handle/i);
});

test('canHandle: a graph-relevant category resolves true without forcing (happy path unchanged)', () => {
    const provider = new ProgramGraphProvider(loadedGraphStore());
    const decision = provider.canHandle(request({
        category: 'dependency_analysis',
        providerIds: ['program_graph']
    }));
    assert.equal(decision.canHandle, true);
});

test('canHandle: program_graph absent from providerIds -> false even if force list names others', () => {
    const provider = new ProgramGraphProvider(loadedGraphStore());
    const decision = provider.canHandle(request({
        category: 'dependency_analysis',
        providerIds: ['symbol_index'],
        forcedProviderIds: ['symbol_index']
    }));
    assert.equal(decision.canHandle, false);
    assert.match(decision.reason ?? '', /not selected/i);
});
