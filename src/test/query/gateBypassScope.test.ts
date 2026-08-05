import test from 'node:test';
import * as assert from 'node:assert/strict';
import { AnswerGate } from '../../query/answerGate';
import { EvidencePacket, EvidenceItem } from '../../query/evidencePacket';
import { EvidencePlan } from '../../query/evidencePlanTypes';
import { detectFabricatedTechnologyClaims } from '../../query/technologyClaimVerifier';
import { abstentionScope } from '../../query/abstentionVerifier';

/**
 * Regression guard for STRICT_AUDIT_2026-08-04 P0-1: a hedging phrase anywhere in an answer
 * disabled EVERY blocking check in AnswerGate.
 *
 * The mechanism was `skipStrictBlocking`, a single boolean set by a substring scan for five
 * phrases -- one of them the bare word "missing" -- which guarded eight `outcome = 'block'`
 * sites plus check 6d. Reproduced before the fix: "The project uses Redis for caching."
 * blocked as a fabricated technology; appending "Error handling for a missing key is
 * elsewhere." made the identical fabrication PASS with a green trust chip.
 *
 * A second, independent instance of the same defect class was found while closing the first
 * and is pinned here too: `technologyClaimVerifier` tested its negation guard over a fixed
 * ±120-character window that crossed sentence boundaries, so an ordinary "not"/"no" in a
 * NEIGHBOURING sentence suppressed the fabrication flag. Fixing only AnswerGate left three of
 * the five phrases still bypassing the flagship check through that path.
 *
 * What this file pins is the INVARIANT, not the implementation: a hedge exempts an artifact
 * only where the artifact might be a restatement of the question -- i.e. inside the abstaining
 * sentence itself. Both directions are asserted, because a check that never exempts anything
 * would pass a one-directional test while reintroducing the over-blocking this project has
 * twice had to revert.
 */

/** The five phrases that formerly set skipStrictBlocking. */
const FORMER_BYPASS_PHRASES = [
    'missing',
    'cannot determine',
    'does not determine',
    'does not specify',
    'not explicitly stated'
];

/** A trailing sentence containing the phrase, in ordinary non-abstaining prose where possible. */
function hedgeSentence(phrase: string): string {
    switch (phrase) {
        case 'missing': return 'Error handling for a missing key is elsewhere.';
        case 'cannot determine': return 'I cannot determine the eviction policy.';
        case 'does not determine': return 'This does not determine the version.';
        case 'does not specify': return 'The evidence does not specify the TTL.';
        case 'not explicitly stated': return 'The port is not explicitly stated.';
        default: throw new Error(`unhandled phrase ${phrase}`);
    }
}

function basePlan(): EvidencePlan {
    return {
        originalQuery: 'test query',
        normalizedQuery: 'test query',
        queryType: 'architecture' as any,
        requiredEvidence: [],
        symbolHints: [],
        fileHints: [],
        factTypes: [],
        unitTypes: [],
        fileScope: 'workspace' as any,
        retrievalStrategy: 'hybrid' as any,
        mustExcludeRoles: [],
        diagnostics: [],
        confidence_mode: 'exact'
    };
}

function item(overrides: Partial<EvidenceItem>): EvidenceItem {
    return {
        id: 'item-1', file: '', startLine: 1, endLine: 1, role: 'implementation',
        type: 'snippet', content: '', retrieval_signal: 'test', score: 1,
        confidence: 1, extractionMethod: 'heuristic', ...overrides
    };
}

/** Enough sources that check 6d (thin grounding) never confounds an outcome assertion. */
function packet(items: EvidenceItem[] = [], facts: EvidenceItem[] = []): EvidencePacket {
    return {
        query: 'test query',
        plan: basePlan(),
        items: [...items, item({ id: 'b1' }), item({ id: 'b2' }), item({ id: 'b3' })],
        facts,
        coverage: [], gaps: [], diagnostics: [], coverageScore: 1, matchedEvidenceTypes: []
    };
}

