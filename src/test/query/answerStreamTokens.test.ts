import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
    classifyAnswerStreamToken,
    stripCitationMarkersToDisplayText
} from '../../query/answerStreamTokens';

// Defect #11 (2026-08-04). explainSelection now yields the same typed side-band
// gateStatus token the chat path yields, so its consumer -- the plain-text
// explain panel (src/ui/explainPanel.ts) -- must route control tokens OUT of the
// prose instead of concatenating them. These two helpers are the whole of that
// contract, and they live in a dependency-free module precisely so they can be
// exercised here: queryDispatcher.ts cannot be required in a plain Node process
// (it transitively loads the LanceDB native binding).

// --- classifyAnswerStreamToken: control tokens ---

test('classifyAnswerStreamToken: gateStatus token is control, with its payload intact', () => {
    const token = JSON.stringify({
        __type: 'gateStatus',
        status: { outcome: 'revise', unsupportedCount: 2, mode: 'grounded' }
    });
    const result = classifyAnswerStreamToken(token);
    assert.equal(result.kind, 'control');
    assert.equal(result.kind === 'control' && result.type, 'gateStatus');
    assert.deepEqual(
        result.kind === 'control' ? result.payload.status : undefined,
        { outcome: 'revise', unsupportedCount: 2, mode: 'grounded' }
    );
});

test('classifyAnswerStreamToken: other dispatcher control tokens are control too', () => {
    for (const type of ['answerMetadata', 'shadowContext', 'progressUpdate', 'healthCaveat']) {
        const result = classifyAnswerStreamToken(JSON.stringify({ __type: type, body: 1 }));
        assert.equal(result.kind, 'control', `${type} should classify as control`);
        assert.equal(result.kind === 'control' && result.type, type);
    }
});

test('classifyAnswerStreamToken: surrounding whitespace does not defeat detection', () => {
    const result = classifyAnswerStreamToken('\n  ' + JSON.stringify({ __type: 'gateStatus', status: {} }) + '\n');
    assert.equal(result.kind, 'control');
});

// --- classifyAnswerStreamToken: answer text (the side that must NOT be eaten) ---

test('classifyAnswerStreamToken: ordinary prose is text', () => {
    const prose = 'This function validates the payload and returns early on failure.';
    const result = classifyAnswerStreamToken(prose);
    assert.equal(result.kind, 'text');
    assert.equal(result.kind === 'text' && result.value, prose);
});

test('classifyAnswerStreamToken: prose containing braces is text, not control', () => {
    const prose = 'The handler returns { ok: true } when the guard passes.';
    assert.equal(classifyAnswerStreamToken(prose).kind, 'text');
});

test('classifyAnswerStreamToken: an answer that embeds a __type JSON example stays text', () => {
    // The dangerous false positive: an explanation that quotes the dispatcher's own
    // token format. It arrives inside a larger token, so it must not parse standalone.
    const prose = 'The dispatcher emits {"__type":"gateStatus"} before the answer text.';
    const result = classifyAnswerStreamToken(prose);
    assert.equal(result.kind, 'text');
    assert.equal(result.kind === 'text' && result.value, prose);
});

test('classifyAnswerStreamToken: malformed/truncated JSON is text, never silently dropped', () => {
    const truncated = '{"__type":"gateStatus","status":{"outcome":"pa';
    const result = classifyAnswerStreamToken(truncated);
    assert.equal(result.kind, 'text');
    assert.equal(result.kind === 'text' && result.value, truncated);
});

test('classifyAnswerStreamToken: JSON without a string __type is text', () => {
    assert.equal(classifyAnswerStreamToken('{"answer":"hello"}').kind, 'text');
    assert.equal(classifyAnswerStreamToken('{"__type":42}').kind, 'text');
});

test('classifyAnswerStreamToken: empty token is text', () => {
    const result = classifyAnswerStreamToken('');
    assert.equal(result.kind, 'text');
    assert.equal(result.kind === 'text' && result.value, '');
});

// --- stripCitationMarkersToDisplayText ---

test('stripCitationMarkersToDisplayText: replaces a marker with its display text', () => {
    const marked = 'See ___CITE___/repo/src/a.ts|10|20|[src/a.ts:10]___CITE_END___ for details.';
    assert.equal(
        stripCitationMarkersToDisplayText(marked),
        'See [src/a.ts:10] for details.'
    );
});

test('stripCitationMarkersToDisplayText: replaces every marker, not just the first', () => {
    const marked =
        '___CITE___/r/a.ts|1|2|[a.ts:1]___CITE_END___ and ___CITE___/r/b.ts|3|4|[b.ts:3]___CITE_END___';
    assert.equal(stripCitationMarkersToDisplayText(marked), '[a.ts:1] and [b.ts:3]');
});

test('stripCitationMarkersToDisplayText: text with no markers is returned unchanged', () => {
    const plain = 'No citations here at all.';
    assert.equal(stripCitationMarkersToDisplayText(plain), plain);
});

test('stripCitationMarkersToDisplayText: leaves an unresolved (ev-N) reference alone', () => {
    // finalizeApprovedAnswer only rewrites (ev-N) references it can resolve to a real
    // packet item; an unresolved one stays as-is and must survive this strip too.
    const text = 'This is claimed in (ev-7).';
    assert.equal(stripCitationMarkersToDisplayText(text), text);
});
