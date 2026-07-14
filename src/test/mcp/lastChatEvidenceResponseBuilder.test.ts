import test from 'node:test';
import * as assert from 'node:assert/strict';
import { buildLastChatEvidenceResponse, parseLimitArgument } from '../../mcp/lastChatEvidenceResponseBuilder';
import { buildEntry, QueryEvidenceEntry, QueryEvidenceReference, QUERY_EVIDENCE_MAX_REFERENCES_PER_KIND } from '../../query/queryEvidenceExporter';
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

// --- reference capping applied at the response layer -- live-tested bug:
// get_last_chat_evidence overflowed to 220,020 chars from 2 stored entries
// (461/502 references each). buildEntry now caps at write time, but entries
// written BEFORE that fix are already on disk uncapped, and
// exportQueryEvidence's rolling file only gets rewritten on the next chat/MCP
// answer -- so the response layer must cap independently, or a call made
// right after this fix ships would still return the same oversized data. ---

function manyRefs(count: number, kind: 'item' | 'fact', filePrefix: string): QueryEvidenceReference[] {
    return Array.from({ length: count }, (_, i) => ({ file: `${filePrefix}_${i}.ts`, startLine: 1, endLine: 1, symbol: `sym_${i}`, type: 'function', kind }));
}

/** Simulates an entry written to disk BEFORE the write-side cap existed --
 * built directly, bypassing buildEntry, exactly as a pre-fix on-disk entry
 * would already be shaped. */
function legacyOversizedEntry(question: string): QueryEvidenceEntry {
    return { ...entryFor(question), references: [...manyRefs(128, 'item', 'i'), ...manyRefs(374, 'fact', 'f')] };
}

test('buildLastChatEvidenceResponse caps references per kind on entries that predate the write-side fix, without needing a new write', () => {
    const response = buildLastChatEvidenceResponse([legacyOversizedEntry('q')], undefined, null);
    const refs = response.entries[0].references;
    const items = refs.filter(r => r.kind === 'item');
    const facts = refs.filter(r => r.kind === 'fact');
    assert.equal(items.length, QUERY_EVIDENCE_MAX_REFERENCES_PER_KIND);
    assert.equal(facts.length, QUERY_EVIDENCE_MAX_REFERENCES_PER_KIND, 'facts must still be represented, not zeroed out by items alone exceeding a flat cap');
});

test('response-layer cap applies to every returned entry independently, not just the first', () => {
    const response = buildLastChatEvidenceResponse([legacyOversizedEntry('a'), legacyOversizedEntry('b')], undefined, null);
    for (const entry of response.entries) {
        assert.equal(entry.references.length, QUERY_EVIDENCE_MAX_REFERENCES_PER_KIND * 2);
    }
});

test('response-layer cap is idempotent on already-capped (post-fix) entries -- a real small entry is untouched', () => {
    const response = buildLastChatEvidenceResponse(FIVE_ENTRIES, undefined, null);
    for (const entry of response.entries) {
        assert.deepEqual(entry.references, []); // FIVE_ENTRIES built via buildEntry with an empty packet
    }
});

test('capping references does not touch the answer field', () => {
    const withBigAnswer: QueryEvidenceEntry = { ...legacyOversizedEntry('q'), answer: 'a real synthesized answer, unrelated to reference count' };
    const response = buildLastChatEvidenceResponse([withBigAnswer], undefined, null);
    assert.equal(response.entries[0].answer, 'a real synthesized answer, unrelated to reference count');
});
