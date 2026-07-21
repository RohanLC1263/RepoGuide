import test from 'node:test';
import * as assert from 'node:assert/strict';
import { ProgramGraphBuilder } from '../graph/programGraphBuilder';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { FactStore } from '../store/factStore';
import { LogicalUnit } from '../indexing/logicalUnitTypes';
import { FactRecord } from '../indexing/factTypes';

test('Program Graph Builder', async () => {
    const mockUnits: LogicalUnit[] = [
        {
            id: 'u1',
            type: 'function',
            symbol: 'fetchData',
            filePath: 'src/api.ts',
            language: 'typescript',
            startLine: 1,
            endLine: 5,
            content: 'function fetchData() { return axios.get(); }',
            role: 'implementation',
            parseStatus: 'complete',
            extractionMethod: 'tree_sitter',
            metadata: { confidence: 'high' }
        },
        {
            id: 'u2',
            type: 'function',
            symbol: 'getData',
            filePath: 'src/api.ts',
            language: 'typescript',
            startLine: 10,
            endLine: 15,
            content: 'function getData() { return fetchData(); }',
            role: 'implementation',
            parseStatus: 'complete',
            extractionMethod: 'tree_sitter',
            metadata: { confidence: 'high' }
        }
    ];

    const mockFacts: FactRecord[] = [
        {
            factId: 'f1',
            filePath: 'src/api.ts',
            unitId: 'u2',
            symbol: 'fetchData',
            factType: 'call_site',
            value: 'fetchData',
            valueKind: 'string',
            startLine: 11,
            endLine: 11,
            extractionMethod: 'tree_sitter',
            confidence: 'high',
            sourceText: 'fetchData',
            role: 'implementation'
        }
    ];

    const mockUnitStore = {
        listIndexes: async () => mockUnits.map(u => ({
            id: u.id, type: u.type, symbol: u.symbol, filePath: u.filePath,
            language: u.language, startLine: u.startLine, endLine: u.endLine, role: u.role, parseStatus: u.parseStatus
        })),
        getUnit: async (id: string) => mockUnits.find(u => u.id === id)
    } as unknown as LogicalUnitStore;

    const mockFactStore = {
        findByType: async (type: string) => mockFacts.filter(f => f.factType === type)
    } as unknown as FactStore;

    const builder = new ProgramGraphBuilder();
    const graph = await builder.build(mockUnitStore, mockFactStore, '/repo');

    assert.ok(graph.nodes['u1']);
    assert.ok(graph.nodes['u2']);
    assert.ok(graph.nodes['file::src/api.ts']);

    const callEdges = graph.edges.filter(e => e.type === 'calls');
    assert.equal(callEdges.length, 1);
    assert.equal(callEdges[0].from, 'u2');
    assert.equal(callEdges[0].to, 'u1');

    const containsEdges = graph.edges.filter(e => e.type === 'contains');
    assert.equal(containsEdges.length, 2);
    assert.equal(containsEdges[0].from, 'file::src/api.ts');
    assert.equal(containsEdges[0].to, 'u1');
    assert.equal(containsEdges[1].from, 'file::src/api.ts');
    assert.equal(containsEdges[1].to, 'u2');
});

