import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { GraphComputer } from '../../../indexing/semantic/graph/graphComputer';
import { InMemoryShadowGraphStore } from '../../../indexing/semantic/inMemoryShadowGraphStore';
import { CanonicalFactFactory } from '../../../indexing/semantic/canonicalFact';
import { GraphOperation } from '../../../indexing/semantic/shadowGraphStoreContract';

describe('GraphComputer', () => {
    let store: InMemoryShadowGraphStore;

    beforeEach(() => {
        store = new InMemoryShadowGraphStore();
    });

    it('should construct a valid graph from exact facts and preserve Graph Fidelity', () => {
        // Arrange
        const entityA = CanonicalFactFactory.createFact('ENTITY', {
            canonicalId: { kind: 'file', qualifiedName: 'A' },
            name: 'A',
            entityKind: 'file'
        });
        const entityB = CanonicalFactFactory.createFact('ENTITY', {
            canonicalId: { kind: 'file', qualifiedName: 'B' },
            name: 'B',
            entityKind: 'file'
        });
        const relationship = CanonicalFactFactory.createFact('RELATIONSHIP', {
            category: 'DEPENDENCY',
            relationshipKind: 'imports',
            source: { kind: 'file', qualifiedName: 'A' },
            target: { kind: 'file', qualifiedName: 'B' }
        });

        store.applyOperations([
            { type: 'InsertFact', fact: entityA },
            { type: 'InsertFact', fact: entityB },
            { type: 'InsertFact', fact: relationship }
        ]);

        // Act
        const graph = GraphComputer.compute(store);

        // Assert
        assert.equal(graph.getAllNodes().length, 2);
        assert.equal(graph.getAllEdges().length, 1);
        assert.equal(graph.diagnostics.missingEndpoints.length, 0);

        // Node Provenance Verification
        const nodeA = graph.getNode(entityA.factId);
        assert.ok(nodeA);
        assert.ok(Array.isArray(nodeA.originatingFacts));
        assert.equal(nodeA.originatingFacts.length, 1);
        assert.equal(nodeA.originatingFacts[0], entityA.factId);

        const nodeB = graph.getNode(entityB.factId);
        assert.ok(nodeB);
        assert.ok(Array.isArray(nodeB.originatingFacts));
        assert.equal(nodeB.originatingFacts.length, 1);
        assert.equal(nodeB.originatingFacts[0], entityB.factId);

        // Edge Provenance Verification
        const edge = graph.getAllEdges()[0];
        assert.ok(Array.isArray(edge.originatingFacts));
        assert.equal(edge.originatingFacts.length, 1);
        assert.equal(edge.originatingFacts[0], relationship.factId);

        assert.equal(edge.sourceNodeId, entityA.factId);
        assert.equal(edge.targetNodeId, entityB.factId);
        assert.ok(graph.getOutgoingEdges(entityA.factId).includes(edge));
        assert.ok(graph.getIncomingEdges(entityB.factId).includes(edge));
    });

    it('should maintain Traceability Invariant globally across the executable graph', () => {
        // Arrange
        const entityA = CanonicalFactFactory.createFact('ENTITY', {
            canonicalId: { kind: 'file', qualifiedName: 'A' },
            name: 'A',
            entityKind: 'file'
        });
        const entityB = CanonicalFactFactory.createFact('ENTITY', {
            canonicalId: { kind: 'file', qualifiedName: 'B' },
            name: 'B',
            entityKind: 'file'
        });
        const relationship = CanonicalFactFactory.createFact('RELATIONSHIP', {
            category: 'DEPENDENCY',
            relationshipKind: 'imports',
            source: { kind: 'file', qualifiedName: 'A' },
            target: { kind: 'file', qualifiedName: 'B' }
        });

        store.applyOperations([
            { type: 'InsertFact', fact: entityA },
            { type: 'InsertFact', fact: entityB },
            { type: 'InsertFact', fact: relationship }
        ]);

        // Act
        const graph = GraphComputer.compute(store);
        
        // Assert: Traceability Invariant
        const allFacts = new Set(store.getAllFacts().map(f => f.factId));

        for (const node of graph.getAllNodes()) {
            assert.ok(node.originatingFacts.length > 0, `Node ${node.nodeId} has no provenance`);
            for (const factId of node.originatingFacts) {
                assert.ok(allFacts.has(factId), `Node ${node.nodeId} references unknown fact ${factId}`);
            }
        }

        for (const edge of graph.getAllEdges()) {
            assert.ok(edge.originatingFacts.length > 0, `Edge ${edge.edgeId} has no provenance`);
            for (const factId of edge.originatingFacts) {
                assert.ok(allFacts.has(factId), `Edge ${edge.edgeId} references unknown fact ${factId}`);
            }
        }
    });

    it('should emit MissingEndpoint and omit edge if target is missing, retaining traceability in diagnostic', () => {
        const entityA = CanonicalFactFactory.createFact('ENTITY', {
            canonicalId: { kind: 'file', qualifiedName: 'A' },
            name: 'A',
            entityKind: 'file'
        });
        const relationship = CanonicalFactFactory.createFact('RELATIONSHIP', {
            category: 'DEPENDENCY',
            relationshipKind: 'imports',
            source: { kind: 'file', qualifiedName: 'A' },
            target: { kind: 'file', qualifiedName: 'B' }
        });

        store.applyOperations([
            { type: 'InsertFact', fact: entityA },
            { type: 'InsertFact', fact: relationship }
        ]);

        const graph = GraphComputer.compute(store);

        assert.equal(graph.getAllNodes().length, 1);
        assert.equal(graph.getAllEdges().length, 0); // Omitted edge
        assert.equal(graph.diagnostics.missingEndpoints.length, 1);
        assert.equal(graph.diagnostics.missingEndpoints[0].edgeId, relationship.factId); // Traceable via edgeId
        assert.equal(graph.diagnostics.missingEndpoints[0].description, 'Missing target endpoint for relationship');
    });

    it('should emit MissingEndpoint and omit edge if source is missing, retaining traceability in diagnostic', () => {
        const entityB = CanonicalFactFactory.createFact('ENTITY', {
            canonicalId: { kind: 'file', qualifiedName: 'B' },
            name: 'B',
            entityKind: 'file'
        });
        const relationship = CanonicalFactFactory.createFact('RELATIONSHIP', {
            category: 'DEPENDENCY',
            relationshipKind: 'imports',
            source: { kind: 'file', qualifiedName: 'A' },
            target: { kind: 'file', qualifiedName: 'B' }
        });

        store.applyOperations([
            { type: 'InsertFact', fact: entityB },
            { type: 'InsertFact', fact: relationship }
        ]);

        const graph = GraphComputer.compute(store);

        assert.equal(graph.getAllNodes().length, 1);
        assert.equal(graph.getAllEdges().length, 0); // Omitted edge
        assert.equal(graph.diagnostics.missingEndpoints.length, 1);
        assert.equal(graph.diagnostics.missingEndpoints[0].edgeId, relationship.factId); // Traceable via edgeId
        assert.equal(graph.diagnostics.missingEndpoints[0].description, 'Missing source endpoint for relationship');
    });

    it('should isolate UNKNOWN facts into diagnostics and omit from graph', () => {
        const unknownFact = CanonicalFactFactory.createFact('UNKNOWN', {
            unsupportedConstruct: 'try-catch'
        });

        store.applyOperations([
            { type: 'InsertFact', fact: unknownFact }
        ]);

        const graph = GraphComputer.compute(store);

        assert.equal(graph.getAllNodes().length, 0);
        assert.equal(graph.getAllEdges().length, 0);
        assert.equal(graph.diagnostics.unknownFacts.length, 1);
        assert.equal(graph.diagnostics.unknownFacts[0].factId, unknownFact.factId);
    });

    it('should produce identical graph under shuffled inputs', () => {
        const entityA = CanonicalFactFactory.createFact('ENTITY', { canonicalId: { kind: 'file', qualifiedName: 'A' }, name: 'A' });
        const entityB = CanonicalFactFactory.createFact('ENTITY', { canonicalId: { kind: 'file', qualifiedName: 'B' }, name: 'B' });
        const relationship = CanonicalFactFactory.createFact('RELATIONSHIP', { source: { kind: 'file', qualifiedName: 'A' }, target: { kind: 'file', qualifiedName: 'B' } });

        const store1 = new InMemoryShadowGraphStore();
        store1.applyOperations([
            { type: 'InsertFact', fact: entityA },
            { type: 'InsertFact', fact: entityB },
            { type: 'InsertFact', fact: relationship }
        ]);
        
        const store2 = new InMemoryShadowGraphStore();
        store2.applyOperations([
            { type: 'InsertFact', fact: relationship },
            { type: 'InsertFact', fact: entityB },
            { type: 'InsertFact', fact: entityA }
        ]);

        const graph1 = GraphComputer.compute(store1);
        const graph2 = GraphComputer.compute(store2);

        assert.deepEqual(graph1.getAllNodes().map((n: any) => n.nodeId), graph2.getAllNodes().map((n: any) => n.nodeId));
        assert.deepEqual(graph1.getAllEdges().map((e: any) => e.edgeId), graph2.getAllEdges().map((e: any) => e.edgeId));
        assert.equal(graph1.diagnostics.missingEndpoints.length, graph2.diagnostics.missingEndpoints.length);
    });
});
