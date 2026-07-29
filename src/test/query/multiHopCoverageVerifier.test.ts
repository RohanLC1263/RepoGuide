import test from 'node:test';
import * as assert from 'node:assert/strict';
import { findOmittedFiles, isMultiHopQuestion } from '../../query/multiHopCoverageVerifier';
import { EvidencePacket } from '../../query/evidencePacket';

/**
 * adv-mh-1: a five-hop trace question where `mission_service` was genuinely retrieved --
 * five mentions in the packet -- and simply never appeared in the answer. An earlier
 * round misdiagnosed this as prompt truncation and built a packing cap for it; an A/B
 * showed the file was already reaching the prompt, and the cap was reverted. The model
 * omits a file it was handed, so the omission is detected afterwards.
 */

function packet(files: string[]): EvidencePacket {
    return {
        query: 'q', plan: { confidence_mode: 'grounded', requiredEvidence: [] } as never,
        items: files.map((f, i) => ({
            id: `i${i}`, file: f, startLine: 1, endLine: 5, role: 'implementation' as never,
            type: 'function', content: 'x', retrieval_signal: 'lance_store', score: 1,
            confidence: 1, extractionMethod: 'tree_sitter' as never
        })),
        facts: [], coverage: [], gaps: [], diagnostics: [], coverageScore: 0, matchedEvidenceTypes: []
    };
}

const repeated = (file: string, n: number) => Array.from({ length: n }, () => file);
const TRACE_Q = 'Walk me through what happens end to end when someone submits an answer.';

test('recognises trace-shaped questions and ignores ordinary ones', () => {
    for (const q of [
        TRACE_Q,
        'How does a mission get from draft to sealed?',
        'Trace the request through the auth layer.',
        'Give me the full lifecycle of an upload.'
    ]) {
        assert.ok(isMultiHopQuestion(q), q);
    }
    for (const q of [
        'Where is get_current_user defined?',
        'What is the confidence threshold in the interview agent?',
        'What does ImageQualityAgent check?'
    ]) {
        assert.ok(!isMultiHopQuestion(q), q);
    }
});

test('flags a well-evidenced file the trace never mentions (the adv-mh-1 shape)', () => {
    const omitted = findOmittedFiles(
        TRACE_Q,
        packet([...repeated('app/services/mission_service.py', 5), 'app/routers/interview.py']),
        'The request reaches app/routers/interview.py and is validated there.'
    );
    assert.equal(omitted.length, 1);
    assert.equal(omitted[0].file, 'app/services/mission_service.py');
    assert.equal(omitted[0].mentions, 5);
});

test('a file the answer DOES name is not an omission, however it is spelled', () => {
    for (const answer of [
        'Control passes to app/services/mission_service.py which executes the mission.',
        'Control passes to mission_service.py which executes the mission.',
        'Control passes to the mission_service module which executes the mission.'
    ]) {
        assert.deepEqual(
            findOmittedFiles(TRACE_Q, packet(repeated('app/services/mission_service.py', 5)), answer),
            [],
            answer
        );
    }
});

test('long-tail evidence is not an omission -- only emphatic files count', () => {
    const omitted = findOmittedFiles(
        TRACE_Q,
        packet(['app/helpers/tts_helper.py', 'app/helpers/tts_helper.py', 'app/core/ratelimit.py']),
        'The request is handled by the router.'
    );
    assert.deepEqual(omitted, [], 'two or three mentions is context, not an insistence');
});

test('never fires on a narrow question, however much evidence piles up', () => {
    assert.deepEqual(
        findOmittedFiles(
            'Where is get_current_user defined?',
            packet(repeated('app/services/mission_service.py', 20)),
            'It is defined in app/core/auth.py.'
        ),
        []
    );
});

test('reports the most-evidenced omissions first and caps the list', () => {
    const files = [
        ...repeated('a.py', 9), ...repeated('b.py', 7),
        ...repeated('c.py', 6), ...repeated('d.py', 5)
    ];
    const omitted = findOmittedFiles(TRACE_Q, packet(files), 'Nothing relevant is named here.');
    assert.equal(omitted.length, 3, 'caveat must stay readable');
    assert.deepEqual(omitted.map(o => o.file), ['a.py', 'b.py', 'c.py']);
});

test('windows separators in the packet do not create phantom omissions', () => {
    assert.deepEqual(
        findOmittedFiles(
            TRACE_Q,
            packet(repeated('app\\services\\mission_service.py', 5)),
            'It goes through mission_service.py next.'
        ),
        []
    );
});
