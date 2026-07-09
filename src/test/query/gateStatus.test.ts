import test from 'node:test';
import * as assert from 'node:assert/strict';
import { deriveGateStatusOutcome } from '../../query/queryDispatcher';
import { GateResult } from '../../query/answerGate';

// UX trust-visibility Part 3 design, item B: the gateStatus token so the chat UI can
// show whether/how an answer was verified. QueryDispatcher itself is too
// dependency-heavy to construct in a unit test (LanceStore, ExecutionPlanner,
// RetrievalOrchestrator, ...), so the token's {outcome, unsupportedCount} derivation
// is exported as a pure function and tested directly here -- this is the exact logic
// emitFinalAnswer and the single-shot/decomposed blocked branches yield through.

function gate(overrides: Partial<GateResult>): GateResult {
    return {
        outcome: 'pass',
        supported_claims: [],
        unsupported_claims: [],
        removed_or_rewritten_claims: [],
        required_gaps: [],
        finalAnswer: '',
        diagnostics: [],
        ...overrides
    };
}

test('deriveGateStatusOutcome: pass, single-shot (no decomposition context)', () => {
    const result = deriveGateStatusOutcome(gate({ outcome: 'pass', unsupported_claims: [] }));
    assert.equal(result.outcome, 'pass');
    assert.equal(result.unsupportedCount, 0);
});

test('deriveGateStatusOutcome: revise, single-shot -- unsupportedCount reflects real flagged claims', () => {
    const result = deriveGateStatusOutcome(gate({
        outcome: 'revise',
        unsupported_claims: ['Fenced code block (not found in evidence): ...', 'Numeric: 42']
    }));
    assert.equal(result.outcome, 'revise');
    assert.equal(result.unsupportedCount, 2);
});

test('deriveGateStatusOutcome: block, single-shot (the runEvidenceQuery blocked-branch call shape)', () => {
    const result = deriveGateStatusOutcome(gate({
        outcome: 'block',
        unsupported_claims: ['Unsupported quoted string: "whatever"']
    }));
    assert.equal(result.outcome, 'block');
    assert.equal(result.unsupportedCount, 1);
});

test('deriveGateStatusOutcome: decomposed-partial via blockedCount -- a clean pass gets downgraded to revise to disclose the omitted facet(s)', () => {
    // gateResult.outcome is 'pass' (the merge itself passed cleanly), but one
    // sub-question was blocked and disclosed as "Not covered:" -- the delivered
    // answer has a real caveat, so the chip must not read as an unqualified "Verified".
    const result = deriveGateStatusOutcome(
        gate({ outcome: 'pass', unsupported_claims: [] }),
        { blockedCount: 1, usedFallback: false }
    );
    assert.equal(result.outcome, 'revise');
    assert.equal(result.unsupportedCount, 1);
});

test('deriveGateStatusOutcome: decomposed-partial via usedFallback -- a raw "block" finalGate is corrected to revise because the sectioned fallback WAS delivered', () => {
    // Mirrors SubAnswerMerger.merge()'s real shape: usedFallback is only ever true
    // when finalGate.outcome === 'block', but the user still receives real,
    // individually-verified sections -- never a bare refusal. Must not show "Blocked".
    const result = deriveGateStatusOutcome(
        gate({ outcome: 'block', unsupported_claims: ['Merged narrative blocked by final gate'] }),
        { blockedCount: 0, usedFallback: true }
    );
    assert.equal(result.outcome, 'revise');
    assert.notEqual(result.outcome, 'block');
    assert.equal(result.unsupportedCount, 1);
});

test('deriveGateStatusOutcome: decomposed, all sub-questions passed and merge succeeded cleanly -- decomposition context present but a no-op', () => {
    const result = deriveGateStatusOutcome(
        gate({ outcome: 'pass', unsupported_claims: [] }),
        { blockedCount: 0, usedFallback: false }
    );
    assert.equal(result.outcome, 'pass');
    assert.equal(result.unsupportedCount, 0);
});

test('deriveGateStatusOutcome: decomposed, merge itself flagged something (revise) with no blocked facets -- stays revise, not forced or downgraded', () => {
    const result = deriveGateStatusOutcome(
        gate({ outcome: 'revise', unsupported_claims: ['Numeric: 7'] }),
        { blockedCount: 0, usedFallback: false }
    );
    assert.equal(result.outcome, 'revise');
    assert.equal(result.unsupportedCount, 1);
});

test('deriveGateStatusOutcome: both blockedCount>0 AND usedFallback=true -- outcome still just "revise" (no third state), unsupportedCount aggregates both', () => {
    const result = deriveGateStatusOutcome(
        gate({ outcome: 'block', unsupported_claims: ['a', 'b'] }),
        { blockedCount: 2, usedFallback: true }
    );
    assert.equal(result.outcome, 'revise');
    assert.equal(result.unsupportedCount, 4);
});
