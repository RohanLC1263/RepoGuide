import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWithholding, renderWithheldAnswer } from '../../query/withheldAnswer';
import { EvidencePacket, EvidenceItem } from '../../query/evidencePacket';

/**
 * The defect: an ungrounded question landed in `block` (bald refusal) or `pass` (vague answer)
 * depending on whether the model happened to emit a verifiable artifact -- fabricate a code
 * fence and a checker catches it; hedge in prose and nothing checks it. Same condition,
 * opposite UX. These tests pin the deterministic replacement.
 */

function item(id: string): EvidenceItem {
    return {
        id, file: 'a.py', startLine: 1, endLine: 1, role: 'implementation',
        type: 'snippet', content: '', retrieval_signal: 'test', score: 1,
        confidence: 1, extractionMethod: 'heuristic'
    } as EvidenceItem;
}

function packetWith(itemCount: number): EvidencePacket {
    return {
        query: 'q',
        plan: { confidence_mode: 'grounded' } as EvidencePacket['plan'],
        items: Array.from({ length: itemCount }, (_, i) => item(`i${i}`)),
        facts: [],
        coverage: [],
        gaps: [],
        diagnostics: [],
        coverageScore: 0,
        matchedEvidenceTypes: []
    } as unknown as EvidencePacket;
}

const gate = { diagnostics: ['Numeric: 42'], unsupported_claims: ['Numeric: 42'] };

test('classify: no grounding is insufficient evidence, not a verification failure', () => {
    assert.equal(classifyWithholding(packetWith(0)), 'insufficient_evidence');
    assert.equal(classifyWithholding(packetWith(2)), 'insufficient_evidence');
});

test('classify: ample grounding means the block was a real verification catch', () => {
    assert.equal(classifyWithholding(packetWith(3)), 'verification_failed');
    assert.equal(classifyWithholding(packetWith(20)), 'verification_failed');
});

test('render: insufficient-evidence message is plain and never dumps checker diagnostics', () => {
    const msg = renderWithheldAnswer(packetWith(0), gate);
    assert.match(msg, /don't have enough evidence/);
    assert.match(msg, /no supporting evidence/);
    assert.doesNotMatch(msg, /Numeric: 42/, 'internal diagnostics must not leak to the user');
    assert.doesNotMatch(msg, /evidence pipeline/, 'no internal-component jargon');
});

test('render: insufficient-evidence message reports the real source count', () => {
    assert.match(renderWithheldAnswer(packetWith(1), gate), /only 1 source\b/);
    assert.match(renderWithheldAnswer(packetWith(2), gate), /only 2 sources\b/);
});

test('render: verification-failure says a specific reason instead of a raw list', () => {
    const msg = renderWithheldAnswer(packetWith(10), gate, 'this explanation');
    assert.match(msg, /found relevant code but could not verify this explanation/);
    assert.match(msg, /Specifically: Numeric: 42/);
});

test('render: verification-failure degrades cleanly with no diagnostics', () => {
    const msg = renderWithheldAnswer(packetWith(10), { diagnostics: [], unsupported_claims: [] });
    assert.match(msg, /could not verify the answer/);
    assert.doesNotMatch(msg, /Specifically:/);
});

test('render: a long diagnostic is truncated rather than dumped whole', () => {
    const long = 'x'.repeat(400);
    const msg = renderWithheldAnswer(packetWith(10), { diagnostics: [long], unsupported_claims: [] });
    assert.ok(msg.length < 400, 'message must not carry a 400-char diagnostic verbatim');
    assert.match(msg, /\.\.\.$/);
});

test('consistency: the ungrounded case reads the same regardless of WHY it was withheld', () => {
    // The defect was that a fabricating model and a hedging model produced different UX for
    // the identical underlying condition. With no grounding, the reason must not change the
    // message -- only the source count can differ.
    const fabricated = renderWithheldAnswer(packetWith(0), { diagnostics: ['likely fabricated code'], unsupported_claims: ['likely fabricated code'] });
    const hedged = renderWithheldAnswer(packetWith(0), { diagnostics: [], unsupported_claims: [] });
    assert.equal(fabricated, hedged);
});
