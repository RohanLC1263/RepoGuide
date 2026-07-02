import { expect, test, describe, beforeEach } from '@jest/globals';
import { ProgramGraphStore } from '../store/programGraphStore';
import { TransitiveGraphWalker } from './transitiveGraphWalker';
import { DependencyPathEngine } from './dependencyPathEngine';
import { BlastRadiusExplanationEngine } from './blastRadiusExplanationEngine';
import { RiskEngine } from './riskEngine';
import { ProgramGraphEdgeType, ProgramGraphNode } from '../graph/programGraphTypes';

describe('RiskEngine', () => {
    let store: ProgramGraphStore;
    let walker: TransitiveGraphWalker;
    let pathEngine: DependencyPathEngine;
    let explanationEngine: BlastRadiusExplanationEngine;
    let riskEngine: RiskEngine;

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
        riskEngine = new RiskEngine(store, explanationEngine);
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

    test('assessNodeRisk deterministically calculates risk score and clamps at 100', () => {
        addNode('CoreStore', 'src/store.ts');
        
        // Add 30 dependent nodes across 5 subsystems
        for (let i = 0; i < 30; i++) {
            addNode(`Dep${i}`, `src/sub${i % 5}/file.ts`);
            addEdge(`Dep${i}`, 'CoreStore', 'calls'); // Dep -> calls -> CoreStore
            
            // Artificial depth
            if (i > 0) {
                addEdge(`Dep${i}`, `Dep${i-1}`, 'calls');
            }
        }

        const risk = riskEngine.assessNodeRisk('CoreStore');

        // impactedNodeCount = 30 -> 30 * 2 = 60
        // maxDepth = 30 -> 30 * 4 = 120
        // criticalPathCount = 20 (maxed) -> 20 * 5 = 100
        // subsystemCount = 5 -> 5 * 5 = 25
        // inboundDegree = 1 (Dep0) or more -> 1 * 2 = 2
        // Total raw score > 300

        expect(risk.nodeId).toBe('CoreStore');
        expect(risk.score).toBe(100); // Clamped
        expect(risk.severity).toBe('CRITICAL');
        
        // Check structural factors
        expect(risk.factors.structural.impactedNodeCount).toBe(30);
        expect(risk.factors.structural.criticalPathCount).toBe(20); // capped by explanation engine
        expect(risk.factors.structural.subsystemCount).toBe(5);
        expect(risk.rationale.topReasons.length).toBeGreaterThan(0);
        expect(risk.rationale.topReasons).toContain('30 impacted nodes');
    });

    test('assessNodeRisk maps severities correctly', () => {
        addNode('IsolatedLeaf', 'src/leaf.ts');
        addNode('Parent', 'src/parent.ts');
        
        addEdge('Parent', 'IsolatedLeaf', 'calls');

        const risk = riskEngine.assessNodeRisk('IsolatedLeaf');
        
        // 1 impacted node (Parent) -> 2
        // max depth 1 -> 4
        // 1 critical path -> 5
        // 1 subsystem -> 5
        // inbound degree 1 -> 2
        // outbound degree 0 -> 0
        // Total: 18 -> LOW
        
        expect(risk.score).toBe(18);
        expect(risk.severity).toBe('LOW');
    });

    test('rankRepositoryRisk returns top N risky nodes using lightweight pre-filtering', () => {
        addNode('GodObject');
        addNode('MediumRisk');
        addNode('TinyLeaf');
        
        // GodObject is called by 10 nodes
        for (let i = 0; i < 10; i++) {
            addNode(`G_caller${i}`);
            addEdge(`G_caller${i}`, 'GodObject', 'calls');
        }

        // MediumRisk is called by 3 nodes
        for (let i = 0; i < 3; i++) {
            addNode(`M_caller${i}`);
            addEdge(`M_caller${i}`, 'MediumRisk', 'calls');
        }

        // TinyLeaf is called by nothing
        
        const rankings = riskEngine.rankRepositoryRisk(2);
        
        expect(rankings.length).toBe(2);
        expect(rankings[0].nodeId).toBe('GodObject');
        expect(rankings[1].nodeId).toBe('MediumRisk');
        
        // 10 nodes * 2 = 20
        // max depth = 1 -> 4
        // critical paths = 10 -> 50
        // subsystem = 1 -> 5
        // inbound = 10 -> 20
        // Total = 99 -> CRITICAL
        expect(rankings[0].severity).toBe('CRITICAL');
    });
});
