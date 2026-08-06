import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Defect #11 drift guard (2026-08-04) — "one canonical answer tail".
 *
 * LIMITATIONS.md §2.5 recorded `explainSelection` as falling back to a legacy
 * `HybridQueryPipeline`. That pipeline was in fact deleted during the Phase 1
 * consolidation (`docs/engineering-log/PHASE1_CONSOLIDATION_REPORT.md` §8), and
 * `explainSelection` does run the canonical plan → retrieve → packet → synthesize
 * → `AnswerGate.verify()` sequence. What was still genuinely divergent is smaller
 * and subtler: it never called `emitFinalAnswer`, so it hand-rolled a two-line
 * partial copy of the post-gate tail and silently missed the query-evidence
 * export, mentor insights, citation resolution, and the trust-visibility
 * gateStatus token.
 *
 * That class of divergence is invisible to a normal unit test — nothing fails,
 * an answer just quietly gets less than the canonical one. `QueryDispatcher`
 * itself cannot be constructed in a plain Node process (it transitively loads
 * the LanceDB native binding), so this asserts the invariants against the real
 * source text, the same technique `src/test/webviews/gateStatusRendering.test.ts`
 * uses for its cross-file drift guards. Path is relative to the COMPILED
 * location of this file (out/test/query/), not the source location.
 */
const DISPATCHER_SOURCE = fs.readFileSync(
    path.join(__dirname, '../../../src/query/queryDispatcher.ts'),
    'utf8'
);

/**
 * Extracts one method body by brace-matching.
 *
 * `declaration` must end at the parameter list's opening paren, because the
 * parameter list has to be skipped by PAREN depth before brace-matching starts:
 * `emitFinalAnswer`'s own signature contains an inline object type
 * (`decompositionContext?: { blockedCount: number; usedFallback: boolean }`), and
 * a naive "first `{` after the declaration" would brace-match that parameter's
 * type instead of the body — which is exactly how the first version of this
 * helper produced a false failure on a method that was in fact correct.
 */
function methodBody(source: string, declaration: string): string {
    const start = source.indexOf(declaration);
    assert.notEqual(start, -1, `Could not find "${declaration}" in queryDispatcher.ts`);

    // Skip the parameter list by paren depth, starting at the declaration's own '('.
    let parenDepth = 0;
    let afterParams = -1;
    for (let i = start + declaration.length - 1; i < source.length; i++) {
        if (source[i] === '(') { parenDepth++; }
        else if (source[i] === ')') {
            parenDepth--;
            if (parenDepth === 0) { afterParams = i + 1; break; }
        }
    }
    assert.notEqual(afterParams, -1, `Could not close the parameter list of "${declaration}"`);

    const open = source.indexOf('{', afterParams);
    assert.notEqual(open, -1, `Could not find an opening brace for "${declaration}"`);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') { depth++; }
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) { return source.slice(open, i + 1); }
        }
    }
    assert.fail(`Unbalanced braces while reading "${declaration}"`);
}

/**
 * Self-check on the helper above, so a silently-wrong extractor can't make the
 * real assertions vacuously pass. Both bodies must contain a statement that is
 * unique to them and absent from the other.
 */
test('SELF-CHECK: methodBody extracts real bodies, not parameter type literals', () => {
    const emit = methodBody(DISPATCHER_SOURCE, 'private async *emitFinalAnswer(');
    const tail = methodBody(DISPATCHER_SOURCE, 'private async finalizeApprovedAnswer(');
    assert.ok(emit.includes("__type: 'answerMetadata'"), 'emitFinalAnswer body was not captured');
    assert.ok(tail.includes('exportQueryEvidence('), 'finalizeApprovedAnswer body was not captured');
    assert.ok(!tail.includes("__type: 'answerMetadata'"), 'method bodies bled into each other');
});

// --- The legacy pipeline is genuinely gone (the §2.5 claim itself) ---

