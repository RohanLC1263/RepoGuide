import test from 'node:test';
import * as assert from 'node:assert/strict';
import { processAskRepoguideTokens } from '../../mcp/askRepoguideTokenProcessor';

// Real bug: mcpServer.ts's ask_repoguide filtered healthCaveat/answerMetadata/
// answerProvenance/shadowContext tokens but not progressUpdate, which the
// decomposed path (enabled by default) yields 3+ times per query -- any MCP
// question that qualified for decomposition returned raw progress-JSON fragments
// spliced into the answer text. mcpServer.ts itself runs a heavyweight main() as
// an unconditional side effect of being imported (LanceStore, ExecutionPlanner,
// DatabaseSync, ...), so it can't be imported into a test process -- these tests
// exercise the extracted, side-effect-free token-processing function directly.

async function* tokens(values: string[]): AsyncGenerator<string> {
    for (const v of values) {
        yield v;
    }
}

test('a decomposed MCP query returns clean text with no embedded JSON fragments', async () => {
    // Real shape of a decomposed query's token stream: multiple progressUpdate
    // stages interleaved with real answer text (queryDispatcher.ts's
    // runDecomposedQuery yields decomposed/sub_start(xN)/sub_done(xN)/merging,
    // then emitFinalAnswer's gateStatus + the final answer string).
    const stream = tokens([
        JSON.stringify({ __type: 'progressUpdate', progress: { stage: 'decomposed', total: 2, subQuestions: ['A?', 'B?'] } }),
        JSON.stringify({ __type: 'progressUpdate', progress: { stage: 'sub_start', index: 1, total: 2, question: 'A?' } }),
        JSON.stringify({ __type: 'progressUpdate', progress: { stage: 'sub_done', index: 1, total: 2, outcome: 'pass' } }),
        JSON.stringify({ __type: 'progressUpdate', progress: { stage: 'sub_start', index: 2, total: 2, question: 'B?' } }),
        JSON.stringify({ __type: 'progressUpdate', progress: { stage: 'sub_done', index: 2, total: 2, outcome: 'pass' } }),
        JSON.stringify({ __type: 'progressUpdate', progress: { stage: 'merging', parts: 2, blocked: 0 } }),
        JSON.stringify({ __type: 'answerMetadata', metadata: { schema: 'repoguide.answer_metadata.v1', mode: 'evidence', question: 'A and B?', file_references: [] } }),
        JSON.stringify({ __type: 'gateStatus', status: { outcome: 'pass', unsupportedCount: 0, mode: 'exact' } }),
        'The entry function validates the request, and the pipeline runner records failures in the audit log.'
    ]);

    const { answer } = await processAskRepoguideTokens(stream);

    assert.ok(!answer.includes('__type'), `answer still contains raw side-band JSON: ${answer}`);
    assert.ok(!answer.includes('progressUpdate'));
    assert.equal(answer, 'The entry function validates the request, and the pipeline runner records failures in the audit log.');
});

test('gate outcome "pass" is captured in gateStatus', async () => {
    const stream = tokens([
        JSON.stringify({ __type: 'gateStatus', status: { outcome: 'pass', unsupportedCount: 0, mode: 'exact' } }),
        'A clean, fully verified answer.'
    ]);
    const { answer, gateStatus } = await processAskRepoguideTokens(stream);
    assert.equal(gateStatus.outcome, 'pass');
    assert.equal(gateStatus.unsupportedCount, 0);
    assert.equal(answer, 'A clean, fully verified answer.');
});

test('gate outcome "revise" is captured in gateStatus', async () => {
    const stream = tokens([
        JSON.stringify({ __type: 'gateStatus', status: { outcome: 'revise', unsupportedCount: 2, mode: 'conceptual' } }),
        'An answer delivered with flagged caveats.'
    ]);
    const { gateStatus } = await processAskRepoguideTokens(stream);
    assert.equal(gateStatus.outcome, 'revise');
    assert.equal(gateStatus.unsupportedCount, 2);
});

test('gate outcome "block" is captured in gateStatus (blocked single-shot/decomposed shape: gateStatus token precedes the refusal text)', async () => {
    const stream = tokens([
        JSON.stringify({ __type: 'gateStatus', status: { outcome: 'block', unsupportedCount: 1, mode: 'exact' } }),
        'I found relevant code but could not verify the answer against it, so I have withheld it rather than present something unreliable. Specifically: Unsupported quoted string: "whatever"'
    ]);
    const { answer, gateStatus } = await processAskRepoguideTokens(stream);
    assert.equal(gateStatus.outcome, 'block');
    assert.ok(answer.startsWith('I found relevant code but could not verify'));
    assert.ok(!answer.includes('__type'));
});

test('no gateStatus token at all (e.g. a hypothetical future MCP-only path) leaves gateStatus null, not a crash', async () => {
    const stream = tokens(['Just a plain answer with no side-band tokens at all.']);
    const { answer, gateStatus } = await processAskRepoguideTokens(stream);
    assert.equal(gateStatus, null);
    assert.equal(answer, 'Just a plain answer with no side-band tokens at all.');
});

test('healthCaveat/answerProvenance/shadowContext are still dropped from the answer (pre-existing filters, must not regress)', async () => {
    const stream = tokens([
        JSON.stringify({ __type: 'healthCaveat', caveat: 'Index may be stale.' }),
        JSON.stringify({ __type: 'answerProvenance', provenance: { claims: [] } }),
        JSON.stringify({ __type: 'shadowContext', context: { retrievedChunkIds: [] } }),
        'The real answer text.'
    ]);
    const { answer } = await processAskRepoguideTokens(stream);
    assert.equal(answer, 'The real answer text.');
});

test('answerMetadata is parsed and returned, and file_references remain reachable for citation merging', async () => {
    const stream = tokens([
        JSON.stringify({ __type: 'answerMetadata', metadata: { schema: 'repoguide.answer_metadata.v1', mode: 'evidence', question: 'q', file_references: [{ file: 'src/a.py', line_start: 1, line_end: 2, reason: 'Fact match: a', source: 'retrieval' }] } }),
        'Answer text.'
    ]);
    const { metadata } = await processAskRepoguideTokens(stream);
    assert.equal(metadata.metadata.file_references[0].file, 'src/a.py');
});

test('a malformed gateStatus/answerMetadata token is dropped from the answer, not left as raw JSON, and does not throw', async () => {
    const stream = tokens([
        '{"__type":"gateStatus", not valid json',
        '{"__type":"answerMetadata", also not valid',
        'The real answer survives.'
    ]);
    const { answer, gateStatus, metadata } = await processAskRepoguideTokens(stream);
    assert.equal(gateStatus, null);
    assert.equal(metadata, null);
    assert.equal(answer, 'The real answer survives.');
});
