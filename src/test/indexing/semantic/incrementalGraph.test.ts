import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { GraphComputer } from '../../../indexing/semantic/graph/graphComputer';
import { GraphUpdatePlanner } from '../../../indexing/semantic/graph/graphUpdatePlanner';
import { FactResolver } from '../../../indexing/semantic/graph/factResolver';
import { InMemoryShadowGraphStore } from '../../../indexing/semantic/inMemoryShadowGraphStore';
import { CanonicalFactFactory } from '../../../indexing/semantic/canonicalFact';
import { SemanticGraph } from '../../../indexing/semantic/graph/semanticGraph';

function assertGraphsEqual(actual: SemanticGraph, expected: SemanticGraph, context: string) {
    const actualNodes = actual.getAllNodes();
    const expectedNodes = expected.getAllNodes();
    assert.equal(actualNodes.length, expectedNodes.length, `${context}: node count mismatch`);
    for (let i = 0; i < actualNodes.length; i++) {
        assert.deepEqual(actualNodes[i], expectedNodes[i], `${context}: node mismatch at index ${i}`);
        // Fidelity assertion: explicit check for provenance
        assert.ok(actualNodes[i].originatingFacts && actualNodes[i].originatingFacts.length > 0, `${context}: Node missing originatingFacts`);
        
        // Adjacency indices assertion
        const nodeId = actualNodes[i].nodeId;
        assert.deepEqual(actual.getIncomingEdges(nodeId), expected.getIncomingEdges(nodeId), `${context}: Incoming edges mismatch for node ${nodeId}`);
        assert.deepEqual(actual.getOutgoingEdges(nodeId), expected.getOutgoingEdges(nodeId), `${context}: Outgoing edges mismatch for node ${nodeId}`);
    }

    const actualEdges = actual.getAllEdges();
    const expectedEdges = expected.getAllEdges();
    assert.equal(actualEdges.length, expectedEdges.length, `${context}: edge count mismatch`);
    for (let i = 0; i < actualEdges.length; i++) {
        const edge = actualEdges[i];
        assert.deepEqual(edge, expectedEdges[i], `${context}: edge mismatch at index ${i}`);
        // Fidelity assertion
        assert.ok(edge.originatingFacts && edge.originatingFacts.length > 0, `${context}: Edge missing originatingFacts`);
        
        // Structural Integrity assertion: explicit check for no dangling edges
        assert.ok(actual.getNode(edge.sourceNodeId), `${context}: Dangling source edge`);
        assert.ok(actual.getNode(edge.targetNodeId), `${context}: Dangling target edge`);
    }

    assert.deepEqual(actual.diagnostics, expected.diagnostics, `${context}: diagnostics mismatch`);
}

