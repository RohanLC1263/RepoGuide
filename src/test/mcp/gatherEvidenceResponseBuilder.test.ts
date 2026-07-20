import test from 'node:test';
import * as assert from 'node:assert/strict';
import { buildGatherEvidenceResponse, GATHER_EVIDENCE_MAX_PER_KIND, GATHER_FULL_CONTENT_ITEMS, GATHER_FULL_CONTENT_CAP, GATHER_POINTER_CONTENT_CAP } from '../../mcp/gatherEvidenceResponseBuilder';
import { EvidencePacket, EvidenceItem } from '../../query/evidencePacket';

function item(over: Partial<EvidenceItem>): EvidenceItem {
    return {
        id: 'i1', file: 'src/x.ts', startLine: 1, endLine: 2, role: 'implementation' as any,
        type: 'function', content: 'code', retrieval_signal: 'lance_store', score: 0.9,
        confidence: 1, extractionMethod: 'tree_sitter', ...over
    };
}
function packet(over: Partial<EvidencePacket>): EvidencePacket {
    return {
        query: 'q', plan: {} as any, items: [], facts: [], coverage: [], gaps: [],
        diagnostics: [], coverageScore: 0.8, matchedEvidenceTypes: [], ...over
    };
}

test('splits deterministic facts from retrieved code context, keeps citations + retrieval_signal', () => {
    const p = packet({
        facts: [item({ id: 'f1', type: 'numeric_threshold', content: 'DEBOUNCE_MS = 1000', retrieval_signal: 'fact_store', extractionMethod: 'ast_query', file: 'src/w.ts', startLine: 39, endLine: 39 })],
        items: [item({ id: 'c1', type: 'function', content: 'function walk() {}', retrieval_signal: 'program_graph', file: 'src/g.ts', startLine: 10, endLine: 20 })]
    });
    const r = buildGatherEvidenceResponse(p);
    assert.equal(r.deterministic_facts.length, 1);
    assert.equal(r.retrieved_code_context.length, 1);
    assert.equal(r.deterministic_facts[0].file, 'src/w.ts');
    assert.equal(r.deterministic_facts[0].retrieval_signal, 'fact_store');
    assert.equal(r.deterministic_facts[0].extractionMethod, 'ast_query');
    assert.equal(r.retrieved_code_context[0].retrieval_signal, 'program_graph');
    assert.equal(r.retrieved_code_context[0].startLine, 10);
});

test('contains NO prose conclusion field -- only organized material + guidance + coverage', () => {
    const r = buildGatherEvidenceResponse(packet({ facts: [item({})], items: [item({})] }));
    const keys = Object.keys(r);
    assert.deepEqual(keys.sort(), ['coverage', 'deterministic_facts', 'guidance', 'query', 'retrieved_code_context']);
    assert.ok(!/the answer is|therefore/i.test(JSON.stringify(r.coverage)));
    assert.match(r.guidance, /RepoGuide did NOT synthesize a conclusion/);
});

test('coverage.sparse true when evidence is thin', () => {
    const thin = buildGatherEvidenceResponse(packet({ facts: [item({})], items: [], coverageScore: 0.1 }));
    assert.equal(thin.coverage.sparse, true);
    assert.match(thin.coverage.note, /THIN/);
    const rich = buildGatherEvidenceResponse(packet({ facts: [item({ id: 'a' }), item({ id: 'b' })], items: [item({ id: 'c' }), item({ id: 'd' })], coverageScore: 0.8 }));
    assert.equal(rich.coverage.sparse, false);
});

test('tiered content: top-ranked items get near-full content, long tail is pointer-only', () => {
    const big = 'X'.repeat(15000); // e.g. a 1164-line activate()
    const items = Array.from({ length: 10 }, (_, i) => item({ id: 'c' + i, content: big }));
    const r = buildGatherEvidenceResponse(packet({ items }));
    // top item: kept up to the full cap (much more than the old 1500), with a Read pointer.
    const top = r.retrieved_code_context[0];
    assert.ok(top.content.length > 1500, 'top item must exceed the old 1500 cap');
    assert.ok(top.content.length >= GATHER_FULL_CONTENT_CAP, 'top item keeps up to the full cap');
    assert.match(top.content, /Read src\/x\.ts:1-2 for the full content/);
    // long-tail item (index >= GATHER_FULL_CONTENT_ITEMS): pointer-only.
    const tail = r.retrieved_code_context[GATHER_FULL_CONTENT_ITEMS];
    assert.ok(tail.content.length < 1000, 'tail item is pointer-only (small)');
    assert.ok(tail.content.startsWith('X'.repeat(GATHER_POINTER_CONTENT_CAP)));
});
test('small top-ranked content is returned whole (no truncation note)', () => {
    const r = buildGatherEvidenceResponse(packet({ items: [item({ content: 'function f(){ return 1; }' })] }));
    assert.equal(r.retrieved_code_context[0].content, 'function f(){ return 1; }');
    assert.doesNotMatch(r.retrieved_code_context[0].content, /truncated/);
});
test('caps each kind at GATHER_EVIDENCE_MAX_PER_KIND but reports the true found count', () => {
    const many = Array.from({ length: 40 }, (_, i) => item({ id: 'x' + i }));
    const r = buildGatherEvidenceResponse(packet({ facts: many, items: many }));
    assert.equal(r.deterministic_facts.length, GATHER_EVIDENCE_MAX_PER_KIND);
    assert.equal(r.coverage.deterministicFactsFound, 40);
    assert.equal(r.coverage.codeContextReturned, GATHER_EVIDENCE_MAX_PER_KIND);
    assert.equal(r.coverage.codeContextFound, 40);
});
