import test from 'node:test';
import * as assert from 'node:assert/strict';
import { rankAndCapCitations, MCP_CITATION_CAP, McpCitation } from '../../mcp/citationRanker';

// Live-tested finding this fixes: ask_repoguide's citations included dozens
// of single-line "Fact match: <generic word>" hits in files unrelated to the
// question -- queryDispatcher.ts's emitFinalAnswer (shared with chat) maps
// every fact in the packet into file_references uncapped and unranked.
// rankAndCapCitations is the MCP-only post-processing step that ranks
// citations actually referenced in the final answer text first, then caps.

function citation(overrides: Partial<McpCitation>): McpCitation {
    return { file: 'src/a.ts', ...overrides };
}

test('a citation whose display marker literally appears in the answer text ranks before one that does not', () => {
    const answer = 'The function does X. See [src/mentioned.ts:10] for details.';
    const citations = [
        citation({ file: 'src/unrelated.ts', symbol: 'unrelatedFn' }),
        citation({ file: 'src/mentioned.ts', display: '[src/mentioned.ts:10]' })
    ];
    const ranked = rankAndCapCitations(citations, answer, 25);
    assert.equal(ranked[0].file, 'src/mentioned.ts');
    assert.equal(ranked[1].file, 'src/unrelated.ts');
});

test('a citation whose symbol appears in the answer text ranks before one whose symbol does not', () => {
    const answer = 'This is handled by calculateTotal internally.';
    const citations = [
        citation({ file: 'src/other.ts', symbol: 'unrelatedHelper' }),
        citation({ file: 'src/target.ts', symbol: 'calculateTotal' })
    ];
    const ranked = rankAndCapCitations(citations, answer, 25);
    assert.equal(ranked[0].file, 'src/target.ts');
    assert.equal(ranked[1].file, 'src/other.ts');
});

test('this is a string-containment check, not inference: a symbol that is merely similar (not an exact substring) does not rank first', () => {
    const answer = 'This uses the calculate function.';
    const citations = [
        citation({ file: 'src/close.ts', symbol: 'calculateTotalSum' }), // not a substring of the answer
        citation({ file: 'src/exact.ts', symbol: 'calculate' }) // literal substring
    ];
    const ranked = rankAndCapCitations(citations, answer, 25);
    assert.equal(ranked[0].file, 'src/exact.ts');
    assert.equal(ranked[1].file, 'src/close.ts');
});

test('order within each partition (mentioned, then unmentioned) is stable -- original relative order preserved', () => {
    const answer = 'Nothing from these citations is mentioned here.';
    const citations = [
        citation({ file: 'first.ts' }),
        citation({ file: 'second.ts' }),
        citation({ file: 'third.ts' })
    ];
    const ranked = rankAndCapCitations(citations, answer, 25);
    assert.deepEqual(ranked.map(c => c.file), ['first.ts', 'second.ts', 'third.ts']);
});

test('caps to the given limit, keeping mentioned citations over unmentioned ones when truncating', () => {
    const answer = 'mentionedSymbol appears right here.';
    const citations = [
        citation({ file: 'unrelated1.ts', symbol: 'nope1' }),
        citation({ file: 'unrelated2.ts', symbol: 'nope2' }),
        citation({ file: 'real.ts', symbol: 'mentionedSymbol' })
    ];
    const ranked = rankAndCapCitations(citations, answer, 2);
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].file, 'real.ts');
});

test('default cap is MCP_CITATION_CAP (25) when no explicit cap is passed', () => {
    const answer = 'no matches here';
    const citations = Array.from({ length: 40 }, (_, i) => citation({ file: `f${i}.ts` }));
    const ranked = rankAndCapCitations(citations, answer);
    assert.equal(ranked.length, MCP_CITATION_CAP);
});

test('a citation with neither symbol nor display is treated as unmentioned, never throws', () => {
    const citations = [citation({ file: 'bare.ts', symbol: undefined, display: undefined })];
    const ranked = rankAndCapCitations(citations, 'any answer text', 25);
    assert.equal(ranked.length, 1);
});

test('empty citations array returns empty, no error', () => {
    assert.deepEqual(rankAndCapCitations([], 'some answer', 25), []);
});

test('fewer citations than the cap returns all of them unchanged (aside from mentioned-first ordering)', () => {
    const citations = [citation({ file: 'only.ts' })];
    const ranked = rankAndCapCitations(citations, 'irrelevant', 25);
    assert.equal(ranked.length, 1);
});
