import test from 'node:test';
import * as assert from 'node:assert/strict';
import { buildGatherEvidenceResponse, GATHER_EVIDENCE_MAX_PER_KIND } from '../../mcp/gatherEvidenceResponseBuilder';
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

test('caps each kind at GATHER_EVIDENCE_MAX_PER_KIND but reports the true found count', () => {
    const many = Array.from({ length: 40 }, (_, i) => item({ id: 'x' + i }));
    const r = buildGatherEvidenceResponse(packet({ facts: many, items: many }));
    assert.equal(r.deterministic_facts.length, GATHER_EVIDENCE_MAX_PER_KIND);
    assert.equal(r.coverage.deterministicFactsFound, 40);
    assert.equal(r.coverage.codeContextReturned, GATHER_EVIDENCE_MAX_PER_KIND);
    assert.equal(r.coverage.codeContextFound, 40);
});
