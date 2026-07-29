import test from 'node:test';
import * as assert from 'node:assert/strict';
import { detectAbstention, findRetrievalGap, questionSearchTerms } from '../../query/abstentionVerifier';
import { EvidencePacket } from '../../query/evidencePacket';

/**
 * The motivating case: "Where's the STT confidence averaging logic actually
 * implemented?" answered with "not explicitly mentioned in the provided evidence", while
 * the logic sits at app/services/stt_service.py:181. That answer passed the gate, because
 * an abstention contains nothing fabricated to catch -- a retrieval miss rendered as
 * calibrated honesty.
 */

function packetWith(files: Array<[string, number, number]>): EvidencePacket {
    return {
        query: 'q', plan: { confidence_mode: 'grounded', requiredEvidence: [] } as never,
        items: files.map(([f, startLine, endLine], i) => ({
            id: `i${i}`, file: f, startLine, endLine, role: 'implementation' as never,
            type: 'function', content: 'x', retrieval_signal: 'lance_store', score: 1,
            confidence: 1, extractionMethod: 'tree_sitter' as never
        })),
        facts: [], coverage: [], gaps: [], diagnostics: [], coverageScore: 0, matchedEvidenceTypes: []
    };
}

/** Index double. Hits carry line ranges, because the check compares regions, not files. */
const lookupFinding = (hits: Array<[string, number?, number?]>) => ({
    search: async () => hits.map(([filePath, startLine, endLine]) => ({ filePath, startLine, endLine }))
});

test('detects the measured abstention wording', () => {
    const found = detectAbstention(
        'The STT confidence averaging logic is not explicitly mentioned in the provided evidence. You may need to search the codebase.'
    );
    assert.ok(found, 'must recognise the shape that shipped the STT miss');
    assert.match(found.sentence, /not explicitly mentioned/);
});

test('detects the other common hedges', () => {
    for (const answer of [
        'The evidence does not determine which module owns this.',
        'There is no direct evidence of a retry mechanism here.',
        'The exact threshold cannot be determined from the retrieved code.'
    ]) {
        assert.ok(detectAbstention(answer), answer);
    }
});

test('a confident answer is not treated as an abstention', () => {
    assert.equal(
        detectAbstention('The threshold is 0.55, defined in customization_interview_agent.py.'),
        null
    );
});

test('flags a gap when the index knows a file the packet never contained', async () => {
    const gap = await findRetrievalGap(
        "Where's the STT confidence averaging logic actually implemented?",
        packetWith([['app/agents/conversation_agent.py', 1, 50]]),
        lookupFinding([['app/services/stt_service.py', 170, 190]])
    );
    assert.ok(gap);
    assert.deepEqual(gap.candidateLocations, ['app/services/stt_service.py:170-190']);
});

test('does NOT flag when the packet already covered that region', async () => {
    const gap = await findRetrievalGap(
        'where is the thing',
        packetWith([['app/services/stt_service.py', 160, 200]]),
        lookupFinding([['app/services/stt_service.py', 170, 190]])
    );
    assert.equal(gap, null, 'the model saw this code and still abstained -- not a retrieval gap');
});

test('DOES flag a different region of a file the packet already had (the measured STT case)', async () => {
    // The failing run cited stt_service.py:229 while the averaging it claimed not to find
    // is at line 181. A file-level check called that "already retrieved" and pointed the
    // user at three unrelated files instead.
    const gap = await findRetrievalGap(
        "Where's the STT confidence averaging logic actually implemented?",
        packetWith([['app/services/stt_service.py', 229, 229]]),
        lookupFinding([['app/services/stt_service.py', 175, 190]])
    );
    assert.ok(gap, 'same file, different region, is still a retrieval gap');
    assert.deepEqual(gap.candidateLocations, ['app/services/stt_service.py:175-190']);
});

test('path separators do not create phantom gaps', async () => {
    const gap = await findRetrievalGap(
        'where is the thing',
        packetWith([['app\\services\\stt_service.py', 1, 500]]),
        lookupFinding([['app/services/stt_service.py', 100, 120]])
    );
    assert.equal(gap, null);
});

test('no lookup, or a failing one, leaves the abstention alone', async () => {
    assert.equal(await findRetrievalGap('where is x', packetWith([]), undefined), null);
    const broken = { search: async () => { throw new Error('index down'); } };
    assert.equal(await findRetrievalGap('where is x', packetWith([]), broken), null);
});

test('an index that finds nothing confirms the abstention', async () => {
    assert.equal(await findRetrievalGap('where is x', packetWith([]), lookupFinding([])), null);
});

test('candidate list is capped so the caveat stays readable', async () => {
    const many: Array<[string, number?, number?]> = Array.from({ length: 10 }, (_, i) => [`app/f${i}.py`, 1, 9]);
    const gap = await findRetrievalGap('where is the confidence averaging', packetWith([]), lookupFinding(many));
    assert.ok(gap);
    assert.equal(gap.candidateLocations.length, 3);
});

test('question terms drop stopwords but keep the distinctive ones', () => {
    const terms = questionSearchTerms("Where's the STT confidence averaging logic actually implemented?");
    assert.ok(terms.includes('stt'));
    assert.ok(terms.includes('confidence'));
    assert.ok(terms.includes('averaging'));
    assert.ok(!terms.includes('actually'), 'filler must not dilute the search');
    assert.ok(!terms.includes('logic'));
});
