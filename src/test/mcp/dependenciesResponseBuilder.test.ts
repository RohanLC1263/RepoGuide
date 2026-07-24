import test from 'node:test';
import * as assert from 'node:assert/strict';
import { buildDependenciesResponse } from '../../mcp/dependenciesResponseBuilder';
import { EvidenceItem, SemanticCategory } from '../../query/evidencePacket';

// Twin of dependentsResponseBuilder.test.ts, mirroring its exact pattern for
// the reverse (outbound) direction. get_dependencies' underlying retrieval
// returns a combined item set containing BOTH inbound (graph_*_dependency)
// and outbound (graph_*_target_dependency) signals -- these tests confirm
// buildDependenciesResponse filters to only the outbound ones, ignoring the
// inbound-relationship signals get_dependents' own builder cares about.

function item(overrides: Partial<EvidenceItem>): EvidenceItem {
    return {
        id: 'item_1',
        file: 'src/a.ts',
        startLine: 1,
        endLine: 1,
        role: 'implementation',
        type: 'graph_dependency',
        content: 'placeholder',
        retrieval_signal: 'graph_callee_dependency',
        semanticCategory: SemanticCategory.DEPENDENCY,
        score: 0.9,
        confidence: 0.9,
        extractionMethod: 'program_graph',
        ...overrides
    };
}

test('a callee item maps to relationship "callee" with its real file/symbol/line', () => {
    const items = [
        item({ id: 'i1', file: 'src/callee.ts', symbol: 'helperFn', startLine: 42, retrieval_signal: 'graph_callee_dependency' })
    ];
    const result = buildDependenciesResponse(items);
    assert.deepEqual(result.dependencies, [
        { file: 'src/callee.ts', symbol: 'helperFn', startLine: 42, relationship: 'callee' }
    ]);
});

test('each of the five real outbound graph relationship signals maps to its own distinct relationship label', () => {
    const items = [
        item({ id: 'i1', file: 'a.ts', retrieval_signal: 'graph_callee_dependency' }),
        item({ id: 'i2', file: 'b.ts', retrieval_signal: 'graph_read_target_dependency' }),
        item({ id: 'i3', file: 'c.ts', retrieval_signal: 'graph_import_target_dependency' }),
        item({ id: 'i4', file: 'd.ts', retrieval_signal: 'graph_instantiation_target_dependency' }),
        item({ id: 'i5', file: 'e.ts', retrieval_signal: 'graph_fallback_target_dependency' })
    ];
    const result = buildDependenciesResponse(items);
    const byFile = Object.fromEntries(result.dependencies.map(d => [d.file, d.relationship]));
    assert.deepEqual(byFile, {
        'a.ts': 'callee',
        'b.ts': 'read_target',
        'c.ts': 'import_target',
        'd.ts': 'instantiation_target',
        'e.ts': 'fallback_target'
    });
});

test('inbound (get_dependents-shaped) signals in the same item set are excluded -- get_dependencies only reports outbound relationships', () => {
    const items = [
        item({ id: 'i1', file: 'src/outbound.ts', retrieval_signal: 'graph_callee_dependency' }),
        item({ id: 'i2', file: 'src/inbound.ts', retrieval_signal: 'graph_caller_dependency' }),
        item({ id: 'i3', file: 'src/inbound2.ts', retrieval_signal: 'graph_reader_dependency' })
    ];
    const result = buildDependenciesResponse(items);
    assert.equal(result.dependencies.length, 1);
    assert.equal(result.dependencies[0].file, 'src/outbound.ts');
});

test('the same file appearing as both a callee and a read target produces two distinct dependency entries, not a deduped one', () => {
    const items = [
        item({ id: 'i1', file: 'src/both.ts', symbol: 'fnA', startLine: 10, retrieval_signal: 'graph_callee_dependency' }),
        item({ id: 'i2', file: 'src/both.ts', symbol: 'fnA', startLine: 25, retrieval_signal: 'graph_read_target_dependency' })
    ];
    const result = buildDependenciesResponse(items);
    assert.equal(result.dependencies.length, 2);
    assert.deepEqual(result.dependencies.map(d => d.relationship).sort(), ['callee', 'read_target']);
});

