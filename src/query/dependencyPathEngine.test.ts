import { expect, test, describe, beforeEach } from '@jest/globals';
import { ProgramGraphStore } from '../store/programGraphStore';
import { DependencyPathEngine } from './dependencyPathEngine';
import { ProgramGraphEdgeType, ProgramGraphNode } from '../graph/programGraphTypes';

describe('DependencyPathEngine', () => {
    let store: ProgramGraphStore;
    let engine: DependencyPathEngine;

    beforeEach(() => {
        store = new ProgramGraphStore();
        // Mock internal structure
        (store as any).graph = { nodes: {}, edges: [] };
        (store as any).inEdges = new Map();
        (store as any).outEdges = new Map();
        (store as any).symbolToNodes = new Map();
        (store as any).isLoaded = () => true;
        
        store.getNode = (id: string) => (store as any).graph.nodes[id];
        
        engine = new DependencyPathEngine(store);
    });

    function addNode(id: string) {
        (store as any).graph.nodes[id] = { id, symbol: id, type: 'function', filePath: 'dummy.ts' } as unknown as ProgramGraphNode;
        (store as any).symbolToNodes.set(id.toLowerCase(), [id]);
    }

    function addEdge(from: string, to: string, type: ProgramGraphEdgeType, weight: number = 1.0) {
        const edge = { from, to, type, weight };
        (store as any).graph.edges.push(edge);
        
        if (!(store as any).inEdges.has(to)) (store as any).inEdges.set(to, []);
        if (!(store as any).outEdges.has(from)) (store as any).outEdges.set(from, []);
        
        (store as any).inEdges.get(to).push(edge);
        (store as any).outEdges.get(from).push(edge);
    }

    test('findShortestPath returns correct path steps', () => {
        addNode('A');
        addNode('B');
        addNode('C');
        
        // A -> calls -> B -> imports -> C
        addEdge('A', 'B', 'calls');
        addEdge('B', 'C', 'imports');
        
        const result = engine.findShortestPath('A', 'C');
        
        expect(result.sourceNodeId).toBe('A');
        expect(result.targetNodeId).toBe('C');
        expect(result.shortestPath).toBeDefined();
        expect(result.shortestPath!.depth).toBe(2);
        
        const steps = result.shortestPath!.steps;
        expect(steps.length).toBe(2);
        expect(steps[0]).toEqual({ fromNodeId: 'A', toNodeId: 'B', edgeType: 'calls', edgeWeight: 1 });
        expect(steps[1]).toEqual({ fromNodeId: 'B', toNodeId: 'C', edgeType: 'imports', edgeWeight: 1 });
    });

    test('findAllPaths returns multiple valid paths', () => {
        addNode('A');
        addNode('B');
        addNode('C');
        addNode('D');
        
        // Path 1: A -> calls -> B -> imports -> D
        addEdge('A', 'B', 'calls');
        addEdge('B', 'D', 'imports');
        
        // Path 2: A -> calls -> C -> calls -> D
        addEdge('A', 'C', 'calls');
        addEdge('C', 'D', 'calls');

        const result = engine.findAllPaths('A', 'D');
        
        expect(result.totalPathsFound).toBe(2);
        expect(result.paths.length).toBe(2);
        expect(result.isTruncated).toBe(false);
        expect(result.shortestPath?.depth).toBe(2);
    });

    test('findAllPaths correctly detects and breaks cycles inside a path', () => {
        addNode('A');
        addNode('B');
        addNode('C');
        addNode('D');

        // Path: A -> B -> C -> D
        addEdge('A', 'B', 'calls');
        addEdge('B', 'C', 'calls');
        addEdge('C', 'D', 'calls');

        // Cycle: C -> B
        addEdge('C', 'B', 'calls');

        // If cycle protection fails, this will throw Max Call Stack Size Exceeded (OOM)
        const result = engine.findAllPaths('A', 'D');

        expect(result.totalPathsFound).toBe(1);
        const steps = result.paths[0].steps;
        expect(steps.map(s => s.toNodeId)).toEqual(['B', 'C', 'D']);
    });

    test('findAllPaths respects maxPaths truncation', () => {
        addNode('A');
        addNode('B1'); addNode('B2'); addNode('B3');
        addNode('C');
        
        // A -> [B1, B2, B3]
        addEdge('A', 'B1', 'calls');
        addEdge('A', 'B2', 'calls');
        addEdge('A', 'B3', 'calls');
        
        // [B1, B2, B3] -> C
        addEdge('B1', 'C', 'calls');
        addEdge('B2', 'C', 'calls');
        addEdge('B3', 'C', 'calls');

        // Limit to 2 paths
        const result = engine.findAllPaths('A', 'C', undefined, 10, 2);

        expect(result.isTruncated).toBe(true);
        expect(result.totalPathsFound).toBe(2);
        expect(result.paths.length).toBe(2);
    });

    test('findAllPaths respects maxDepth truncation', () => {
        addNode('A');
        addNode('B');
        addNode('C');
        addNode('D');

        addEdge('A', 'B', 'calls');
        addEdge('B', 'C', 'calls');
        addEdge('C', 'D', 'calls');

        // Limit to depth 2 (path to D is depth 3)
        const result = engine.findAllPaths('A', 'D', undefined, 2, 100);

        expect(result.isTruncated).toBe(false);
        expect(result.totalPathsFound).toBe(0);
        expect(result.paths.length).toBe(0);
    });

    test('explainDependency and explainImpact aliases work correctly', () => {
        addNode('Root');
        addNode('Impacted');

        // Impacted depends on Root
        addEdge('Impacted', 'Root', 'calls');

        const depResult = engine.explainDependency('Impacted', 'Root');
        expect(depResult.shortestPath!.steps[0].edgeType).toBe('calls');
        
        const impactResult = engine.explainImpact('Root', 'Impacted');
        expect(impactResult.shortestPath!.steps[0].edgeType).toBe('calls');
    });
});
