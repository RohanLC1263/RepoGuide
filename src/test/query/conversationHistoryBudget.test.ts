import test from 'node:test';
import * as assert from 'node:assert/strict';
import { ConversationHistory } from '../../query/conversationHistory';
import { buildEvidenceMessages } from '../../prompts/evidencePrompt';
import { EvidencePacket } from '../../query/evidencePacket';

/**
 * The retained conversation window is subtracted from the evidence budget in
 * buildEvidenceMessages(), so its size directly controls how much repository
 * evidence reaches the model. Before the character cap it was bounded only by
 * message count, and grew to a measured 38.2% of the evidence budget over a
 * 38-question session -- enough to flip six of eight characterised questions'
 * gate outcomes on session depth alone.
 */

const LONG_ANSWER = 'x'.repeat(2500); // representative: real answers ran 1.2k-4.6k chars

function windowChars(h: ConversationHistory): number {
    return h.getMessages().reduce((sum, m) => sum + m.content.length + 20, 0);
}

test('window stays under the character cap no matter how long the session runs', () => {
    const h = new ConversationHistory();
    for (let i = 0; i < 40; i++) {
        h.add('user', `question number ${i}`);
        h.add('assistant', LONG_ANSWER);
        assert.ok(windowChars(h) <= 4000, `window grew to ${windowChars(h)} chars after ${i + 1} exchanges`);
    }
});

test('the pre-fix failure mode is genuinely gone: 20 long exchanges used to exceed 38k chars', () => {
    const h = new ConversationHistory();
    for (let i = 0; i < 20; i++) {
        h.add('user', `q${i}`);
        h.add('assistant', LONG_ANSWER);
    }
    // Pre-fix this held the last 10 messages unconditionally: ~5 x (2500 + 20) + framing.
    assert.ok(windowChars(h) < 4000, `window is ${windowChars(h)} chars`);
    assert.ok(h.getMessages().length >= 1, 'window must never be emptied');
});

test('short exchanges are untouched -- the cap only binds on genuinely large windows', () => {
    const h = new ConversationHistory();
    for (let i = 0; i < 4; i++) {
        h.add('user', `where is thing ${i} defined`);
        h.add('assistant', `It is defined in file_${i}.py.`);
    }
    assert.equal(h.getMessages().length, 8, 'ordinary short follow-up context must survive intact');
});

test('the message cap still applies independently of the character cap', () => {
    const h = new ConversationHistory();
    for (let i = 0; i < 30; i++) {
        h.add('user', `q${i}`); // tiny messages: char cap never binds
    }
    assert.equal(h.getMessages().length, 10, 'MAX_MESSAGES must still bound a window of tiny messages');
});

test('a single oversized message is retained rather than emptying the window', () => {
    const h = new ConversationHistory();
    h.add('assistant', 'y'.repeat(20000));
    assert.equal(h.getMessages().length, 1, 'follow-up resolution must not be silently disabled');
});

test('the newest turns are the ones kept (oldest-first eviction)', () => {
    const h = new ConversationHistory();
    h.add('assistant', 'OLDEST' + 'a'.repeat(2000));
    h.add('assistant', 'MIDDLE' + 'b'.repeat(2000));
    h.add('assistant', 'NEWEST' + 'c'.repeat(1000));
    const kept = h.getMessages().map(m => m.content.slice(0, 6));
    assert.ok(kept.includes('NEWEST'), 'the most recent turn is what a follow-up refers to');
    assert.ok(!kept.includes('OLDEST'), 'the oldest turn should be evicted first');
});

// --- The property that actually matters: evidence budget stability -------------

function packet(): EvidencePacket {
    return {
        query: 'where is the seal-mission endpoint',
        plan: { confidence_mode: 'grounded', requiredEvidence: [] } as never,
        // Deliberately oversized: the packet must exceed the evidence budget, or the
        // packer fits everything and the comparison passes without testing anything.
        items: Array.from({ length: 120 }, (_, i) => ({
            id: `i${i}`, file: `app/routers/file_${i}.py`, startLine: 1, endLine: 200,
            role: 'implementation' as never, type: 'function',
            content: `def handler_${i}():\n` + `    do_something_useful()\n`.repeat(60),
            retrieval_signal: 'lance_store', score: 0.9, confidence: 1,
            extractionMethod: 'tree_sitter' as never
        })),
        facts: [], coverage: [], gaps: [], diagnostics: [], coverageScore: 0, matchedEvidenceTypes: []
    };
}

test('a deep session can no longer starve the evidence budget', () => {
    const empty = new ConversationHistory();
    const deep = new ConversationHistory();
    for (let i = 0; i < 20; i++) {
        deep.add('user', `question ${i}`);
        deep.add('assistant', LONG_ANSWER);
    }

    const countEvidenceItems = (h: ConversationHistory): number => {
        const system = buildEvidenceMessages(packet(), h.getMessages())[0].content;
        return (system.match(/\[id: i\d+\]/g) ?? []).length;
    };

    const fresh = countEvidenceItems(empty);
    const aged = countEvidenceItems(deep);
    assert.ok(fresh > 0, 'sanity: the fresh session must pack some evidence');
    // Pre-fix the deep window consumed ~13k of a ~42.6k budget. The cap holds the
    // shortfall to a small fraction rather than a third of the packet.
    assert.ok(
        aged >= fresh * 0.9,
        `deep session packed ${aged} evidence items vs ${fresh} fresh -- history is still starving the budget`
    );
});
