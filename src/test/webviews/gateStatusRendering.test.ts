import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// UX trust-visibility Part 3 design, items A/B/D. gateStatusRendering.js is plain
// browser JS (webviews/ is not compiled by tsc -- rootDir is src/), loaded via a
// dual CommonJS/global-scope export shim specifically so it's requirable here
// without a DOM. Path is relative to the COMPILED location of this test file
// (out/test/webviews/), not this source file's location.
const GateStatusRendering = require('../../../webviews/sidebar/gateStatusRendering.js');

const ANSWER_GATE_SOURCE = fs.readFileSync(
    path.join(__dirname, '../../../src/query/answerGate.ts'),
    'utf8'
);

// --- Drift guard: the whole point of the cross-reference comments on both sides
// (answerGate.ts's UNVERIFIED_FENCE_ANNOTATION/prepend strings, and this module's
// GATE_ANNOTATION_TEXT/GATE_PREPEND_TEXTS) is that they silently drift apart if
// someone edits one side and not the other. Enforce it instead of just asserting it
// in a comment. ---

test('DRIFT GUARD: GATE_ANNOTATION_TEXT\'s core message matches answerGate.ts\'s real UNVERIFIED_FENCE_ANNOTATION', () => {
    // Compares the core message only, not the leading "\n> "/trailing "\n" structural
    // characters -- those appear as literal backslash-n escape sequences in the TS
    // source text, and comparing them directly would require fragile escaping
    // gymnastics that add risk without adding real drift protection. The core message
    // (no embedded newlines/quotes) appears as an ordinary contiguous substring of
    // answerGate.ts's raw source either way, so this still catches real wording drift,
    // which is the actual risk this guard exists for.
    const coreMessage = GateStatusRendering.GATE_ANNOTATION_TEXT.trim().replace(/^>\s*/, '');
    assert.ok(
        ANSWER_GATE_SOURCE.includes(coreMessage),
        'GATE_ANNOTATION_TEXT\'s message no longer matches UNVERIFIED_FENCE_ANNOTATION in answerGate.ts -- update both sides together'
    );
});

test('DRIFT GUARD: GATE_PREPEND_TEXTS[0] (gap-check prepend) is byte-identical to the real string in answerGate.ts', () => {
    assert.ok(
        ANSWER_GATE_SOURCE.includes(GateStatusRendering.GATE_PREPEND_TEXTS[0]),
        'GATE_PREPEND_TEXTS[0] no longer matches the gap-check prepend sentence in answerGate.ts -- update both sides together'
    );
});

test('DRIFT GUARD: GATE_PREPEND_TEXTS[1] (conceptual-mode-fallback prepend) is byte-identical to the real string in answerGate.ts', () => {
    assert.ok(
        ANSWER_GATE_SOURCE.includes(GateStatusRendering.GATE_PREPEND_TEXTS[1]),
        'GATE_PREPEND_TEXTS[1] no longer matches the conceptual-mode-fallback prepend sentence in answerGate.ts -- update both sides together'
    );
});

// --- deriveGateChipInfo: the outcome -> chip mapping (items B/D) ---

test('deriveGateChipInfo: pass -> Verified chip', () => {
    const info = GateStatusRendering.deriveGateChipInfo({ outcome: 'pass', unsupportedCount: 0, mode: 'exact' });
    assert.equal(info.text, 'Verified');
    assert.ok(info.className.includes('gate-status-pass'));
    assert.ok(info.className.includes('confidence-badge'), 'must reuse the .confidence-badge base class per the approved design');
});

test('deriveGateChipInfo: revise -> "Verified with notes" chip, count reflected in the title', () => {
    const info = GateStatusRendering.deriveGateChipInfo({ outcome: 'revise', unsupportedCount: 3, mode: 'grounded' });
    assert.equal(info.text, 'Verified with notes');
    assert.ok(info.className.includes('gate-status-revise'));
    assert.ok(info.title.includes('3'));
});

