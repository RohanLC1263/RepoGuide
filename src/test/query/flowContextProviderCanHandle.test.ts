import test from 'node:test';
import * as assert from 'node:assert/strict';
import { FlowContextProvider } from '../../query/flowContextProvider';
import { EvidenceProviderRequest } from '../../query/retrievalProvider';

/**
 * Induced-failure regression test for the bug behind the live-tested
 * get_facts bloat: FlowContextProvider.canHandle was missing the
 * providerIds membership check present on all seven other providers (see
 * factStoreProvider.ts's canHandle), so mcpServer.ts's get_facts tool
 * forcing forceProviderIds: ['fact_store'] didn't actually exclude
 * flow_context items -- they rode along and got returned labeled "facts."
 *
 * Confirmed as a real induced failure: reverting the providerIds check in
 * flowContextProvider.ts makes the second test below fail (canHandle
 * returns true even though 'flow_context' isn't in providerIds).
 */

function fakeComprehensionEngine(flowExtractorReady: boolean) {
    return {
        getFlowExtractor: () => (flowExtractorReady ? {} : null)
    } as any;
}

function requestWithProviderIds(providerIds: string[]): EvidenceProviderRequest {
    return {
        requestId: 'req1',
        planId: 'plan1',
        query: 'some query',
        category: 'dependency_analysis',
        retrievalPlan: {
            strategy: 'hybrid',
            targetSymbols: [],
            targetFiles: [],
            targetConcepts: [],
            providerIds,
            excludedRoles: [],
            preferredEvidenceTypes: [],
            maxItems: 50,
            maxLatencyMs: 2500
        },
        targets: { symbols: [], files: [], concepts: [] },
        limits: { maxItems: 50, maxLatencyMs: 2500 },
        freshnessPolicy: { requireFreshEvidence: false }
    };
}

test('canHandle: flow_context IS in providerIds and the call graph is ready -> true (unchanged happy path)', () => {
    const provider = new FlowContextProvider(fakeComprehensionEngine(true), undefined, undefined);
    const request = requestWithProviderIds(['symbol_index', 'fact_store', 'flow_context']);
    const decision = provider.canHandle(request);
    assert.equal(decision.canHandle, true);
});

test('canHandle: flow_context is NOT in providerIds (e.g. get_facts forcing forceProviderIds: ["fact_store"]) -> false, not a silent pass-through', () => {
    const provider = new FlowContextProvider(fakeComprehensionEngine(true), undefined, undefined);
    const request = requestWithProviderIds(['fact_store']);
    const decision = provider.canHandle(request);
    assert.equal(decision.canHandle, false);
});

test('canHandle: flow_context excluded from providerIds takes priority even when the call graph is otherwise ready', () => {
    // Confirms the providerIds check runs regardless of readiness state --
    // a ready call graph must not override a request that never selected
    // this provider in the first place.
    const provider = new FlowContextProvider(fakeComprehensionEngine(true), undefined, undefined);
    const decision = provider.canHandle(requestWithProviderIds(['program_graph']));
    assert.equal(decision.canHandle, false);
    assert.match(decision.reason ?? '', /not selected/i);
});
