import test from 'node:test';
import * as assert from 'node:assert/strict';
import { buildLastChatEvidenceResponse, parseLimitArgument } from '../../mcp/lastChatEvidenceResponseBuilder';
import { buildEntry, QueryEvidenceEntry } from '../../query/queryEvidenceExporter';
import { EvidencePlan } from '../../query/evidencePlanTypes';
import { EvidencePacket } from '../../query/evidencePacket';
import { GateResult } from '../../query/answerGate';

function makePlan(): EvidencePlan {
    return {
        originalQuery: 'q', normalizedQuery: 'q', queryType: 'behavior_explanation',
        requiredEvidence: [], symbolHints: [], fileHints: [], factTypes: [], unitTypes: [],
        fileScope: 'both', retrievalStrategy: 'exact_match', mustExcludeRoles: [], diagnostics: [],
        confidence_mode: 'exact'
    };
}
function makePacket(): EvidencePacket {
    return { query: 'q', plan: makePlan(), items: [], facts: [], coverage: [], gaps: [], diagnostics: [], coverageScore: 0, matchedEvidenceTypes: [] };
}
function makeGateResult(): GateResult {
    return { outcome: 'pass', supported_claims: [], unsupported_claims: [], removed_or_rewritten_claims: [], required_gaps: [], finalAnswer: '', diagnostics: [] };
}
function entryFor(question: string): QueryEvidenceEntry {
    return buildEntry(question, `answer to ${question}`, makePacket(), makeGateResult(), 'vscode', false);
}

const FIVE_ENTRIES = ['e5', 'e4', 'e3', 'e2', 'e1'].map(entryFor); // pretend newest-first

// --- parseLimitArgument ---

test('parseLimitArgument: a valid positive number is floored and returned', () => {
    assert.equal(parseLimitArgument(3), 3);
    assert.equal(parseLimitArgument(3.9), 3);
});

test('parseLimitArgument: missing/undefined/null argument means no limit', () => {
    assert.equal(parseLimitArgument(undefined), undefined);
    assert.equal(parseLimitArgument(null), undefined);
});

test('parseLimitArgument: zero, negative, NaN, Infinity, and non-numeric arguments all mean no limit, never throw', () => {
    assert.equal(parseLimitArgument(0), undefined);
    assert.equal(parseLimitArgument(-5), undefined);
    assert.equal(parseLimitArgument(NaN), undefined);
    assert.equal(parseLimitArgument(Infinity), undefined);
    assert.equal(parseLimitArgument('3'), undefined);
    assert.equal(parseLimitArgument({}), undefined);
});

// --- buildLastChatEvidenceResponse ---

test('no limit argument returns every entry as-is, in the order given', () => {
    const response = buildLastChatEvidenceResponse(FIVE_ENTRIES, undefined, null);
    assert.equal(response.entries.length, 5);
    assert.deepEqual(response.entries.map(e => e.question), ['e5', 'e4', 'e3', 'e2', 'e1']);
});

test('a limit smaller than the entry count returns exactly that many, from the front (newest-first order preserved)', () => {
    const response = buildLastChatEvidenceResponse(FIVE_ENTRIES, 2, null);
    assert.deepEqual(response.entries.map(e => e.question), ['e5', 'e4']);
});

test('a limit larger than the entry count returns all of them, not an error', () => {
    const response = buildLastChatEvidenceResponse(FIVE_ENTRIES, 100, null);
    assert.equal(response.entries.length, 5);
});

test('an empty entries array with any limit returns an empty array, not an error', () => {
    const response = buildLastChatEvidenceResponse([], 5, null);
    assert.deepEqual(response.entries, []);
});

test('index_age is passed through unchanged, including when null (never indexed)', () => {
    const withAge = buildLastChatEvidenceResponse(FIVE_ENTRIES, undefined, { lastIndexedAt: '2026-01-01T00:00:00.000Z', ageSeconds: 42 });
    assert.deepEqual(withAge.index_age, { lastIndexedAt: '2026-01-01T00:00:00.000Z', ageSeconds: 42 });

    const withoutAge = buildLastChatEvidenceResponse(FIVE_ENTRIES, undefined, null);
    assert.equal(withoutAge.index_age, null);
});