test('deriveGateChipInfo: block -> Blocked chip', () => {
    const info = GateStatusRendering.deriveGateChipInfo({ outcome: 'block', unsupportedCount: 1, mode: 'exact' });
    assert.equal(info.text, 'Blocked');
    assert.ok(info.className.includes('gate-status-block'));
});

test('deriveGateChipInfo: absent gateStatus (legacy/no-gate path) -> explicit muted Unverified chip, not silence', () => {
    const infoUndefined = GateStatusRendering.deriveGateChipInfo(undefined);
    const infoNull = GateStatusRendering.deriveGateChipInfo(null);
    for (const info of [infoUndefined, infoNull]) {
        assert.equal(info.text, 'Unverified');
        assert.ok(info.className.includes('gate-status-unverified'));
        assert.ok(info.className.includes('confidence-badge'));
    }
});

// --- extractGatePrepends: item A, the two notice-bar sentences ---

test('extractGatePrepends: no known prepend present -- text passes through unchanged', () => {
    const { notices, remaining } = GateStatusRendering.extractGatePrepends('The entry function validates the request.');
    assert.deepEqual(notices, []);
    assert.equal(remaining, 'The entry function validates the request.');
});

test('extractGatePrepends: the gap-check prepend is stripped and reported', () => {
    const text = 'The evidence does not determine the full answer due to missing facts. The rest of the answer follows.';
    const { notices, remaining } = GateStatusRendering.extractGatePrepends(text);
    assert.equal(notices.length, 1);
    assert.equal(notices[0], 'The evidence does not determine the full answer due to missing facts.');
    assert.equal(remaining, 'The rest of the answer follows.');
});

test('extractGatePrepends: the conceptual-mode-fallback prepend is stripped and reported', () => {
    const text = 'The retrieved evidence provides only partial architectural coverage. Here is what we found.';
    const { notices, remaining } = GateStatusRendering.extractGatePrepends(text);
    assert.equal(notices.length, 1);
    assert.equal(notices[0], 'The retrieved evidence provides only partial architectural coverage.');
    assert.equal(remaining, 'Here is what we found.');
});

test('extractGatePrepends: BOTH prepends stacked (real AnswerGate shape -- gap-check runs before the conceptual-mode fallback and both can fire on one answer)', () => {
    const text = 'The retrieved evidence provides only partial architectural coverage. ' +
        'The evidence does not determine the full answer due to missing facts. ' +
        'The actual answer content.';
    const { notices, remaining } = GateStatusRendering.extractGatePrepends(text);
    assert.equal(notices.length, 2);
    assert.equal(remaining, 'The actual answer content.');
});

test('extractGatePrepends: a prepend-shaped sentence NOT at the front is left in the flowing text (only front-anchored stripping)', () => {
    const text = 'Some real answer text. The evidence does not determine the full answer due to missing facts. More text.';
    const { notices, remaining } = GateStatusRendering.extractGatePrepends(text);
    assert.deepEqual(notices, []);
    assert.equal(remaining, text);
});

// --- splitOnAnnotationMarker: item A, the inline fence callout ---

test('splitOnAnnotationMarker: no marker present -- single segment, unchanged', () => {
    const segments = GateStatusRendering.splitOnAnnotationMarker('plain answer text');
    assert.deepEqual(segments, ['plain answer text']);
});

test('splitOnAnnotationMarker: one marker occurrence splits into exactly two segments, marker text removed from both', () => {
    const before = 'Here is the code:\n```python\nclass Foo:\n    pass\n```';
    const after = '\nThat is the class definition.';
    const text = before + GateStatusRendering.GATE_ANNOTATION_TEXT + after;
    const segments = GateStatusRendering.splitOnAnnotationMarker(text);
    assert.equal(segments.length, 2);
    assert.equal(segments[0], before);
    assert.equal(segments[1], after);
    assert.ok(!segments[0].includes('could not verify'));
    assert.ok(!segments[1].includes('could not verify'));
});

