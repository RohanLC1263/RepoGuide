import test from 'node:test';
import * as assert from 'node:assert/strict';
import { SubAnswerMerger, SubTaskResult } from '../../query/subAnswerMerger';
import { AnswerGate, AnswerGatePolicy, THIN_GROUNDING_MIN_SOURCES } from '../../query/answerGate';
import { EvidencePacket, EvidenceItem } from '../../query/evidencePacket';
import { EvidencePlan } from '../../query/evidencePlanTypes';
import { decompositionEligible, DECOMPOSITION_MIN_COMPLEXITY_SCORE } from '../../query/queryDispatcher';
import { validateSubQuestions } from '../../query/planning/llmEvidencePlanner';

const POLICY: AnswerGatePolicy = { checkNumericClaims: true, checkQuotedStrings: true, checkFilePaths: true };

function plan(query: string): EvidencePlan {
    return {
        originalQuery: query,
        normalizedQuery: query,
        queryType: 'architecture_analysis',
        requiredEvidence: [],
        symbolHints: [],
        fileHints: [],
        factTypes: [],
        unitTypes: [],
        fileScope: 'both',
        retrievalStrategy: 'hybrid',
        mustExcludeRoles: [],
        diagnostics: [],
        confidence_mode: 'exact'
    };
}

let nextId = 0;
function item(overrides: Partial<EvidenceItem>): EvidenceItem {
    return {
        id: `item-${nextId++}`,
        file: 'src/a.py',
        startLine: 1,
        endLine: 5,
        role: 'implementation',
        type: 'snippet',
        content: 'def a(): pass',
        retrieval_signal: 'bm25',
        score: 1,
        confidence: 1,
        extractionMethod: 'heuristic',
        ...overrides
    };
}

function packet(query: string, items: EvidenceItem[]): EvidencePacket {
    return {
        query,
        plan: plan(query),
        items,
        facts: [],
        coverage: [],
        gaps: [],
        diagnostics: [],
        coverageScore: 1,
        matchedEvidenceTypes: []
    };
}

function passedSub(question: string, answer: string, items: EvidenceItem[]): SubTaskResult {
    return {
        question,
        answer,
        packet: packet(question, items),
        gate: { outcome: 'pass', supported_claims: [], unsupported_claims: [], removed_or_rewritten_claims: [], required_gaps: [], finalAnswer: answer, diagnostics: [] }
    };
}

function blockedSub(question: string): SubTaskResult {
    return {
        question,
        answer: '',
        packet: packet(question, []),
        gate: { outcome: 'block', supported_claims: [], unsupported_claims: [], removed_or_rewritten_claims: [], required_gaps: [], finalAnswer: '', diagnostics: ['Fenced code block does not match any evidence content -- likely fabricated illustrative code.'] }
    };
}

const SUB_A = passedSub(
    'What does the entry function do?',
    'The entry function validates the request and hands it to the pipeline runner.',
    [item({ id: 'a1', file: 'src/entry.py', content: 'def entry(request):\n    validate(request)\n    return pipeline_runner.run(request)' })]
);
// Two evidence items, not one, purely so the union packet clears
// THIN_GROUNDING_MIN_SOURCES. These tests are about the union GATE, and with one item
// per sub the union carried 2 sources and tripped the thin-grounding check added by the
// P0-1 gate hardening -- turning 'pass' into 'revise' for reasons the test is not about.
// Asserted below so a future threshold rise fails loudly here instead of mysteriously.
const SUB_B = passedSub(
    'How does the pipeline runner handle failures?',
    'The pipeline runner wraps each stage and records failures in the audit log.',
    [
        item({ id: 'b1', file: 'src/runner.py', content: 'def run(request):\n    try:\n        stage(request)\n    except Exception:\n        audit_log.record_failure()' }),
        item({ id: 'b2', file: 'src/audit_log.py', content: 'def record_failure():\n    _sink.write(stage_error())' })
    ]
);

assert.ok(
    SUB_A.packet.items.length + SUB_B.packet.items.length >= THIN_GROUNDING_MIN_SOURCES,
    `merger fixtures must supply at least THIN_GROUNDING_MIN_SOURCES (${THIN_GROUNDING_MIN_SOURCES}) evidence items, ` +
    'otherwise the union gate returns "revise" for thin grounding and these tests stop measuring what they claim to.'
);

