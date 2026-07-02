import { expect, test, describe, beforeEach } from '@jest/globals';
import { ProgramGraphStore } from '../store/programGraphStore';
import { TransitiveGraphWalker } from './transitiveGraphWalker';
import { ProgramGraphEdgeType, ProgramGraphNode } from '../graph/programGraphTypes';

describe('TransitiveGraphWalker', () => {
    let store: ProgramGraphStore;
    let walker: TransitiveGraphWalker;

    beforeEach(() => {
        store = new ProgramGraphStore();
        // We mock the internal structure of ProgramGraphStore directly
        (store as any).graph = {
            nodes: {},
            edges: []
        };
        (store as any).inEdges = new Map();
        (store as any).outEdges = new Map();
        (store as any).symbolToNodes = new Map();
        (store as any).isLoaded = () => true;
        
        // Mock getNode to just return from graph.nodes
        store.getNode = (id: string) => (store as any).graph.nodes[id];
        
        walker = new TransitiveGraphWalker(store);
    });

    function addNode(id: string, symbol: string = id) {
        (store as any).graph.nodes[id] = { id, symbol, type: 'function', filePath: 'dummy.ts' } as unknown as ProgramGraphNode;
        (store as any).symbolToNodes.set(symbol.toLowerCase(), [id]);
    }

    function addEdge(from: string, to: string, type: ProgramGraphEdgeType) {
        const edge = { from, to, type, weight: 1.0 };
        (store as any).graph.edges.push(edge);
        
        if (!(store as any).inEdges.has(to)) (store as any).inEdges.set(to, []);
        if (!(store as any).outEdges.has(from)) (store as any).outEdges.set(from, []);
        
        (store as any).inEdges.get(to).push(edge);
        (store as any).outEdges.get(from).push(edge);
    }

    test('getTransitiveDependents: A -> B -> C should return B and C when querying dependents of A', () => {
        addNode('A');
        addNode('B');
        addNode('C');
        
        // A is called by B, B is called by C
        addEdge('B', 'A', 'calls'); // B depends on A
        addEdge('C', 'B', 'calls'); // C depends on B
        
        const result = walker.getTransitiveDependents('A');
        expect(result.rootNodeId).toBe('A');
        expect(result.reachableNodes.length).toBe(2);
        
        const b = result.reachableNodes.find(n => n.nodeId === 'B');
        const c = result.reachableNodes.find(n => n.nodeId === 'C');
        
        expect(b).toBeDefined();
        expect(b!.depth).toBe(1);
        expect(b!.shortestPath).toEqual(['A', 'B']);
        expect(b!.incomingEdgeType).toBe('calls');

        expect(c).toBeDefined();
        expect(c!.depth).toBe(2);
        expect(c!.shortestPath).toEqual(['A', 'B', 'C']);
        expect(c!.incomingEdgeType).toBe('calls');
    });

    test('getTransitiveDependencies: A -> B -> C should return B and A when querying dependencies of C', () => {
        addNode('A');
        addNode('B');
        addNode('C');
        
        // C calls B, B calls A
        addEdge('C', 'B', 'calls'); // C depends on B
        addEdge('B', 'A', 'calls'); // B depends on A
        
        const result = walker.getTransitiveDependencies('C');
        expect(result.rootNodeId).toBe('C');
        expect(result.reachableNodes.length).toBe(2);
        
        const b = result.reachableNodes.find(n => n.nodeId === 'B');
        const a = result.reachableNodes.find(n => n.nodeId === 'A');
        
        expect(b).toBeDefined();
        expect(b!.depth).toBe(1);
        expect(b!.shortestPath).toEqual(['C', 'B']);
        
        expect(a).toBeDefined();
        expect(a!.depth).toBe(2);
        expect(a!.shortestPath).toEqual(['C', 'B', 'A']);
    });

    test('getBlastRadius: Includes assigns, calls, reads, instantiates, imports', () => {
        addNode('Root');
        addNode('A'); // calls
        addNode('B'); // reads
        addNode('C'); // instantiates
        addNode('D'); // imports
        addNode('E'); // assigns
        addNode('Ignored'); // contains
        
        addEdge('A', 'Root', 'calls');
        addEdge('B', 'Root', 'reads');
        addEdge('C', 'Root', 'instantiates');
        addEdge('D', 'Root', 'imports');
        addEdge('E', 'Root', 'assigns');
        addEdge('Ignored', 'Root', 'contains');
        
        const result = walker.getBlastRadius('Root');
        expect(result.reachableNodes.length).toBe(5);
        
        const ids = result.reachableNodes.map(n => n.nodeId).sort();
        expect(ids).toEqual(['A', 'B', 'C', 'D', 'E']);
    });

    test('Cycle A -> B -> C -> A should terminate correctly', () => {
        addNode('A');
        addNode('B');
        addNode('C');

        // B depends on A
        addEdge('B', 'A', 'calls');
        // C depends on B
        addEdge('C', 'B', 'imports');
        // A depends on C (Cycle)
        addEdge('A', 'C', 'calls');

        const result = walker.getTransitiveDependents('A');
        expect(result.reachableNodes.length).toBe(2);
        const ids = result.reachableNodes.map(n => n.nodeId).sort();
        expect(ids).toEqual(['B', 'C']);
    });

    test('Should ignore unsupported edge types like contains and fallback_to', () => {
        addNode('A');
        addNode('B');
        addNode('C');

        addEdge('B', 'A', 'contains'); // B contains A (ignored)
        addEdge('C', 'A', 'calls'); // C calls A (included)

        const result = walker.getTransitiveDependents('A');
        expect(result.reachableNodes.length).toBe(1);
        expect(result.reachableNodes[0].nodeId).toBe('C');
    });

    test('Symbol resolution should find correct node', () => {
        addNode('uuid-1234', 'ProgramGraphStore');
        addNode('B');

        addEdge('B', 'uuid-1234', 'instantiates'); // B depends on ProgramGraphStore

        // The user should be able to pass 'ProgramGraphStore' as the symbol
        const result = walker.getTransitiveDependents('ProgramGraphStore');
        expect(result.rootNodeId).toBe('uuid-1234');
        expect(result.reachableNodes.length).toBe(1);
        expect(result.reachableNodes[0].nodeId).toBe('B');
    });
});