test('no legacy HybridQueryPipeline fallback survives anywhere in src/', () => {
    const srcRoot = path.join(__dirname, '../../../src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.ts')) { continue; }
            const text = fs.readFileSync(full, 'utf8');
            // Historical prose in comments is fine; a real identifier is not.
            for (const line of text.split('\n')) {
                const code = line.split('//')[0];
                if (/\blegacyPipeline\b/.test(code) || /\bnew HybridQueryPipeline\b/.test(code)) {
                    offenders.push(`${path.relative(srcRoot, full)}: ${line.trim()}`);
                }
            }
        }
    };
    walk(srcRoot);
    assert.deepEqual(
        offenders,
        [],
        'A legacy query-pipeline reference reappeared in src/ — defect #11 forbids a second answer path:\n' + offenders.join('\n')
    );
});

// --- Every gate-approved delivery path runs the shared tail ---

test('emitFinalAnswer (chat + decomposed merge) delegates to finalizeApprovedAnswer', () => {
    const body = methodBody(DISPATCHER_SOURCE, 'private async *emitFinalAnswer(');
    assert.ok(
        body.includes('this.finalizeApprovedAnswer('),
        'emitFinalAnswer no longer runs the canonical shared tail'
    );
});

test('explainSelection delegates to the SAME finalizeApprovedAnswer, not a hand-rolled tail', () => {
    const body = methodBody(DISPATCHER_SOURCE, 'async *explainSelection(');
    assert.ok(
        body.includes('this.finalizeApprovedAnswer('),
        'explainSelection stopped running the canonical shared tail — this is exactly the ' +
        'defect #11 divergence (gate/tail fixes silently not propagating to explain-selection)'
    );
});

test('explainSelection emits the trust-visibility gateStatus token', () => {
    const body = methodBody(DISPATCHER_SOURCE, 'async *explainSelection(');
    assert.ok(
        body.includes("__type: 'gateStatus'"),
        'explainSelection stopped emitting gateStatus — a verified explanation would render as "Unverified"'
    );
});

test('explainSelection still renders the withheld answer on a gate block', () => {
    const body = methodBody(DISPATCHER_SOURCE, 'async *explainSelection(');
    assert.ok(
        body.includes('renderWithheldAnswer('),
        'explainSelection stopped using the shared withheld-answer rendering'
    );
});

test('explainSelection still passes workspaceRoot and the graph store to AnswerGate (checks 6c/6d)', () => {
    const body = methodBody(DISPATCHER_SOURCE, 'async *explainSelection(');
    assert.ok(body.includes('this.answerGate.verify('), 'explainSelection stopped calling AnswerGate');
    assert.ok(
        body.includes('this.context.workspaceRoot') && body.includes('this.graphStore'),
        'explainSelection stopped passing workspaceRoot/graphStore — the relation-claim (6c) and ' +
        'file-usage (6b) checks silently degrade without them'
    );
});

// --- The structural invariant that makes the above hard to undo by accident ---

