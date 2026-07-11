import test from 'node:test';
import * as assert from 'node:assert/strict';
import { buildDependentsResponse } from '../../mcp/dependentsResponseBuilder';
import { EvidenceItem, SemanticCategory } from '../../query/evidencePacket';

// mcpServer.ts's get_dependents handler used to reduce this data down to a bare
// `dependentFiles: string[]` list -- discarding the symbol/line/relationship-kind
// detail ProgramGraphStore.getDependents() already computes. These tests exercise
// the extracted, side-effect-free response builder directly (mcpServer.ts can't
// be imported into a test process -- see askRepoguideTokenProcessor.test.ts).

function item(overrides: Partial<EvidenceItem>): EvidenceItem {
    return {
        id: 'item_1',
        file: 'src/a.ts',
        startLine: 1,
        endLine: 1,
        role: 'implementation',
        type: 'graph_dependency',
        content: 'placeholder',
        retrieval_signal: 'graph_caller_dependency',
        semanticCategory: SemanticCategory.DEPENDENCY,
        score: 0.9,
        confidence: 0.9,
        extractionMethod: 'program_graph',
        ...overrides
    };
}

test('a caller item maps to relationship "caller" with its real file/symbol/line', () => {
    const items = [
        item({ id: 'i1', file: 'src/caller.ts', symbol: 'doThing', startLine: 42, retrieval_signal: 'graph_caller_dependency' })
    ];
    const result = buildDependentsResponse(items);
    assert.deepEqual(result.dependents, [
        { file: 'src/caller.ts', symbol: 'doThing', startLine: 42, relationship: 'caller' }
    ]);
});

test('each of the five real graph relationship signals maps to its own distinct relationship label', () => {
    const items = [
        item({ id: 'i1', file: 'a.ts', retrieval_signal: 'graph_caller_dependency' }),
        item({ id: 'i2', file: 'b.ts', retrieval_signal: 'graph_reader_dependency' }),
        item({ id: 'i3', file: 'c.ts', retrieval_signal: 'graph_import_dependency' }),
        item({ id: 'i4', file: 'd.ts', retrieval_signal: 'graph_instantiation_dependency' }),
        item({ id: 'i5', file: 'e.ts', retrieval_signal: 'graph_fallback_dependency' })
    ];
    const result = buildDependentsResponse(items);
    const byFile = Object.fromEntries(result.dependents.map(d => [d.file, d.relationship]));
    assert.deepEqual(byFile, {
        'a.ts': 'caller',
        'b.ts': 'reader',
        'c.ts': 'importer',
        'd.ts': 'instantiator',
        'e.ts': 'fallback_consumer'
    });
});

test('the same file appearing as both a caller and a reader of the target produces two distinct dependent entries, not a deduped one', () => {
    // Real-world case the old flat dependentFiles: string[] shape collapsed away:
    // a file can legitimately both call AND read the same target symbol.
    const items = [
        item({ id: 'i1', file: 'src/both.ts', symbol: 'fnA', startLine: 10, retrieval_signal: 'graph_caller_dependency' }),
        item({ id: 'i2', file: 'src/both.ts', symbol: 'fnA', startLine: 25, retrieval_signal: 'graph_reader_dependency' })
    ];
    const result = buildDependentsResponse(items);
    assert.equal(result.dependents.length, 2);
    assert.deepEqual(result.dependents.map(d => d.relationship).sort(), ['caller', 'reader']);
});

test('a graph_symbol_node item becomes matchedSymbol/targetFile, not a dependent entry', () => {
    const items = [
        item({ id: 'sym', file: 'src/target.ts', symbol: 'targetFn', retrieval_signal: 'graph_symbol_node' }),
        item({ id: 'dep', file: 'src/caller.ts', symbol: 'targetFn', startLine: 5, retrieval_signal: 'graph_caller_dependency' })
    ];
    const result = buildDependentsResponse(items);
    assert.equal(result.targetFile, 'src/target.ts');
    assert.equal(result.matchedSymbol?.id, 'sym');
    assert.equal(result.dependents.length, 1);
    assert.equal(result.dependents[0].file, 'src/caller.ts');
});

test('an item with an unrecognized/unrelated retrieval_signal is excluded from dependents (only the five known relationship kinds count)', () => {
    const items = [
        item({ id: 'i1', file: 'src/unrelated.ts', retrieval_signal: 'some_other_signal' })
    ];
    const result = buildDependentsResponse(items);
    assert.deepEqual(result.dependents, []);
});

test('no items at all -> empty dependents, undefined targetFile/matchedSymbol, does not throw', () => {
    const result = buildDependentsResponse([]);
    assert.deepEqual(result.dependents, []);
    assert.equal(result.targetFile, undefined);
    assert.equal(result.matchedSymbol, undefined);
});

test('a dependent item with no symbol (e.g. an anonymous import) still produces an entry with symbol left undefined, not dropped', () => {
    const items = [
        item({ id: 'i1', file: 'src/importer.ts', symbol: undefined, startLine: 3, retrieval_signal: 'graph_import_dependency' })
    ];
    const result = buildDependentsResponse(items);
    assert.equal(result.dependents.length, 1);
    assert.equal(result.dependents[0].symbol, undefined);
    assert.equal(result.dependents[0].file, 'src/importer.ts');
});