test('splitOnAnnotationMarker: two marker occurrences (duplicate fences) split into three segments', () => {
    const marker = GateStatusRendering.GATE_ANNOTATION_TEXT;
    const text = 'A' + marker + 'B' + marker + 'C';
    const segments = GateStatusRendering.splitOnAnnotationMarker(text);
    assert.deepEqual(segments, ['A', 'B', 'C']);
});

// --- deriveReadinessStatus: chat-panel readiness indicator, state precedence
// indexing > annotating > never-indexed > ready ---

test('deriveReadinessStatus: isIndexing true -> "Indexing..." state that blocks submission', () => {
    const info = GateStatusRendering.deriveReadinessStatus({ isIndexing: true, isAnnotating: false, lastIndexedAt: null });
    assert.equal(info.text, 'Indexing... (building understanding)');
    assert.ok(info.className.includes('confidence-badge'), 'must reuse the .confidence-badge base class per the approved design');
    assert.ok(info.className.includes('readiness-indexing'));
    assert.equal(info.blocksSubmission, true);
    assert.ok(info.disabledReason, 'a visible reason must be present when submission is blocked');
});

test('deriveReadinessStatus: isIndexing true takes priority over isAnnotating true (both can be true only transiently, but indexing must win)', () => {
    const info = GateStatusRendering.deriveReadinessStatus({ isIndexing: true, isAnnotating: true, lastIndexedAt: new Date().toISOString() });
    assert.equal(info.text, 'Indexing... (building understanding)');
    assert.equal(info.blocksSubmission, true);
});

test('deriveReadinessStatus: isIndexing false, isAnnotating true -> distinct "finishing up" state that does NOT block submission', () => {
    const info = GateStatusRendering.deriveReadinessStatus({ isIndexing: false, isAnnotating: true, lastIndexedAt: new Date().toISOString() });
    assert.notEqual(info.text, 'Ready');
    assert.notEqual(info.text, 'Indexing... (building understanding)');
    assert.ok(info.className.includes('readiness-annotating'));
    assert.equal(info.blocksSubmission, false, 'annotation runs after the core index is usable, so it must not block questions');
});

test('deriveReadinessStatus: never indexed (no lastIndexedAt, not currently indexing/annotating) -> honest non-Ready state, not silently "Ready"', () => {
    const info = GateStatusRendering.deriveReadinessStatus({ isIndexing: false, isAnnotating: false, lastIndexedAt: null });
    assert.notEqual(info.text, 'Ready');
    assert.ok(info.className.includes('readiness-unindexed'));
    assert.equal(info.blocksSubmission, true);
});

test('deriveReadinessStatus: indexing and annotation both complete -> "Ready", visually distinct color class from every non-ready state', () => {
    const info = GateStatusRendering.deriveReadinessStatus({ isIndexing: false, isAnnotating: false, lastIndexedAt: new Date().toISOString() });
    assert.equal(info.text, 'Ready');
    assert.ok(info.className.includes('readiness-ready'));
    assert.ok(!info.className.includes('readiness-indexing'));
    assert.ok(!info.className.includes('readiness-annotating'));
    assert.ok(!info.className.includes('readiness-unindexed'));
    assert.equal(info.blocksSubmission, false);
});

test('deriveReadinessStatus: absent/undefined health data -> a defined, non-crashing, non-Ready state', () => {
    const info = GateStatusRendering.deriveReadinessStatus(undefined);
    assert.notEqual(info.text, 'Ready');
    assert.equal(typeof info.className, 'string');
});

// --- deriveReadinessStatus + real indexingProgress numbers -- the same data
// source the VS Code status bar's "Indexing (65/401 files)..." text reads
// from (IndexManager.getIndexingProgress()), so the two can never disagree ---

test('deriveReadinessStatus: isIndexing true with real progress -> exact file counts in the text, still blocks submission', () => {
    const info = GateStatusRendering.deriveReadinessStatus({
        isIndexing: true, isAnnotating: false, lastIndexedAt: null,
        indexingProgress: { current: 65, total: 401 }
    });
    assert.equal(info.text, 'Indexing... 65/401 files');
    assert.equal(info.blocksSubmission, true, 'the regression this whole investigation started from: a real rebuild must never look like Ready');
    assert.ok(info.disabledReason);
});

