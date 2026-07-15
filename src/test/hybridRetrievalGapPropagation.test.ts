import test from 'node:test';
import * as assert from 'node:assert/strict';
import { HybridRetrievalProvider } from '../query/hybridRetrievalProvider';
import { RetrievalOrchestrator } from '../query/retrievalOrchestrator';
import { HybridContextAssembly, computeDegradedChannels, isLanceCorruptionError } from '../query/hybridRetrievalFusion';
import { EvidenceProviderRequest } from '../query/retrievalProvider';

test('isLanceCorruptionError matches the real confirmed error shape', () => {
    assert.ok(isLanceCorruptionError(
        'LanceError(IO): External error: Not found: /path/to/workspace/.repoguide/chunks.lance/data/fb93e0bd-a3fd-4908-9b29-e2f2688ae460.lance.'
    ));
});

test('isLanceCorruptionError does not match unrelated errors', () => {
    assert.equal(isLanceCorruptionError('ECONNREFUSED'), false);
    assert.equal(isLanceCorruptionError('Ollama request timed out'), false);
    // A Lance error that isn't the specific "missing fragment" shape shouldn't
    // be treated as corruption -- only the "not found" IO variant.
    assert.equal(isLanceCorruptionError('LanceError(Runtime): out of memory'), false);
});

test('computeDegradedChannels marks isCorruption correctly per channel', () => {
    const result = computeDegradedChannels(
        [
            { channel: 'vector', error: 'LanceError(IO): External error: Not found: .../abc.lance' },
            { channel: 'pagerank', error: 'ENOENT: pagerank_graph.json missing' }
        ],
        { bm25Weight: 0.2, vectorWeight: 0.6, pagerankWeight: 0.4 }
    );
    const vectorResult = result.find(r => r.channel === 'vector');
    const pagerankResult = result.find(r => r.channel === 'pagerank');
    assert.equal(vectorResult?.isCorruption, true);
    assert.equal(pagerankResult?.isCorruption, false);
});

test('computeDegradedChannels surfaces a channel error weighted at or above the threshold', () => {
    const result = computeDegradedChannels(
        [{ channel: 'vector', error: 'LanceError(IO): Not found' }],
        { bm25Weight: 0.2, vectorWeight: 0.6, pagerankWeight: 0.4 }
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].channel, 'vector');
    assert.equal(result[0].weight, 0.6);
});

test('computeDegradedChannels drops a channel error weighted below the threshold', () => {
    // bm25Weight: 0.2 in the default architecture_analysis config -- BM25 wasn't
    // expected to contribute meaningfully, so its failure shouldn't surface as a gap.
    const result = computeDegradedChannels(
        [{ channel: 'bm25', error: 'some transient error' }],
        { bm25Weight: 0.2, vectorWeight: 0.6, pagerankWeight: 0.4 }
    );
    assert.equal(result.length, 0);
});

test('computeDegradedChannels handles multiple simultaneous channel errors independently', () => {
    const result = computeDegradedChannels(
        [
            { channel: 'vector', error: 'vector boom' },
            { channel: 'bm25', error: 'bm25 boom' },
            { channel: 'pagerank', error: 'pagerank boom' }
        ],
        { bm25Weight: 0.7, vectorWeight: 0.3, pagerankWeight: 0.4 } // symbol_lookup-style config
    );
    // bm25 (0.7) and pagerank (0.4) clear the threshold; vector (0.3) doesn't.
    const channels = result.map(r => r.channel).sort();
    assert.deepEqual(channels, ['bm25', 'pagerank']);
});

function baseAssembly(overrides: Partial<HybridContextAssembly> = {}): HybridContextAssembly {
    return {
        chunks: [],
        annotations: [],
        communities: [],
        degradedChannels: [],
        ...overrides
    };
}

function baseRequest(overrides: Partial<EvidenceProviderRequest> = {}): EvidenceProviderRequest {
    return {
        requestId: 'r1',
        planId: 'p1',
        query: 'test query',
        category: 'architectural_reasoning' as any,
        retrievalPlan: { providerIds: ['hybrid_retrieval'] } as any,
        targets: { symbols: [], files: [], concepts: [] },
        limits: { maxItems: 10, maxLatencyMs: 5000 },
        freshnessPolicy: 'any' as any,
        ...overrides
    };
}

