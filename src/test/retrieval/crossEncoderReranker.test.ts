import test from 'node:test';
import * as assert from 'node:assert/strict';
import { CrossEncoderReranker, resolveRerankerBackend, sigmoid } from '../../retrieval/crossEncoderReranker';
import { EvidenceItem } from '../../query/evidencePacket';

/**
 * The reranker's job is to change WHICH evidence survives the context budget. The packer
 * sorts by `score + 0.75 * lexicalRelevance`, so these tests are mostly about failure
 * modes and score scale -- a correct ranking written at the wrong magnitude is a no-op,
 * which is exactly what the first working version did (top hit at 0.002 against
 * competitors at 0.9).
 */

function item(id: string, file: string, score: number): EvidenceItem {
    return {
        id, file, startLine: 1, endLine: 5, role: 'implementation' as never, type: 'function',
        content: `content of ${file}`, retrieval_signal: 'lance_store', score,
        confidence: 1, extractionMethod: 'tree_sitter' as never
    } as EvidenceItem;
}

test('unknown or absent configuration disables reranking rather than guessing', () => {
    assert.equal(resolveRerankerBackend(undefined), 'off');
    assert.equal(resolveRerankerBackend('off'), 'off');
    assert.equal(resolveRerankerBackend('nonsense'), 'off');
    assert.equal(resolveRerankerBackend('bge'), 'bge');
    assert.equal(resolveRerankerBackend('minilm'), 'minilm');
});

test('sigmoid maps cross-encoder logits onto the [0,1] scale the packer assumes', () => {
    assert.equal(sigmoid(0), 0.5);
    assert.ok(sigmoid(-10) < 0.001);
    assert.ok(sigmoid(10) > 0.999);
});

test('a failing model degrades to the existing order instead of costing an answer', async () => {
    const reranker = new CrossEncoderReranker('bge');
    // Force the failure path without touching the network.
    (reranker as unknown as { pipelinePromise: Promise<unknown> }).pipelinePromise =
        Promise.reject(new Error('offline'));
    const items = [item('a', 'x.py', 0.4), item('b', 'y.py', 0.9)];
    const outcome = await reranker.rerank('where is x', items);
    assert.equal(outcome.reranked, 0);
    assert.equal(items[0].score, 0.4, 'original scores must be left untouched');
    assert.equal(items[1].score, 0.9);
});

test('an empty packet is a no-op, not an error', async () => {
    const reranker = new CrossEncoderReranker('minilm');
    const outcome = await reranker.rerank('anything', []);
    assert.equal(outcome.reranked, 0);
});

test('once failed it stays failed, rather than retrying a broken model every query', async () => {
    const reranker = new CrossEncoderReranker('bge');
    (reranker as unknown as { pipelinePromise: Promise<unknown> }).pipelinePromise =
        Promise.reject(new Error('offline'));
    await reranker.rerank('q', [item('a', 'x.py', 0.5)]);
    const second = await reranker.rerank('q', [item('a', 'x.py', 0.5)]);
    assert.ok(second.durationMs < 50, 'second call must short-circuit');
});