test('instantiation edges resolve on the class name, not the LHS variable', async () => {
    // Class definitions (targets that instantiation should resolve to).
    const units: LogicalUnit[] = [
        {
            id: 'cls::StoryGenerationAgent', type: 'class', symbol: 'StoryGenerationAgent',
            filePath: 'app/agents/story_generation_agent.py', language: 'python', startLine: 25, endLine: 200,
            content: 'class StoryGenerationAgent: ...', role: 'implementation', parseStatus: 'complete',
            extractionMethod: 'tree_sitter', metadata: { confidence: 'high' }
        },
        {
            id: 'cls::RAGRetrieverAgent', type: 'class', symbol: 'RAGRetrieverAgent',
            filePath: 'app/agents/rag_retriever_agent.py', language: 'python', startLine: 12, endLine: 90,
            content: 'class RAGRetrieverAgent: ...', role: 'implementation', parseStatus: 'complete',
            extractionMethod: 'tree_sitter', metadata: { confidence: 'high' }
        },
        {
            id: 'cls::FactStore', type: 'class', symbol: 'FactStore',
            filePath: 'src/store/factStore.ts', language: 'typescript', startLine: 7, endLine: 260,
            content: 'export class FactStore { ... }', role: 'implementation', parseStatus: 'complete',
            extractionMethod: 'tree_sitter', metadata: { confidence: 'high' }
        },
        // Enclosing scope that performs the instantiations (the edge source).
        {
            id: 'fn::lifespan', type: 'function', symbol: 'lifespan',
            filePath: 'app/main.py', language: 'python', startLine: 58, endLine: 140,
            content: 'story = StoryGenerationAgent(); rag = RAGRetrieverAgent(); app = FastAPI()',
            role: 'implementation', parseStatus: 'complete', extractionMethod: 'tree_sitter',
            metadata: { confidence: 'high' }
        }
    ];

    // Instantiation facts have valueKind 'ast_node': fact.value is the object,
    // fact.symbol is the LHS variable name (role-named, NOT the class name).
    const inst = (symbol: string, instantiatedClass: string, line: number): FactRecord => ({
        factId: `inst::${symbol}`, filePath: 'app/main.py', unitId: 'fn::lifespan', symbol,
        factType: 'instantiation', value: { instantiatedClass, args: [] } as unknown as FactRecord['value'],
        valueKind: 'ast_node', startLine: line, endLine: line, extractionMethod: 'tree_sitter',
        confidence: 'high', sourceText: `${symbol} = ${instantiatedClass}()`, role: 'implementation'
    });
    const facts: FactRecord[] = [
        inst('story', 'StoryGenerationAgent', 98),   // role-named var != class
        inst('rag', 'RAGRetrieverAgent', 97),        // role-named var != class
        inst('factStore', 'FactStore', 99),          // name-collision var == class (must still work)
        inst('app', 'FastAPI', 147)                  // external/stdlib, no class node -> no edge
    ];

    const unitStore = {
        listIndexes: async () => units.map(u => ({
            id: u.id, type: u.type, symbol: u.symbol, filePath: u.filePath,
            language: u.language, startLine: u.startLine, endLine: u.endLine, role: u.role, parseStatus: u.parseStatus
        })),
        getUnit: async (id: string) => units.find(u => u.id === id)
    } as unknown as LogicalUnitStore;
    const factStore = {
        findByType: async (type: string) => facts.filter(f => f.factType === type)
    } as unknown as FactStore;

    const graph = await new ProgramGraphBuilder().build(unitStore, factStore, '/repo');
    const instEdges = graph.edges.filter(e => e.type === 'instantiates');

    const targets = instEdges.map(e => e.to).sort();
    // Role-named vars now resolve to the real class nodes (the reported bug).
    assert.ok(targets.includes('cls::StoryGenerationAgent'), 'story = StoryGenerationAgent() must link to the class');
    assert.ok(targets.includes('cls::RAGRetrieverAgent'), 'rag = RAGRetrieverAgent() must link to the class');
    // Name-collision case must still resolve (no regression).
    assert.ok(targets.includes('cls::FactStore'), 'factStore = FactStore() must still link to the class');
    // Every instantiation edge originates from the enclosing scope.
    assert.ok(instEdges.every(e => e.from === 'fn::lifespan'));
    // External/stdlib class has no node -> must produce NO edge (not a false one).
    assert.ok(!instEdges.some(e => graph.nodes[e.to]?.symbol === 'FastAPI'), 'FastAPI must not produce an edge');
    assert.equal(instEdges.length, 3, 'exactly the 3 resolvable classes, no stray edges');
    // LHS variable is preserved as metadata, not lost.
    const storyEdge = instEdges.find(e => e.to === 'cls::StoryGenerationAgent')!;
    assert.equal(storyEdge.metadata?.assignedTo, 'story');
    assert.equal(storyEdge.metadata?.className, 'StoryGenerationAgent');
});