test('a graph_symbol_node item becomes matchedSymbol/sourceFile, not a dependency entry', () => {
    const items = [
        item({ id: 'sym', file: 'src/source.ts', symbol: 'sourceFn', retrieval_signal: 'graph_symbol_node' }),
        item({ id: 'dep', file: 'src/callee.ts', symbol: 'sourceFn', startLine: 5, retrieval_signal: 'graph_callee_dependency' })
    ];
    const result = buildDependenciesResponse(items);
    assert.equal(result.sourceFile, 'src/source.ts');
    assert.equal(result.matchedSymbol?.id, 'sym');
    assert.equal(result.dependencies.length, 1);
    assert.equal(result.dependencies[0].file, 'src/callee.ts');
});

test('an item with an unrecognized/unrelated retrieval_signal is excluded from dependencies', () => {
    const items = [
        item({ id: 'i1', file: 'src/unrelated.ts', retrieval_signal: 'some_other_signal' })
    ];
    const result = buildDependenciesResponse(items);
    assert.deepEqual(result.dependencies, []);
});

test('no items at all -> empty dependencies, undefined sourceFile/matchedSymbol, does not throw', () => {
    const result = buildDependenciesResponse([]);
    assert.deepEqual(result.dependencies, []);
    assert.equal(result.sourceFile, undefined);
    assert.equal(result.matchedSymbol, undefined);
});

test('a dependency item with no symbol still produces an entry with symbol left undefined, not dropped', () => {
    const items = [
        item({ id: 'i1', file: 'src/target.ts', symbol: undefined, startLine: 3, retrieval_signal: 'graph_import_target_dependency' })
    ];
    const result = buildDependenciesResponse(items);
    assert.equal(result.dependencies.length, 1);
    assert.equal(result.dependencies[0].symbol, undefined);
    assert.equal(result.dependencies[0].file, 'src/target.ts');
});

// --- Identity gate (requestedIdentifier) --------------------------------------
// Twin of the get_dependents identity-gate tests: a token-only mis-match must not
// be reported as the requested symbol's dependencies.

test('identity gate: a token-only mis-match returns found:false with no dependencies', () => {
    const items = [
        item({ id: 'sym', file: 'craft_classifier_agent/agent.py', symbol: 'agent', retrieval_signal: 'graph_symbol_node' }),
        item({ id: 'dep', file: 'app/deps.py', symbol: 'helper', startLine: 3, retrieval_signal: 'graph_callee_dependency' })
    ];
    const result = buildDependenciesResponse(items, 'InventorySyncAgent');
    assert.equal(result.found, false);
    assert.equal(result.matchedSymbol, undefined);
    assert.deepEqual(result.dependencies, []);
    assert.deepEqual(result.suggestions, [{ symbol: 'agent', file: 'craft_classifier_agent/agent.py' }]);
});

test('identity gate: an exact symbol match is honored and returns its real dependencies', () => {
    const items = [
        item({ id: 'sym', file: 'app/agents/story_generation_agent.py', symbol: 'StoryGenerationAgent', retrieval_signal: 'graph_symbol_node' }),
        item({ id: 'dep', file: 'app/agents/base_agent.py', symbol: 'BaseAgent', startLine: 1, retrieval_signal: 'graph_import_target_dependency' })
    ];
    const result = buildDependenciesResponse(items, 'StoryGenerationAgent');
    assert.equal(result.found, true);
    assert.equal(result.matchedSymbol?.id, 'sym');
    assert.equal(result.sourceFile, 'app/agents/story_generation_agent.py');
    assert.equal(result.dependencies.length, 1);
});

test('identity gate: the correct symbol node wins over a token-only node earlier in the list', () => {
    const items = [
        item({ id: 'fuzzy', file: 'craft_classifier_agent/agent.py', symbol: 'agent', retrieval_signal: 'graph_symbol_node' }),
        item({ id: 'real', file: 'app/agents/story_generation_agent.py', symbol: 'StoryGenerationAgent', retrieval_signal: 'graph_symbol_node' })
    ];
    const result = buildDependenciesResponse(items, 'StoryGenerationAgent');
    assert.equal(result.found, true);
    assert.equal(result.matchedSymbol?.id, 'real');
});
