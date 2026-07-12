import test from 'node:test';
import * as assert from 'node:assert/strict';
import { QueryDispatcher } from '../../query/queryDispatcher';
import { ConversationHistory } from '../../query/conversationHistory';
import { RepositoryContext } from '../../context/repositoryContext';
import { ExecutionPlan } from '../../query/executionPlanner';
import { EvidenceItem, SemanticCategory } from '../../query/evidencePacket';
import { RetrievalOrchestrationResult } from '../../query/retrievalOrchestrator';

/**
 * Live-tested finding this reproduces: retrieve_raw_evidence returned 137
 * items on an ordinary question despite being documented capped at 50 --
 * RetrievalOrchestrator.execute() only dedupes by id across providers, with
 * no aggregate cap, so N providers each independently honoring the 50-item
 * per-provider limit could union into far more than 50 total.
 *
 * Drives the REAL QueryDispatcher.retrieveRawEvidence() (not a reimplementation
 * of its logic) with a stubbed retrievalOrchestrator returning a canned,
 * multi-provider RetrievalOrchestrationResult shaped exactly like the real
 * bug: 5 providers, 30 real EvidenceItem objects each (150 total, matching
 * the "N providers x per-provider cap" failure mode), each provider's list
 * already in its own internal rank order (descending score, as
 * FactStoreProvider/hybrid fusion genuinely return). Confirms the aggregate
 * cap holds AND that round-robin interleaving is real -- not just "some 50
 * items survive" but specifically "the top few items from every provider
 * survive," so no one provider's results get starved by another's.
 */

function stubContext(): RepositoryContext {
    return {
        workspaceRoot: '/fake',
        repoguideDataDir: '/fake/.repoguide',
        getConfig: (_key: string, defaultValue?: unknown) => defaultValue as any,
        asRelativePath: (p: string) => p,
        logger: {
            appendLine: () => undefined, debug: () => undefined, info: () => undefined,
            warn: () => undefined, error: () => undefined, stageStart: () => undefined,
            stageProgress: () => undefined, stageComplete: () => undefined, stageFailed: () => undefined,
            artifactWritten: () => undefined, queryLog: () => undefined, repairLog: () => undefined
        } as any,
        notifyInfo: () => undefined,
        notifyWarning: () => undefined,
        notifyError: () => undefined
    };
}

function makeDegenerateExecutionPlan(question: string): ExecutionPlan {
    return {
        planId: 'p1',
        requestId: 'r1',
        query: question,
        category: 'general' as any,
        intent: {} as any,
        complexity: { score: 0, reasons: [] } as any,
        strategy: {} as any,
        retrievalPlan: { strategy: 'hybrid', targetSymbols: [], targetFiles: [], targetConcepts: [], providerIds: [], excludedRoles: [], preferredEvidenceTypes: [], maxItems: 50, maxLatencyMs: 2500 },
        intelligencePlan: {} as any,
        evidenceRequirements: [],
        verificationPlan: {} as any,
        confidencePolicy: {} as any,
        freshnessPolicy: {} as any,
        failurePolicy: {} as any,
        diagnostics: [],
        metadata: { planner: 'regex' } as any,
        evidencePlan: {
            originalQuery: question, normalizedQuery: '', queryType: 'unknown',
            requiredEvidence: [], symbolHints: [], fileHints: [], phrases: [],
            factTypes: [], unitTypes: [], fileScope: 'both', retrievalStrategy: 'exact_match',
            mustExcludeRoles: [], diagnostics: [], confidence_mode: 'exact'
        } as any
    };
}

function makeItems(providerId: string, count: number): EvidenceItem[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `${providerId}_item_${i}`,
        file: `src/${providerId}_${i}.ts`,
        startLine: 1,
        endLine: 1,
        role: 'implementation',
        type: 'fact',
        content: 'placeholder',
        retrieval_signal: 'test_signal',
        semanticCategory: SemanticCategory.GENERAL,
        // Descending score within each provider's own list -- real providers
        // (e.g. FactStoreProvider) already return items in their own rank
        // order; interleaveAndCapEvidence must preserve that order, not
        // re-sort across providers.
        score: count - i,
        confidence: 0.8,
        extractionMethod: providerId
    }));
}

function canned150ItemResult(): RetrievalOrchestrationResult {
    const providerIds = ['fact_store', 'hybrid_retrieval', 'symbol_index', 'program_graph', 'flow_context'];
    const providerResults = providerIds.map(providerId => ({
        providerId,
        status: 'success' as const,
        items: makeItems(providerId, 30),
        diagnostics: [],
        metadata: { latencyMs: 1, sourceCount: 30 }
    }));
    return {
        planId: 'p1',
        items: providerResults.flatMap(r => r.items),
        providerResults,
        gaps: [],
        coverage: { required: 0, matched: 0 },
        diagnostics: [],
        metadata: { latencyMs: 1, providersInvoked: providerIds, providersSkipped: [], providersFailed: [] }
    };
}

function makeDispatcher(): QueryDispatcher {
    const stores = { unitStore: {} as any, factStore: {} as any, bm25Store: {} as any };
    const executionPlanner = { plan: async (request: { query: string }) => makeDegenerateExecutionPlan(request.query) } as any;
    const retrievalOrchestrator = { execute: async () => canned150ItemResult() } as any;
    return new QueryDispatcher(
        new ConversationHistory(),
        stores,
        stubContext(),
        { executionPlanner, retrievalOrchestrator, client: 'mcp' as any }
    );
}

test('retrieveRawEvidence: 5 providers x 30 items (150 total, unfiltered) truncates to exactly 50, reproducing and fixing the live 137-item bug', async () => {
    const dispatcher = makeDispatcher();
    const items = await dispatcher.retrieveRawEvidence('some query');
    assert.equal(items.length, 50);
});

test('retrieveRawEvidence: the cap is round-robin, not first-provider-wins -- every provider is represented in the capped result', async () => {
    const dispatcher = makeDispatcher();
    const items = await dispatcher.retrieveRawEvidence('some query');
    const byProvider = new Set(items.map(i => i.extractionMethod));
    assert.deepEqual(
        Array.from(byProvider).sort(),
        ['fact_store', 'flow_context', 'hybrid_retrieval', 'program_graph', 'symbol_index']
    );
    // 50 / 5 providers = 10 items each in a perfectly even round-robin.
    for (const providerId of byProvider) {
        const count = items.filter(i => i.extractionMethod === providerId).length;
        assert.equal(count, 10, `expected 10 items from ${providerId}, got ${count}`);
    }
});

test('retrieveRawEvidence: within each provider, its own highest-scored (first) items survive the cap -- interleaving preserves rank order, doesn\'t re-sort', async () => {
    const dispatcher = makeDispatcher();
    const items = await dispatcher.retrieveRawEvidence('some query');
    const factStoreItems = items.filter(i => i.extractionMethod === 'fact_store');
    // The 30 fact_store items were generated with descending scores (30, 29, ..., 1);
    // the surviving 10 must be exactly the top 10 (score 30 down to 21), in order.
    assert.deepEqual(factStoreItems.map(i => i.score), [30, 29, 28, 27, 26, 25, 24, 23, 22, 21]);
});