const PRESENT_TECHNOLOGIES = new Set(['Django']);

/**
 * The four blocking checks reachable without on-disk fixtures. Each returns an answer that
 * MUST block, so the test can append a hedge sentence to it and assert it still blocks.
 */
const BLOCKING_CASES: Array<{ name: string; answer: string; verify: (gate: AnswerGate, answer: string) => string }> = [
    {
        name: '6a fabricated technology',
        answer: 'The project uses Redis for caching.',
        verify: (gate, answer) => gate.verify(answer, packet(), undefined, undefined, undefined, PRESENT_TECHNOLOGIES).outcome
    },
    {
        name: '3 fabricated quote',
        answer: 'The handler logs "this exact string never appears anywhere in the evidence at all".',
        verify: (gate, answer) => gate.verify(answer, packet()).outcome
    },
    {
        name: '3b fabricated code fence',
        answer: 'Here is the code:\n```\ndef totally_fabricated_function(alpha, beta):\n    return alpha * beta + 42\n```\n',
        verify: (gate, answer) => gate.verify(answer, packet()).outcome
    },
    {
        name: '1 unsupported numeric claim',
        answer: 'The pipeline retries 4173 times before giving up.',
        verify: (gate, answer) => gate.verify(answer, packet()).outcome
    }
];

// --- the reproduction, generalised -------------------------------------------------

for (const kase of BLOCKING_CASES) {
    test(`${kase.name}: blocks on its own (control -- the rest of this file is meaningless without it)`, () => {
        const gate = new AnswerGate();
        assert.equal(kase.verify(gate, kase.answer), 'block');
    });

    for (const phrase of FORMER_BYPASS_PHRASES) {
        test(`${kase.name}: still blocks when a separate sentence contains "${phrase}"`, () => {
            const gate = new AnswerGate();
            const withHedge = `${kase.answer} ${hedgeSentence(phrase)}`;
            assert.equal(
                kase.verify(gate, withHedge),
                'block',
                `a hedge in a DIFFERENT sentence must not exempt this claim (P0-1 bypass, phrase: "${phrase}")`
            );
        });
    }
}

test('P0-1 verbatim reproduction: the audit A/B pair now agree', () => {
    const gate = new AnswerGate();
    const a = 'The project uses Redis for caching.';
    const b = 'The project uses Redis for caching. Error handling for a missing key is elsewhere.';
    const outcomeA = gate.verify(a, packet(), undefined, undefined, undefined, PRESENT_TECHNOLOGIES).outcome;
    const outcomeB = gate.verify(b, packet(), undefined, undefined, undefined, PRESENT_TECHNOLOGIES).outcome;
    assert.equal(outcomeA, 'block');
    assert.equal(outcomeB, 'block', 'one extra clause containing "missing" flipped block -> pass before the fix');
});

// --- the other direction: the exemption the flag legitimately existed for ----------

test('a number restated INSIDE the abstaining sentence is still exempt (the motivating case)', () => {
    // The original comment cited exactly this: "I cannot determine if 0.85 is..." -- the 0.85
    // came from the question, so it is not a claim. Removing the exemption entirely would
    // reintroduce the over-blocking this project has twice reverted.
    const gate = new AnswerGate();
    const facts = [item({
        id: 'f1', file: 'src/a.py', startLine: 9, endLine: 9,
        symbol: 'confidence_threshold', type: 'numeric_threshold', content: '0.55'
    })];
    const r = gate.verify('I cannot determine if 0.85 is the confidence_threshold used here.', packet([], facts));
    assert.notEqual(r.outcome, 'block');
});

test('the same number asserted in its own sentence is NOT exempt, even beside an abstention', () => {
    const gate = new AnswerGate();
    const facts = [item({
        id: 'f1', file: 'src/a.py', startLine: 9, endLine: 9,
        symbol: 'confidence_threshold', type: 'numeric_threshold', content: '0.55'
    })];
    const r = gate.verify(
        'The confidence_threshold is 0.85. Separately, the evidence does not specify the retry limit.',
        packet([], facts)
    );
    assert.equal(r.outcome, 'block');
});

