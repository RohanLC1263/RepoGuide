import test from 'node:test';
import * as assert from 'node:assert/strict';
import { confidenceFromGate } from '../../query/queryDispatcher';
import { EvidencePacket, EvidenceItem } from '../../query/evidencePacket';

/**
 * The Chat confidence badge must track what the gate VERIFIED, not how much
 * evidence was retrieved. Previously it was derived purely from retrieval volume
 * (`coverageScore` + avg score + item count), so on real CraftConnect questions the
 * same "Low" badge covered both a fully-correct answer and one containing
 * fabricated dependents -- and because `coverageScore` is 0 for most queries by
 * construction, essentially nothing could earn a higher badge regardless of
 * correctness.
 */

function item(over: Partial<EvidenceItem> = {}): EvidenceItem {
    return {
        id: 'i1', file: 'src/a.ts', startLine: 1, endLine: 2, role: 'implementation' as any,
        type: 'function', content: 'code', retrieval_signal: 'lance_store', score: 0.9,
        confidence: 0.9, extractionMethod: 'tree_sitter' as any, ...over
    };
}

function packet(itemCount: number, coverageScore = 0): EvidencePacket {
    return {
        query: 'q', plan: {} as any,
        items: Array.from({ length: itemCount }, (_, i) => item({ id: 'i' + i })),
        facts: [], coverage: [], gaps: [], diagnostics: [],
        coverageScore, matchedEvidenceTypes: []
    };
}

test('a blocked gate is always low confidence, however much evidence was retrieved', () => {
    const r = confidenceFromGate(packet(50, 1), { outcome: 'block', unsupported_claims: ['fabricated code'] }, 'x');
    assert.equal(r.level, 'low');
});

test('a revised answer (delivered with a caveat) caps at medium', () => {
    const r = confidenceFromGate(packet(50, 1), { outcome: 'revise', unsupported_claims: [] }, 'x');
    assert.equal(r.level, 'medium');
});

test('a clean pass with unsupported claims recorded still caps at medium', () => {
    const r = confidenceFromGate(packet(50, 1), { outcome: 'pass', unsupported_claims: ['some claim'] }, 'x');
    assert.equal(r.level, 'medium');
});

test('a clean pass with real grounding earns high EVEN WHEN coverageScore is 0 (the Q4 regression)', () => {
    // The accurate, correctly-cited "where is execute_mission implemented" answer
    // was labelled Low purely because coverageScore was 0 -- which it is for most
    // queries by construction. Verification status, not that metric, decides now.
    const r = confidenceFromGate(packet(10, 0), { outcome: 'pass', unsupported_claims: [] }, 'x');
    assert.equal(r.level, 'high');
});

test('a clean pass on thin evidence stays medium, not high', () => {
    const r = confidenceFromGate(packet(2, 0), { outcome: 'pass', unsupported_claims: [] }, 'x');
    assert.equal(r.level, 'medium');
});

test('non-level fields (topFiles, chunkCount, explanation) are preserved from the evidence computation', () => {
    const r = confidenceFromGate(packet(4, 0), { outcome: 'pass', unsupported_claims: [] }, 'my explanation');
    assert.equal(r.chunkCount, 4);
    assert.equal(r.explanation, 'my explanation');
});
