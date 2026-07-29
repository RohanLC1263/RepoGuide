import test from 'node:test';
import * as assert from 'node:assert/strict';
import { resetOllamaModelState } from '../../ollama/modelStateReset';

/**
 * This is a determinism aid, so its own failure modes matter more than its happy path:
 * it must never be able to stop an answer being produced. Every test below is about
 * degrading rather than throwing.
 */

const MODEL = 'qwen2.5-coder:7b';

/** Minimal fetch double: `psSequence` is what /api/ps returns on successive polls. */
function fakeFetch(psSequence: Array<Array<{ model: string }>>, opts: { failUnload?: boolean; failPs?: boolean } = {}) {
    let psCall = 0;
    const calls: string[] = [];
    const impl = (async (url: string) => {
        calls.push(url);
        if (String(url).endsWith('/api/generate')) {
            if (opts.failUnload) { throw new Error('connection refused'); }
            return { ok: true, json: async () => ({}) };
        }
        if (opts.failPs) { throw new Error('ps exploded'); }
        const models = psSequence[Math.min(psCall++, psSequence.length - 1)];
        return { ok: true, json: async () => ({ models }) };
    }) as unknown as typeof fetch;
    return { impl, calls };
}

test('reports success once the model has actually left /api/ps', async () => {
    const { impl, calls } = fakeFetch([[{ model: MODEL }], [{ model: MODEL }], []]);
    const result = await resetOllamaModelState('http://x', MODEL, impl);
    assert.equal(result.reset, true);
    assert.ok(calls.some(c => c.endsWith('/api/generate')), 'must actually request the unload');
    assert.ok(calls.filter(c => c.endsWith('/api/ps')).length >= 3, 'must poll until the runner is gone, not trust the response');
});

test('an unrelated model still resident does not count as failure', async () => {
    const { impl } = fakeFetch([[{ model: 'some-other-model' }]]);
    const result = await resetOllamaModelState('http://x', MODEL, impl);
    assert.equal(result.reset, true);
});

test('a failed unload request degrades instead of throwing', async () => {
    const { impl } = fakeFetch([[]], { failUnload: true });
    const result = await resetOllamaModelState('http://x', MODEL, impl);
    assert.equal(result.reset, false);
    assert.match(result.reason ?? '', /unload request failed/);
});

test('a failed status poll degrades instead of throwing', async () => {
    const { impl } = fakeFetch([[]], { failPs: true });
    const result = await resetOllamaModelState('http://x', MODEL, impl);
    assert.equal(result.reset, false);
    assert.match(result.reason ?? '', /ps poll failed/);
});

test('never throws, whatever fetch does -- an answer must still be produced', async () => {
    const exploding = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    await assert.doesNotReject(() => resetOllamaModelState('http://x', MODEL, exploding));
});
