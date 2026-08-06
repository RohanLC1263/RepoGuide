import test from 'node:test';
import * as assert from 'node:assert/strict';
import { EvidenceAnswerSynthesizer } from '../../query/evidenceAnswerSynthesizer';
import { EvidencePacket } from '../../query/evidencePacket';

/**
 * P1-3 / P1-4. Both defects were the same shape: an AbortSignal that is declared, passed,
 * type-checked -- and then dropped at the last hop, where `synthesize` and
 * `synthesizeExplainSelection` hard-coded `undefined` into a `streamSynthesize` call that
 * accepts and correctly forwards a signal when given one. Everything compiled and read
 * correctly; Stop simply aborted a controller nobody was listening to.
 *
 * A test that only asserts "an aborted signal throws" would have passed against the broken
 * code, because the generator loop can observe the flag on its own. So this asserts the
 * thing that was actually wrong: that the signal INSTANCE reaches the transport call.
 * `streamSynthesize` is overridden to capture what it is handed, which is the exact seam
 * the bug lived at.
 */

function stubContext(): any {
    return {
        workspaceRoot: '/fake',
        getConfig: (_k: string, d?: unknown) => d,
        logger: { appendLine: () => undefined }
    };
}

function emptyPacket(): EvidencePacket {
    return {
        query: 'q', plan: {} as any, items: [], facts: [], coverage: [], gaps: [],
        diagnostics: [], coverageScore: 0, matchedEvidenceTypes: []
    } as unknown as EvidencePacket;
}

/** Captures the signal each streaming entry point is handed. */
class CapturingSynthesizer extends EvidenceAnswerSynthesizer {
    seen: Array<AbortSignal | undefined> = [];

    async *streamSynthesize(_p: EvidencePacket, _m?: string, signal?: AbortSignal): AsyncGenerator<string> {
        this.seen.push(signal);
        yield 'answer';
    }

    async *streamSynthesizeExplainSelection(_p: EvidencePacket, _m?: string, signal?: AbortSignal): AsyncGenerator<string> {
        this.seen.push(signal);
        yield 'explanation';
    }
}

test('synthesize forwards its AbortSignal to streamSynthesize (P1-3)', async () => {
    const s = new CapturingSynthesizer(stubContext());
    const controller = new AbortController();

    const answer = await s.synthesize(emptyPacket(), 'model', [], controller.signal);

    assert.equal(answer, 'answer');
    assert.equal(s.seen.length, 1);
    assert.equal(
        s.seen[0], controller.signal,
        'the SAME signal instance must reach the transport call -- the bug was a hard-coded undefined here'
    );
});

test('synthesizeExplainSelection forwards its AbortSignal (P1-4)', async () => {
    const s = new CapturingSynthesizer(stubContext());
    const controller = new AbortController();

    const answer = await s.synthesizeExplainSelection(emptyPacket(), 'model', [], controller.signal);

    assert.equal(answer, 'explanation');
    assert.equal(s.seen.length, 1);
    assert.equal(s.seen[0], controller.signal, 'explain path had the identical hard-coded undefined');
});

test('both entry points still work with no signal (callers that never cancel)', async () => {
    const s = new CapturingSynthesizer(stubContext());

    await s.synthesize(emptyPacket(), 'model');
    await s.synthesizeExplainSelection(emptyPacket(), 'model');

    assert.deepEqual(s.seen, [undefined, undefined], 'signal stays optional; no caller is forced to supply one');
});

/**
 * The sidebar's controller-ownership rule, extracted as a pure model. The original code
 * assigned into a single shared field and cleared it unconditionally in `finally`, so a
 * second question overwrote the slot and then the FIRST request's finally cleared the
 * SECOND's controller -- leaving the live generation with nothing able to cancel it.
 */
class SupersedingSlot {
    active: AbortController | null = null;

    start(): AbortController {
        this.active?.abort();          // supersede whatever is still running
        const mine = new AbortController();
        this.active = mine;
        return mine;
    }

    finish(mine: AbortController): void {
        if (this.active === mine) { this.active = null; }   // only clear while still the occupant
    }

    cancel(): void {
        this.active?.abort();
        this.active = null;
    }
}

test('a second question supersedes the first rather than orphaning it', () => {
    const slot = new SupersedingSlot();

    const first = slot.start();
    const second = slot.start();

    assert.equal(first.signal.aborted, true, 'starting a second question must abort the first');
    assert.equal(second.signal.aborted, false);
    assert.equal(slot.active, second);
});

test('REGRESSION GUARD: a finishing request never clears a newer request\'s controller', () => {
    const slot = new SupersedingSlot();

    const first = slot.start();
    const second = slot.start();
    slot.finish(first);   // the superseded request's finally block runs late

    assert.equal(slot.active, second, 'the newer controller must survive the older one finishing');

    slot.cancel();
    assert.equal(second.signal.aborted, true, 'and Stop must still be able to cancel it');
});

test('a request that finishes while still current clears the slot', () => {
    const slot = new SupersedingSlot();
    const only = slot.start();

    slot.finish(only);

    assert.equal(slot.active, null, 'no stale controller left behind for the next Stop press to abort');
});