test('HybridRetrievalProvider reports success (not partial) when no channel degraded', async () => {
    const fusion = {
        retrieveContext: async () => baseAssembly({
            chunks: [{ chunk: { id: 'c1', filePath: 'a.ts', language: 'ts', startLine: 1, endLine: 5, text: 'x', vector: [], hash: '' }, score: 1, rank: 1 }]
        })
    };
    const provider = new HybridRetrievalProvider(fusion as any, { emitEvidenceItems: true });
    const result = await provider.retrieve(baseRequest());
    assert.equal(result.status, 'success');
    assert.deepEqual(result.gaps, []);
});

test('HybridRetrievalProvider reports partial and a gap when a meaningfully-weighted channel degraded', async () => {
    const fusion = {
        retrieveContext: async () => baseAssembly({
            chunks: [{ chunk: { id: 'c1', filePath: 'a.ts', language: 'ts', startLine: 1, endLine: 5, text: 'x', vector: [], hash: '' }, score: 1, rank: 1 }],
            degradedChannels: [{ channel: 'vector', weight: 0.6, error: 'LanceError(IO): External error: Not found: .../abc.lance', isCorruption: true }]
        })
    };
    const provider = new HybridRetrievalProvider(fusion as any, { emitEvidenceItems: true });
    const result = await provider.retrieve(baseRequest());

    // Still has results from other channels, so not 'empty' -- but must not be an
    // unqualified 'success' either, since the vector channel (weight 0.6) errored.
    assert.equal(result.status, 'partial');
    assert.equal(result.gaps?.length, 1);
    assert.match(result.gaps![0].message, /appears corrupted/);
    assert.match(result.gaps![0].message, /Re-sync Index/);
    assert.ok(result.diagnostics.some(d => d.level === 'warn' && /vector retrieval failed/.test(d.message)));
});

test('HybridRetrievalProvider gives a plain (non-corruption) gap message for a non-Lance-shaped failure', async () => {
    const fusion = {
        retrieveContext: async () => baseAssembly({
            chunks: [{ chunk: { id: 'c1', filePath: 'a.ts', language: 'ts', startLine: 1, endLine: 5, text: 'x', vector: [], hash: '' }, score: 1, rank: 1 }],
            degradedChannels: [{ channel: 'vector', weight: 0.6, error: 'ECONNREFUSED', isCorruption: false }]
        })
    };
    const provider = new HybridRetrievalProvider(fusion as any, { emitEvidenceItems: true });
    const result = await provider.retrieve(baseRequest());
    assert.equal(result.gaps?.length, 1);
    assert.match(result.gaps![0].message, /vector retrieval was unavailable/);
    assert.doesNotMatch(result.gaps![0].message, /Re-sync Index/);
});

test('HybridRetrievalProvider reports empty (not partial) when literally nothing came back, even with a degraded channel', async () => {
    const fusion = {
        retrieveContext: async () => baseAssembly({
            degradedChannels: [{ channel: 'vector', weight: 0.6, error: 'boom', isCorruption: false }]
        })
    };
    const provider = new HybridRetrievalProvider(fusion as any, { emitEvidenceItems: true });
    const result = await provider.retrieve(baseRequest());
    assert.equal(result.status, 'empty');
});

test('RetrievalOrchestrator aggregates gaps from provider responses into its own gaps array', async () => {
    const fusion = {
        retrieveContext: async () => baseAssembly({
            chunks: [{ chunk: { id: 'c1', filePath: 'a.ts', language: 'ts', startLine: 1, endLine: 5, text: 'x', vector: [], hash: '' }, score: 1, rank: 1 }],
            degradedChannels: [{ channel: 'vector', weight: 0.6, error: 'boom', isCorruption: false }]
        })
    };
    const provider = new HybridRetrievalProvider(fusion as any, { emitEvidenceItems: true });
    const orchestrator = new RetrievalOrchestrator([provider]);

    const plan = {
        requestId: 'r1',
        planId: 'p1',
        query: 'test query',
        category: 'architectural_reasoning',
        retrievalPlan: { providerIds: ['hybrid_retrieval'] },
        evidenceRequirements: [],
        freshnessPolicy: 'any'
    } as any;

    const result = await orchestrator.execute(plan);
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0].type, 'degraded_channel');
    // A degraded (not fully failed) provider should NOT be recorded in providersFailed --
    // that's reserved for a genuine crash/timeout, per the existing status contract.
    assert.equal(result.metadata.providersFailed.length, 0);
});
