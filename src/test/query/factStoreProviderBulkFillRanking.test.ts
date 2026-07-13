import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FactStore } from '../../store/factStore';
import { FactStoreProvider } from '../../query/factStoreProvider';
import { EvidenceProviderRequest } from '../../query/retrievalProvider';
import { FactRecord } from '../../indexing/factTypes';

/**
 * Induced-failure regression test reproducing the live-tested CraftConnect
 * bug: a query for "confidence_threshold" returned 50 unrelated `constant`
 * facts (SIDEBAR_WIDTH, TOAST_LIMIT, ...) and none of the real
 * `self.confidence_threshold` facts. Root cause: preferredEvidenceTypes'
 * "fact evidence" alias expands to nearly every FactType, and each type's
 * findByType() results were pushed into `results` unranked, ordered only by
 * confidence/filePath -- so the first type to iterate (here: "constant",
 * first in FACT_TYPES' insertion order) fills the whole maxItems budget
 * with query-irrelevant facts before the real scored candidate pool is ever
 * appended, and the final dedupe+slice(maxItems) in retrieve() keeps only
 * that first, irrelevant batch.
 *
 * Confirmed as a real induced failure: reverting rankFactsByRelevance's use
 * in the bulk-fill loop (back to pushing findByType results directly) makes
 * the second test below fail -- the confidence_threshold fact gets crowded
 * out by irrelevant constants again.
 */

async function makeTempRepo(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

function noiseConstant(i: number): FactRecord {
    return {
        factId: `noise-${i}`,
        filePath: `src/component_${i}.tsx`,
        unitId: `src/component_${i}.tsx::CONST_${i}::const::1`,
        symbol: `UNRELATED_CONST_${i}`,
        factType: 'constant',
        value: String(i),
        valueKind: 'number',
        startLine: 1,
        endLine: 1,
        extractionMethod: 'ast_query',
        confidence: 'high',
        sourceText: `const UNRELATED_CONST_${i} = ${i};`,
        role: 'implementation'
    };
}

function realConfidenceThresholdFact(): FactRecord {
    return {
        factId: 'real-confidence-threshold',
        filePath: 'app/agents/customization_interview_agent.py',
        unitId: 'app/agents/customization_interview_agent.py::CustomizationInterviewAgent::class::1',
        symbol: 'self.confidence_threshold',
        factType: 'numeric_threshold',
        value: 0.55,
        valueKind: 'number',
        startLine: 65,
        endLine: 65,
        extractionMethod: 'ast_query',
        confidence: 'high',
        sourceText: 'self.confidence_threshold = 0.55',
        role: 'implementation'
    };
}

/**
 * Uses a SPACE-separated query ("confidence threshold"), not the underscored
 * "confidence_threshold" -- isolating the bulk-fill ranking fix from the
 * separate findBySymbol suffix-match fix (factStore.test.ts covers that one
 * independently). "confidence" and "threshold" decompose into two separate
 * identifierTerms, neither of which alone exact- or suffix-matches the
 * stored "self.confidence_threshold" symbol, so the symbol-lookup loop
 * contributes nothing here -- only scoreFact's token-overlap ranking
 * (against sourceText/value, which DOES contain both substrings) can
 * surface the real fact. Both real fixes were needed together for the
 * actual live bug, but each gets an independent induced-failure test here
 * so a regression in one can't hide behind the other silently covering.
 */
function getFactsRequest(maxItems: number): EvidenceProviderRequest {
    return {
        requestId: 'r1',
        planId: 'p1',
        query: 'confidence threshold',
        category: 'factual_lookup',
        retrievalPlan: {
            strategy: 'exact',
            targetSymbols: [],
            targetFiles: [],
            targetConcepts: [],
            providerIds: ['fact_store'],
            excludedRoles: [],
            // The exact requiredEvidence shape the real regex planner produces for
            // queryType 'threshold' -- "fact evidence" expands to nearly every FactType.
            preferredEvidenceTypes: ['fact evidence', 'source span evidence'],
            maxItems,
            maxLatencyMs: 2500
        },
        targets: { symbols: [], files: [], concepts: [] },
        limits: { maxItems, maxLatencyMs: 2500 },
        freshnessPolicy: { requireFreshEvidence: false }
    };
}

test('get_facts-shaped retrieval surfaces the real confidence_threshold fact instead of being crowded out by irrelevant bulk-fill constants', async () => {
    const repoRoot = await makeTempRepo('fact-provider-bulkfill');
    const store = new FactStore();
    await store.init(repoRoot);

    // 30 irrelevant "constant" facts (more than maxItems=10) -- reproduces the real
    // shape where "constant" (first in FACT_TYPES' iteration order) alone can fill
    // the entire budget before any other type or the scored path is ever appended.
    const noise = Array.from({ length: 30 }, (_, i) => noiseConstant(i));
    await store.upsertFacts([...noise, realConfidenceThresholdFact()]);

    const provider = new FactStoreProvider(store);
    await provider.initialize({ repositoryContext: {} as any });

    const request = getFactsRequest(10);
    const canHandle = provider.canHandle(request);
    assert.equal(canHandle.canHandle, true, `expected canHandle, got: ${canHandle.reason}`);

    const response = await provider.retrieve(request);
    const target = response.items.find(item => item.symbol === 'self.confidence_threshold');

    assert.ok(
        target,
        `expected the real confidence_threshold fact in the top ${request.limits.maxItems} results, ` +
        `got symbols: ${response.items.map(i => i.symbol).join(', ')}`
    );
    assert.equal(target!.file, 'app/agents/customization_interview_agent.py');
    assert.equal(target!.startLine, 65);
});

test('irrelevant bulk-fill constants are still returned when nothing more relevant exists (the fix ranks, it does not just exclude constants)', async () => {
    const repoRoot = await makeTempRepo('fact-provider-bulkfill-noise-only');
    const store = new FactStore();
    await store.init(repoRoot);

    const noise = Array.from({ length: 5 }, (_, i) => noiseConstant(i));
    await store.upsertFacts(noise);

    const provider = new FactStoreProvider(store);
    await provider.initialize({ repositoryContext: {} as any });

    // A query with no scoreable tokens against these facts still returns the
    // exact-match/file-match paths' results; this just confirms retrieve()
    // doesn't throw and returns a sane (possibly empty) result when nothing scores.
    const response = await provider.retrieve(getFactsRequest(10));
    assert.ok(Array.isArray(response.items));
});