test('INDUCED FAILURE: a merge that fabricates an unsupported claim is caught by the final union gate and replaced by the verified-sections fallback', async () => {
    // The injected "model" produces a merge that invents a quoted config value and
    // a file that exists in NO sub-answer's evidence -- exactly the class of
    // connective fabrication the final gate pass exists to catch.
    const fabricatedMerge =
        'The entry function validates the request and hands it to the pipeline runner. ' +
        'The runner reads its retry policy from retry_config.py, which sets "max_retries = 7 for every stage", ' +
        'and records failures in the audit log.';
    const merger = new SubAnswerMerger(async () => fabricatedMerge, new AnswerGate());

    const outcome = await merger.merge('How does the request pipeline work end to end?', plan('How does the request pipeline work end to end?'), [SUB_A, SUB_B], [], POLICY);

    assert.equal(outcome.finalGate?.outcome, 'block');
    assert.equal(outcome.usedFallback, true);
    // The fabricated narrative must NOT be the answer...
    assert.ok(!outcome.answer.includes('max_retries'));
    assert.ok(!outcome.answer.includes('retry_config.py'));
    // ...and both individually-verified sub-answers must be, verbatim.
    assert.ok(outcome.answer.includes(SUB_A.answer));
    assert.ok(outcome.answer.includes(SUB_B.answer));
    assert.ok(outcome.answer.includes('could not be verified'));
});

test('a faithful merge passes the final union gate and is used as-is', async () => {
    const faithfulMerge =
        'The entry function validates the request and hands it to the pipeline runner, ' +
        'which wraps each stage and records failures in the audit log.';
    const merger = new SubAnswerMerger(async () => faithfulMerge, new AnswerGate());

    const outcome = await merger.merge('How does the request pipeline work end to end?', plan('How does the request pipeline work end to end?'), [SUB_A, SUB_B], [], POLICY);

    assert.equal(outcome.finalGate?.outcome, 'pass');
    assert.equal(outcome.usedFallback, false);
    assert.equal(outcome.answer, faithfulMerge);
});

test('blocked sub-questions become an explicit "Not covered" disclosure, never a silent hole', async () => {
    const merger = new SubAnswerMerger(async () => 'The entry function validates the request and hands it to the pipeline runner, and failures are recorded in the audit log.', new AnswerGate());
    const blocked = blockedSub('Where is the final report persisted on disk and in the database?');

    const outcome = await merger.merge('Full walkthrough?', plan('Full walkthrough?'), [SUB_A, SUB_B], [blocked], POLICY);

    assert.ok(outcome.answer.includes('**Not covered:**'));
    assert.ok(outcome.answer.includes('Where is the final report persisted'));
});

test('a single surviving sub-answer is used directly with no merge generation call', async () => {
    let chatCalls = 0;
    const merger = new SubAnswerMerger(async () => { chatCalls++; return 'should not be called'; }, new AnswerGate());

    const outcome = await merger.merge('Walkthrough?', plan('Walkthrough?'), [SUB_A], [blockedSub('other facet')], POLICY);

    assert.equal(chatCalls, 0);
    assert.ok(outcome.answer.includes(SUB_A.answer));
    assert.ok(outcome.answer.includes('**Not covered:**'));
});

test('union packet deduplicates evidence items shared between sub-packets by id', async () => {
    const shared = item({ id: 'shared-1', file: 'src/shared.py', content: 'SHARED = True' });
    const subX = passedSub('facet one of the pipeline?', 'Part one answer about the pipeline.', [shared, item({ id: 'x1' })]);
    const subY = passedSub('facet two of the pipeline?', 'Part two answer about the pipeline.', [shared, item({ id: 'y1' })]);
    const merger = new SubAnswerMerger(async () => 'Part one answer about the pipeline. Part two answer about the pipeline.', new AnswerGate());

    const outcome = await merger.merge('the pipeline?', plan('the pipeline?'), [subX, subY], [], POLICY);

    const ids = outcome.unionPacket.items.map(i => String(i.id));
    assert.equal(ids.filter(id => id === 'shared-1').length, 1);
    assert.equal(new Set(ids).size, ids.length);
});

// --- retry-with-gate-feedback ---

import { retrySynthesisWithGateFeedback } from '../../query/subTaskRetry';

