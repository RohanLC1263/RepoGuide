import test from 'node:test';
import * as assert from 'node:assert/strict';
import { interleaveAndCapEvidence } from '../../query/retrievalOrchestrator';
import { EvidenceItem, SemanticCategory } from '../../query/evidencePacket';
import { EvidenceProviderResponse } from '../../query/retrievalProvider';

function item(id: string, score: number): EvidenceItem {
    return {
        id, file: `src/${id}.ts`, startLine: 1, endLine: 1, role: 'implementation',
        type: 'fact', content: 'placeholder', retrieval_signal: 'test_signal',
        semanticCategory: SemanticCategory.GENERAL, score, confidence: 0.8, extractionMethod: 'test'
    };
}

function response(providerId: string, items: EvidenceItem[]): EvidenceProviderResponse {
    return { providerId, status: 'success', items, diagnostics: [], metadata: { latencyMs: 1, sourceCount: items.length } };
}

test('uneven provider sizes: an exhausted provider stops contributing but does not block the others from filling remaining cap', () => {
    const results = [
        response('small', [item('s1', 1)]),
        response('big', [item('b1', 5), item('b2', 4), item('b3', 3), item('b4', 2)])
    ];
    const out = interleaveAndCapEvidence(results, 10);
    // Both items exist; 'small' contributes its one item, 'big' fills the rest.
    assert.equal(out.length, 5);
    assert.deepEqual(out.map(i => i.id).sort(), ['b1', 'b2', 'b3', 'b4', 's1']);
});

test('a duplicate id across two providers is kept only once, on its first occurrence in interleave order', () => {
    const shared = item('shared', 9);
    const results = [
        response('p1', [shared, item('p1_only', 1)]),
        response('p2', [item('shared', 9), item('p2_only', 1)])
    ];
    const out = interleaveAndCapEvidence(results, 10);
    const ids = out.map(i => i.id);
    assert.equal(ids.filter(id => id === 'shared').length, 1, 'shared id must appear exactly once');
    assert.ok(ids.includes('p1_only'));
    assert.ok(ids.includes('p2_only'));
});

test('a duplicate id does not stall the OTHER provider\'s turn -- the cursor still advances past it', () => {
    // p1's second item duplicates p2's first (already-seen) item; p1's third
    // item must still be reachable within a small cap, proving the skip
    // doesn't retry the same slot forever.
    const results = [
        response('p1', [item('a', 3), item('dup', 2), item('c', 1)]),
        response('p2', [item('dup', 9)])
    ];
    const out = interleaveAndCapEvidence(results, 3);
    assert.deepEqual(out.map(i => i.id), ['a', 'dup', 'c']);
});

test('cap of 0 returns an empty array without throwing', () => {
    const results = [response('p1', [item('a', 1)])];
    assert.deepEqual(interleaveAndCapEvidence(results, 0), []);
});

test('no providers at all returns an empty array without throwing', () => {
    assert.deepEqual(interleaveAndCapEvidence([], 50), []);
});

test('a provider with zero items is simply skipped, not an error', () => {
    const results = [
        response('empty', []),
        response('has_items', [item('a', 1), item('b', 2)])
    ];
    const out = interleaveAndCapEvidence(results, 50);
    assert.deepEqual(out.map(i => i.id), ['a', 'b']);
});

test('fewer total items than the cap returns all of them, not padded or truncated short', () => {
    const results = [response('p1', [item('a', 1), item('b', 2)])];
    const out = interleaveAndCapEvidence(results, 50);
    assert.equal(out.length, 2);
});