test('deriveReadinessStatus: isIndexing true with no progress yet (file walk not started) -> falls back to the generic building-understanding text', () => {
    const info = GateStatusRendering.deriveReadinessStatus({ isIndexing: true, isAnnotating: false, lastIndexedAt: null, indexingProgress: null });
    assert.equal(info.text, 'Indexing... (building understanding)');
});

test('deriveReadinessStatus: isIndexing true with a zero-total progress object (empty workspace edge case) -> falls back, not "0/0 files"', () => {
    const info = GateStatusRendering.deriveReadinessStatus({ isIndexing: true, isAnnotating: false, lastIndexedAt: null, indexingProgress: { current: 0, total: 0 } });
    assert.equal(info.text, 'Indexing... (building understanding)');
});

// --- deriveIndexHealthStatusText: the Index Health panel's "Status" row --
// five states, distinct from deriveReadinessStatus's four because it separately
// distinguishes "rebuilt this session" from "ready from a prior session" ---

test('deriveIndexHealthStatusText: isIndexing true with real progress -> "Indexing (N/total files)..."', () => {
    const text = GateStatusRendering.deriveIndexHealthStatusText({
        isIndexing: true, isAnnotating: false, indexingProgress: { current: 65, total: 401 },
        lastIndexCompletedAt: null, lastIndexedAt: null
    });
    assert.equal(text, 'Indexing (65/401 files)...');
});

test('deriveIndexHealthStatusText: isIndexing true with no progress yet -> plain "Indexing..."', () => {
    const text = GateStatusRendering.deriveIndexHealthStatusText({
        isIndexing: true, isAnnotating: false, indexingProgress: null,
        lastIndexCompletedAt: null, lastIndexedAt: null
    });
    assert.equal(text, 'Indexing...');
});

test('deriveIndexHealthStatusText: isAnnotating true (indexing done) -> "Finishing up..."', () => {
    const text = GateStatusRendering.deriveIndexHealthStatusText({
        isIndexing: false, isAnnotating: true, indexingProgress: null,
        lastIndexCompletedAt: null, lastIndexedAt: new Date().toISOString()
    });
    assert.equal(text, 'Finishing up...');
});

test('deriveIndexHealthStatusText: rebuild completed THIS session -> "Indexing complete", distinct from plain "Ready"', () => {
    const text = GateStatusRendering.deriveIndexHealthStatusText({
        isIndexing: false, isAnnotating: false, indexingProgress: null,
        lastIndexCompletedAt: new Date().toISOString(), lastIndexedAt: new Date().toISOString()
    });
    assert.equal(text, 'Indexing complete');
});

test('deriveIndexHealthStatusText: index exists from a prior session (no lastIndexCompletedAt this session) -> "Ready"', () => {
    const text = GateStatusRendering.deriveIndexHealthStatusText({
        isIndexing: false, isAnnotating: false, indexingProgress: null,
        lastIndexCompletedAt: null, lastIndexedAt: new Date().toISOString()
    });
    assert.equal(text, 'Ready');
});

test('deriveIndexHealthStatusText: never indexed -> "Not indexed yet", not silently "Ready"', () => {
    const text = GateStatusRendering.deriveIndexHealthStatusText({
        isIndexing: false, isAnnotating: false, indexingProgress: null,
        lastIndexCompletedAt: null, lastIndexedAt: null
    });
    assert.equal(text, 'Not indexed yet');
});

test('deriveIndexHealthStatusText: state precedence -- isIndexing wins over a stale lastIndexCompletedAt from a previous rebuild this session', () => {
    const text = GateStatusRendering.deriveIndexHealthStatusText({
        isIndexing: true, isAnnotating: false, indexingProgress: { current: 1, total: 5 },
        lastIndexCompletedAt: new Date().toISOString(), lastIndexedAt: new Date().toISOString()
    });
    assert.equal(text, 'Indexing (1/5 files)...');
});