test('retrySynthesisWithGateFeedback: prompt carries the rejection reasons, and a clean retry recovers', async () => {
    const evidence = item({ id: 'ev1', file: 'src/runner.py', content: 'def run(request):\n    audit_log.record_failure()' });
    // Padded to THIN_GROUNDING_MIN_SOURCES for the same reason as SUB_A/SUB_B above: this
    // test asserts the RETRY recovers to 'pass', which thin grounding would downgrade to
    // 'revise' regardless of how clean the retried answer is.
    const pkt = packet('How are failures recorded?', [
        evidence,
        item({ id: 'ev2', file: 'src/audit_log.py', content: 'def record_failure():\n    _sink.write(stage_error())' }),
        item({ id: 'ev3', file: 'src/sink.py', content: 'class Sink:\n    def write(self, row): ...' })
    ]);
    const blockedGate = {
        outcome: 'block' as const,
        supported_claims: [], unsupported_claims: [], removed_or_rewritten_claims: [], required_gaps: [],
        finalAnswer: '',
        diagnostics: ['Fenced code block does not match any evidence content -- likely fabricated illustrative code.']
    };

    let capturedMessages: Array<{ role: string; content: string }> = [];
    const outcome = await retrySynthesisWithGateFeedback(
        pkt,
        blockedGate,
        POLICY,
        async messages => {
            capturedMessages = messages;
            return 'Failures are recorded via the audit log in src/runner.py.';
        },
        new AnswerGate()
    );

    const feedback = capturedMessages[capturedMessages.length - 1].content;
    assert.ok(feedback.includes('rejected by automatic verification'));
    assert.ok(feedback.includes('Fenced code block does not match'));
    assert.equal(outcome.recovered, true);
    assert.equal(outcome.gate.outcome, 'pass');
});

test('retrySynthesisWithGateFeedback: a retry that fabricates again stays blocked (no lowered bar)', async () => {
    const evidence = item({ id: 'ev1', file: 'src/runner.py', content: 'def run(request):\n    audit_log.record_failure()' });
    const pkt = packet('How are failures recorded?', [evidence]);
    const blockedGate = {
        outcome: 'block' as const,
        supported_claims: [], unsupported_claims: [], removed_or_rewritten_claims: [], required_gaps: [],
        finalAnswer: '',
        diagnostics: ['Unsupported quoted string: "whatever"']
    };

    const outcome = await retrySynthesisWithGateFeedback(
        pkt,
        blockedGate,
        POLICY,
        async () => 'The retry doubles down: failures go through "the quantum retry lattice dispatcher" internally.',
        new AnswerGate()
    );

    assert.equal(outcome.recovered, false);
    assert.equal(outcome.gate.outcome, 'block');
});

// --- trigger predicate ---

test('decompositionEligible: requires 2+ sub-questions AND high complexity AND an allowlisted query type', () => {
    const subs = ['What is the entry point of the flow?', 'How are errors in the flow handled?'];
    assert.equal(decompositionEligible(DECOMPOSITION_MIN_COMPLEXITY_SCORE, 'architecture_analysis', subs), true);
    // each gate individually vetoes:
    assert.equal(decompositionEligible(DECOMPOSITION_MIN_COMPLEXITY_SCORE - 1, 'architecture_analysis', subs), false);
    assert.equal(decompositionEligible(DECOMPOSITION_MIN_COMPLEXITY_SCORE, 'exact_constant', subs), false);
    assert.equal(decompositionEligible(DECOMPOSITION_MIN_COMPLEXITY_SCORE, 'symbol_location', subs), false);
    assert.equal(decompositionEligible(DECOMPOSITION_MIN_COMPLEXITY_SCORE, 'architecture_analysis', [subs[0]]), false);
    assert.equal(decompositionEligible(DECOMPOSITION_MIN_COMPLEXITY_SCORE, 'architecture_analysis', undefined), false);
});

// --- planner-side sub-question validation ---

test('validateSubQuestions: caps at 5, drops duplicates, trivial entries, and off-topic drift', () => {
    const master = 'Walk me through the mission execution pipeline: agents, failures, timeouts, status, and persistence.';
    const { valid, discarded } = validateSubQuestions([
        'Which agents run during mission execution and in what order?',
        'Which agents run during mission execution and in what order?', // duplicate
        'How are agent failures handled in the mission pipeline?',
        'Where is the mission report persisted?',
        'ok?', // trivial
        'What is the capital of France?', // off-topic: no term overlap
        'What timeouts apply to each agent in the pipeline?',
        'How is the mission status updated after execution?',
        'Which retries are configured for mission execution stages?' // over the cap of 5
    ], master);

    assert.equal(valid.length, 5);
    assert.ok(!valid.includes('What is the capital of France?'));
    assert.ok(discarded.includes('What is the capital of France?'));
    assert.ok(discarded.includes('ok?'));
    assert.ok(discarded.includes('Which retries are configured for mission execution stages?'));
    assert.equal(new Set(valid.map(v => v.toLowerCase())).size, valid.length);
});

test('validateSubQuestions: non-array input yields no sub-questions', () => {
    assert.deepEqual(validateSubQuestions('not an array', 'anything'), { valid: [], discarded: [] });
    assert.deepEqual(validateSubQuestions(undefined, 'anything'), { valid: [], discarded: [] });
});