describe('Incremental Graph Recomputation', () => {
    it('incremental add should equal full recomputation', () => {
        const entityA = CanonicalFactFactory.createFact('ENTITY', { canonicalId: { kind: 'file', qualifiedName: 'A' }, name: 'A' });
        const entityB = CanonicalFactFactory.createFact('ENTITY', { canonicalId: { kind: 'file', qualifiedName: 'B' }, name: 'B' });
        const relationship = CanonicalFactFactory.createFact('RELATIONSHIP', { source: { kind: 'file', qualifiedName: 'A' }, target: { kind: 'file', qualifiedName: 'B' } });

        const store = new InMemoryShadowGraphStore();
        store.applyOperations([{ type: 'InsertFact', fact: entityA }]);
        
        const previousGraph = GraphComputer.compute(store);

        // Delta
        const delta = {
            addedFacts: [entityB, relationship],
            removedFactIds: []
        };
        store.applyOperations([
            { type: 'InsertFact', fact: entityB },
            { type: 'InsertFact', fact: relationship }
        ]);

        const fullGraph = GraphComputer.compute(store);

        const request = GraphUpdatePlanner.plan(previousGraph, delta);
        const plan = FactResolver.resolve(request, store);
        const incrementalGraph = GraphComputer.computeIncremental(previousGraph, plan);

        assertGraphsEqual(incrementalGraph, fullGraph, 'Incremental Add');
    });

    it('incremental delete should equal full recomputation and correctly generate MissingEndpoint', () => {
        const entityA = CanonicalFactFactory.createFact('ENTITY', { canonicalId: { kind: 'file', qualifiedName: 'A' }, name: 'A' });
        const entityB = CanonicalFactFactory.createFact('ENTITY', { canonicalId: { kind: 'file', qualifiedName: 'B' }, name: 'B' });
        const relationship = CanonicalFactFactory.createFact('RELATIONSHIP', { source: { kind: 'file', qualifiedName: 'A' }, target: { kind: 'file', qualifiedName: 'B' } });

        const store = new InMemoryShadowGraphStore();
        store.applyOperations([
            { type: 'InsertFact', fact: entityA },
            { type: 'InsertFact', fact: entityB },
            { type: 'InsertFact', fact: relationship }
        ]);
        
        const previousGraph = GraphComputer.compute(store);

        // Delete entityB, which breaks the relationship
        const delta = {
            addedFacts: [],
            removedFactIds: [entityB.factId]
        };

        const storeForFull = new InMemoryShadowGraphStore();
        storeForFull.applyOperations([
            { type: 'InsertFact', fact: entityA },
            { type: 'InsertFact', fact: relationship }
        ]);
        const fullGraph = GraphComputer.compute(storeForFull);

        const request = GraphUpdatePlanner.plan(previousGraph, delta);
        // At this point, the store needs to still have the relationship fact to resolve it,
        // which it does because we only logically remove the entity (in our storeForFull we didn't add it).
        // Let's ensure the original store retains the relationship so the resolver can find it.
        const plan = FactResolver.resolve(request, store); 
        const incrementalGraph = GraphComputer.computeIncremental(previousGraph, plan);

        assertGraphsEqual(incrementalGraph, fullGraph, 'Incremental Delete');
    });

    it('incremental add of missing entity should resolve MissingEndpoint from previous graph', () => {
        const entityA = CanonicalFactFactory.createFact('ENTITY', { canonicalId: { kind: 'file', qualifiedName: 'A' }, name: 'A' });
        const relationship = CanonicalFactFactory.createFact('RELATIONSHIP', { source: { kind: 'file', qualifiedName: 'A' }, target: { kind: 'file', qualifiedName: 'B' } });

        const store = new InMemoryShadowGraphStore();
        store.applyOperations([
            { type: 'InsertFact', fact: entityA },
            { type: 'InsertFact', fact: relationship }
        ]);
        
        const previousGraph = GraphComputer.compute(store);
        assert.equal(previousGraph.getAllEdges().length, 0);
        assert.equal(previousGraph.diagnostics.missingEndpoints.length, 1);

        // Now add entity B
        const entityB = CanonicalFactFactory.createFact('ENTITY', { canonicalId: { kind: 'file', qualifiedName: 'B' }, name: 'B' });
        const delta = {
            addedFacts: [entityB],
            removedFactIds: []
        };
        store.applyOperations([{ type: 'InsertFact', fact: entityB }]);

        const fullGraph = GraphComputer.compute(store);

        const request = GraphUpdatePlanner.plan(previousGraph, delta);
        const plan = FactResolver.resolve(request, store);
        const incrementalGraph = GraphComputer.computeIncremental(previousGraph, plan);

        assertGraphsEqual(incrementalGraph, fullGraph, 'Incremental MissingEndpoint Resolution');
        assert.equal(incrementalGraph.diagnostics.missingEndpoints.length, 0);
        assert.equal(incrementalGraph.getAllEdges().length, 1);
    });

    it('incremental recomputation is pure and deterministic', () => {
        const entityA = CanonicalFactFactory.createFact('ENTITY', { canonicalId: { kind: 'file', qualifiedName: 'A' }, name: 'A' });
        const unknown = CanonicalFactFactory.createFact('UNKNOWN', { unsupported: 'true' });

        const store = new InMemoryShadowGraphStore();
        store.applyOperations([{ type: 'InsertFact', fact: entityA }]);
        
        const previousGraph = GraphComputer.compute(store);

        const delta = {
            addedFacts: [unknown],
            removedFactIds: [entityA.factId]
        };

        const storeFull = new InMemoryShadowGraphStore();
        storeFull.applyOperations([{ type: 'InsertFact', fact: unknown }]);
        const fullGraph = GraphComputer.compute(storeFull);

        const request = GraphUpdatePlanner.plan(previousGraph, delta);
        const plan = FactResolver.resolve(request, store);
        
        const incrementalGraph1 = GraphComputer.computeIncremental(previousGraph, plan);
        const incrementalGraph2 = GraphComputer.computeIncremental(previousGraph, plan);

        assertGraphsEqual(incrementalGraph1, fullGraph, 'Deterministic pass 1');
        assertGraphsEqual(incrementalGraph2, fullGraph, 'Deterministic pass 2');
        assertGraphsEqual(incrementalGraph1, incrementalGraph2, 'Incremental stability');
        
        // Additional determinism check: explicit sorting and permutation insertion order
        const entityC = CanonicalFactFactory.createFact('ENTITY', { canonicalId: { kind: 'file', qualifiedName: 'C' }, name: 'C' });
        const entityD = CanonicalFactFactory.createFact('ENTITY', { canonicalId: { kind: 'file', qualifiedName: 'D' }, name: 'D' });
        const rel2 = CanonicalFactFactory.createFact('RELATIONSHIP', { source: { kind: 'file', qualifiedName: 'C' }, target: { kind: 'file', qualifiedName: 'D' } });
        
        const storeFullC = new InMemoryShadowGraphStore();
        storeFullC.applyOperations([
            { type: 'InsertFact', fact: entityC },
            { type: 'InsertFact', fact: entityD },
            { type: 'InsertFact', fact: rel2 }
        ]);
        const expectedShuffledGraph = GraphComputer.compute(storeFullC);
        
        const permutations = [
            [rel2, entityD, entityC],
            [entityC, rel2, entityD],
            [entityD, entityC, rel2],
            [rel2, entityC, entityD],
            [entityD, rel2, entityC],
            [entityC, entityD, rel2]
        ];

        for (const [index, perm] of permutations.entries()) {
            const shuffledDelta = {
                addedFacts: perm,
                removedFactIds: []
            };
            const emptyGraph = GraphComputer.compute(new InMemoryShadowGraphStore());
            const shuffledRequest = GraphUpdatePlanner.plan(emptyGraph, shuffledDelta);
            const shuffledPlan = FactResolver.resolve(shuffledRequest, storeFullC);
            const shuffledIncrementalGraph = GraphComputer.computeIncremental(emptyGraph, shuffledPlan);
            assertGraphsEqual(shuffledIncrementalGraph, expectedShuffledGraph, `Deterministic order for permutation ${index}`);
        }
    });
});
