import { expect, test, describe, beforeEach } from '@jest/globals';
import { ProgramGraphStore } from '../store/programGraphStore';
import { TransitiveGraphWalker } from './transitiveGraphWalker';
import { DependencyPathEngine } from './dependencyPathEngine';
import { BlastRadiusExplanationEngine } from './blastRadiusExplanationEngine';
import { ProgramGraphEdgeType, ProgramGraphNode } from '../graph/programGraphTypes';

describe('BlastRadiusExplanationEngine', () => {
    let store: ProgramGraphStore;
    let walker: TransitiveGraphWalker;
    let pathEngine: DependencyPathEngine;
    let explanationEngine: BlastRadiusExplanationEngine;

    beforeEach(() => {
        store = new ProgramGraphStore();
        (store as any).graph = { nodes: {}, edges: [] };
        (store as any).inEdges = new Map();
        (store as any).outEdges = new Map();
        (store as any).symbolToNodes = new Map();
        (store as any).isLoaded = () => true;
        
        store.getNode = (id: string) => (store as any).graph.nodes[id];
        
        walker = new TransitiveGraphWalker(store);
        pathEngine = new DependencyPathEngine(store);
        explanationEngine = new BlastRadiusExplanationEngine(store, walker, pathEngine);
    });

    function addNode(id: string, filePath: string = 'src/query/dummy.ts') {
        (store as any).graph.nodes[id] = { id, symbol: id, type: 'function', filePath } as unknown as ProgramGraphNode;
        (store as any).symbolToNodes.set(id.toLowerCase(), [id]);
    }

    function addEdge(from: string, to: string, type: ProgramGraphEdgeType) {
        const edge = { from, to, type, weight: 1.0 };
        (store as any).graph.edges.push(edge);
        
        if (!(store as any).inEdges.has(to)) (store as any).inEdges.set(to, []);
        if (!(store as any).outEdges.has(from)) (store as any).outEdges.set(from, []);
        
        (store as any).inEdges.get(to).push(edge);
        (store as any).outEdges.get(from).push(edge);
    }

    test('explainBlastRadius orchestrates Walker correctly and calculates score', () => {
        addNode('Store', 'src/store/store.ts');
        addNode('Index', 'src/index/index.ts');
        addNode('Hybrid', 'src/hybrid/hybrid.ts');

        // Store <- calls <- Index <- imports <- Hybrid
        addEdge('Index', 'Store', 'calls');
        addEdge('Hybrid', 'Index', 'imports');

        // Note: walker navigates dependents. So from Store, it goes up inbound edges.
        const result = explanationEngine.explainBlastRadius('Store');

        expect(result.rootNodeId).toBe('Store');
        expect(result.summary.totalImpactedNodes).toBe(2);
        
        // Exps should be ordered by score descending.
        // Hybrid depth = 2. It has 0 inbound, 1 outbound. Score = (2*1) + (0*2) + (1*1) = 3
        // Index depth = 1. It has 1 inbound (Hybrid), 1 outbound (Store). Score = (1*1) + (1*2) + (1*1) = 4
        expect(result.impactExplanations[0].impactedNodeId).toBe('Index');
        expect(result.impactExplanations[1].impactedNodeId).toBe('Hybrid');

        // Subsystems extraction test
        expect(result.impactExplanations[0].impactedSubsystems).toEqual(['src/index']);
        expect(result.impactExplanations[1].impactedSubsystems).toEqual(['src/hybrid']);

        // Evidence mapping
        const hybridEvidence = result.impactExplanations[1].evidence;
        expect(hybridEvidence.length).toBe(2);
        // Path should be Store -> Index -> Hybrid
        expect(hybridEvidence[0].edgeType).toBe('calls');
        expect(hybridEvidence[1].edgeType).toBe('imports');
    });

    test('explainImpact isolates a specific point-to-point explanation', () => {
        addNode('Root', 'src/core.ts');
        addNode('Impacted', 'src/ui.ts');

        addEdge('Impacted', 'Root', 'calls');

        const result = explanationEngine.explainImpact('Root', 'Impacted');
        expect(result).toBeDefined();
        expect(result!.rootNodeId).toBe('Root');
        expect(result!.impactedSubsystems).toEqual(['src']);
        expect(result!.evidence.length).toBe(1);
        expect(result!.evidence[0].edgeType).toBe('calls');
    });

    test('summarizeBlastRadius limits and returns top nodes', () => {
        addNode('Root');
        for (let i = 0; i < 25; i++) {
            addNode(`N${i}`);
            addEdge(`N${i}`, 'Root', 'calls'); // all directly depend on Root
            
            // artificially increase degree to rank them
            for (let j = 0; j < i; j++) {
                addNode(`Extra${i}_${j}`);
                addEdge(`Extra${i}_${j}`, `N${i}`, 'calls');
            }
        }

        const summary = explanationEngine.summarizeBlastRadius('Root');

        // total should be 25 N-nodes + all extra nodes (total 25 + 300 = 325)
        expect(summary.totalImpactedNodes).toBeGreaterThan(300);
        
        // Critical paths should be clamped to MAX_CRITICAL_PATHS (20)
        expect(summary.criticalPaths.length).toBe(20);
        expect(summary.topImpactedNodes.length).toBe(20);
        
        // N24 has the highest inbound degree, so it should be #1
        expect(summary.topImpactedNodes[0]).toBe('N24');
    });
});