test('a quote echoed inside the abstaining sentence is exempt; the same quote asserted elsewhere is not', () => {
    const gate = new AnswerGate();
    const inside = gate.verify('The evidence does not specify what "retry_budget_seconds" controls.', packet());
    const outside = gate.verify(
        'The handler reads "retry_budget_seconds" from config. The evidence does not specify its default.',
        packet()
    );
    assert.notEqual(inside.outcome, 'block');
    assert.equal(outside.outcome, 'block');
});

// --- check 6d is answer-level, and must not be switched off by a bare word ---------

test('6d: an ordinary sentence containing "missing" no longer suppresses the thin-evidence caveat', () => {
    const gate = new AnswerGate();
    const thin: EvidencePacket = { ...packet(), items: [item({ id: 'only-1' }), item({ id: 'only-2' })] };
    const r = gate.verify('The config value is missing from the loader.', thin);
    assert.equal(r.outcome, 'revise');
    assert.match(r.finalAnswer, /retrieved very little evidence/);
});

test('6d: a genuine abstention is still not double-flagged as thin', () => {
    const gate = new AnswerGate();
    const thin: EvidencePacket = { ...packet(), items: [item({ id: 'only-1' }), item({ id: 'only-2' })] };
    const r = gate.verify('The evidence does not specify the retry limit.', thin);
    assert.doesNotMatch(r.finalAnswer, /retrieved very little evidence/);
});

// --- second root cause: negation must be sentence-scoped, not window-scoped -------

test('technology check: a negation in a NEIGHBOURING sentence no longer suppresses the flag', () => {
    // Before the fix these three were silently unflagged, which is why fixing AnswerGate
    // alone left the P0-1 symptom reproducible for three of the five phrases.
    for (const trailer of [
        'The evidence does not specify the TTL.',
        'The port is not explicitly stated.',
        'There is no reason to think otherwise about it.'
    ]) {
        const claims = detectFabricatedTechnologyClaims(
            `The project uses Redis for caching. ${trailer}`,
            PRESENT_TECHNOLOGIES
        );
        assert.equal(claims.length, 1, `must still flag Redis despite trailing sentence: "${trailer}"`);
    }
});

test('technology check: negation in the SAME sentence still suppresses (denial is correct behaviour)', () => {
    for (const answer of [
        'The project does not use Redis.',
        'There is no GraphQL layer in this codebase.',
        'Unlike Celery, this is synchronous.'
    ]) {
        assert.equal(
            detectFabricatedTechnologyClaims(answer, PRESENT_TECHNOLOGIES).length,
            0,
            `denying a false premise must never be flagged: "${answer}"`
        );
    }
});

// --- the vocabulary itself ---------------------------------------------------------

test('"missing" is not an abstention marker, and no bare word may become one', () => {
    assert.equal(abstentionScope('Error handling for a missing key is elsewhere.').any, false);
    assert.equal(abstentionScope('The missing dependency is installed at build time.').any, false);
});

test('real hedges are still recognised, including the active-voice form', () => {
    for (const answer of [
        'I cannot determine the eviction policy.',
        'The evidence does not specify the TTL.',
        'The port is not explicitly stated.',
        'The evidence does not determine which module owns this.'
    ]) {
        assert.equal(abstentionScope(answer).any, true, answer);
    }
});

test('abstention scope is positional: an offset in another sentence is not covered', () => {
    const answer = 'The project uses Redis for caching. I cannot determine the eviction policy.';
    const scope = abstentionScope(answer);
    assert.equal(scope.any, true);
    assert.equal(scope.covers(answer.indexOf('Redis')), false, 'sentence 1 is not abstaining');
    assert.equal(scope.covers(answer.indexOf('eviction')), true, 'sentence 2 is');
});