test('conversation history is recorded ONLY inside the canonical shared tail', () => {
    const historyWrites = DISPATCHER_SOURCE.split('\n')
        .map((line, i) => ({ line: line.trim(), lineNumber: i + 1 }))
        .filter(entry => /this\.history\.add\(/.test(entry.line.split('//')[0]));

    assert.ok(historyWrites.length > 0, 'Expected the shared tail to record conversation history');

    const tail = methodBody(DISPATCHER_SOURCE, 'private async finalizeApprovedAnswer(');
    for (const write of historyWrites) {
        assert.ok(
            tail.includes(write.line),
            `queryDispatcher.ts:${write.lineNumber} records conversation history outside ` +
            'finalizeApprovedAnswer. That is how the explain-selection path drifted from the ' +
            'chat path in the first place: a second, partial copy of the tail. Route the new ' +
            'delivery path through finalizeApprovedAnswer instead.'
        );
    }
});

test('the query-evidence export (MCP get_last_chat_evidence) lives in the shared tail', () => {
    const tail = methodBody(DISPATCHER_SOURCE, 'private async finalizeApprovedAnswer(');
    assert.ok(
        tail.includes('exportQueryEvidence('),
        'The query-evidence export left the shared tail — surfaces that do not call ' +
        'emitFinalAnswer would become invisible to MCP get_last_chat_evidence again'
    );
    assert.ok(
        tail.includes('this.mentorOrchestrator.run('),
        'Mentor insights left the shared tail'
    );
});

// --- Documented exception, asserted so it stays deliberate ---

test('runDocumentationReport is the one gate call site that deliberately skips the chat tail', () => {
    const body = methodBody(DISPATCHER_SOURCE, 'async *runDocumentationReport(');
    assert.ok(body.includes('this.answerGate.verify('), 'the documentation report must still be gated');
    assert.ok(
        !body.includes('this.finalizeApprovedAnswer('),
        'runDocumentationReport now runs the chat tail. That is not automatically wrong, but it ' +
        'is a behavior change: the doc report is a whole-repository dump with no question and no ' +
        'conversational turn, so recording it as chat history and exporting it as chat evidence ' +
        'would pollute both. Update this test deliberately if that is genuinely intended.'
    );
});

// --- P1-5 (2026-08-06): skipping the chat tail is deliberate, but skipping the DELIVERY
// contract (trust-visibility token, gate-corrected content, non-raw withheld message) was not.
// runDocumentationReport should look like emitFinalAnswer/explainSelection on these three points
// even though it correctly stays off finalizeApprovedAnswer.

test('runDocumentationReport emits the trust-visibility gateStatus token, same as every other gate-bearing surface', () => {
    const body = methodBody(DISPATCHER_SOURCE, 'async *runDocumentationReport(');
    assert.ok(
        body.includes("__type: 'gateStatus'"),
        'runDocumentationReport does not emit gateStatus — a verified report would render with ' +
        'the defensive "Unverified" fallback chip, contradicting emitFinalAnswer\'s own comment ' +
        'that no production path skips it'
    );
});

test('runDocumentationReport yields the gate-corrected finalAnswer, not the raw pre-gate answer', () => {
    const body = methodBody(DISPATCHER_SOURCE, 'async *runDocumentationReport(');
    assert.ok(
        body.includes('gateResult.finalAnswer'),
        'runDocumentationReport must deliver finalAnswer (which carries every gate caveat: ' +
        'thin-evidence, relation-contradiction correction, conceptual-coverage prefix) -- ' +
        'streaming the raw pre-gate answer silently discards all of them on a revise outcome'
    );
});

test('runDocumentationReport uses the shared withheld-answer rendering on block, not a raw diagnostics dump', () => {
    const body = methodBody(DISPATCHER_SOURCE, 'async *runDocumentationReport(');
    assert.ok(
        body.includes('renderWithheldAnswer('),
        'runDocumentationReport stopped using the shared withheld-answer rendering'
    );
    assert.ok(
        !body.includes('gateResult.diagnostics.join('),
        'runDocumentationReport reintroduced the raw diagnostics.join(", ") dump withheldAnswer.ts ' +
        'was built specifically to replace -- internal checker jargon should never reach the user'
    );
});

test('runDocumentationReport does not stream raw synthesizer chunks before gate verification', () => {
    const body = methodBody(DISPATCHER_SOURCE, 'async *runDocumentationReport(');
    const synthesisLoop = body.slice(
        body.indexOf('streamSynthesizeDocumentation'),
        body.indexOf('this.answerGate.verify(')
    );
    assert.ok(
        !/\byield chunk\b/.test(synthesisLoop),
        'runDocumentationReport is yielding synthesizer chunks directly to the caller again -- ' +
        'this is the P1-5 defect: unverified model output reaching the user before the gate runs, ' +
        'with every correction the gate computes arriving too late to matter'
    );
});
