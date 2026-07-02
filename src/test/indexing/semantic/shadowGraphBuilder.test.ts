import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ShadowGraphBuilder } from '../../../indexing/semantic/shadowGraphBuilder';
import { CanonicalFactFactory, FactObservation } from '../../../indexing/semantic/canonicalFact';
import { IShadowGraphStore, GraphOperation } from '../../../indexing/semantic/shadowGraphStoreContract';

class MockStore implements IShadowGraphStore {
    public operations: GraphOperation[] = [];
    public previousObs: FactObservation[] = [];
    public obsByFact = new Map<string, FactObservation[]>();

    public getAllFacts(): import('../../../indexing/semantic/canonicalFact').CanonicalFact[] { return []; }

    getObservationsByProvenance(provenance: string): FactObservation[] {
        return this.previousObs;
    }

    getObservationsByFactId(factId: string): FactObservation[] {
        return this.obsByFact.get(factId) || [];
    }

    applyOperations(operations: GraphOperation[]): void {
        this.operations = operations;
    }
}

describe('Slice 2 & 4: ShadowGraphBuilder Integration, Determinism, & Invalidation', () => {
    const provenance = 'typescript-semantic-provider@1.0.0';
    
    const fact1 = CanonicalFactFactory.createFact('ENTITY', { name: 'Alpha' });
    const fact2 = CanonicalFactFactory.createFact('ENTITY', { name: 'Beta' });
    const fact3 = CanonicalFactFactory.createFact('ENTITY', { name: 'Gamma' });

    const obs1 = CanonicalFactFactory.createObservation(fact1.factId, provenance, []);
    const obs2 = CanonicalFactFactory.createObservation(fact2.factId, provenance, []);
    const obs3 = CanonicalFactFactory.createObservation(fact3.factId, provenance, []);

    it('Transaction Ordering: Verify exact canonical ordering', () => {
        const store = new MockStore();
        const builder = new ShadowGraphBuilder(store);
        
        builder.ingest(provenance, [fact1], [obs1]);
        
        const ops = store.operations;
        assert.equal(ops.length, 5);
        assert.equal(ops[0].type, 'DeleteObservations');
        assert.equal(ops[1].type, 'DeleteOrphanFacts');
        assert.equal(ops[2].type, 'InsertFact');
        assert.equal(ops[3].type, 'InsertObservation');
        assert.equal(ops[4].type, 'CommitTransaction');
    });

    it('Builder Determinism: Idempotency with shuffled and duplicate inputs', () => {
        const storeA = new MockStore();
        const builderA = new ShadowGraphBuilder(storeA);
        
        const storeB = new MockStore();
        const builderB = new ShadowGraphBuilder(storeB);
        
        // Setup A: Normal
        builderA.ingest(provenance, [fact1, fact2], [obs1, obs2]);
        
        // Setup B: Reversed, with duplicates
        builderB.ingest(provenance, [fact2, fact1, fact1], [obs2, obs1, obs2]);
        
        // Results must be byte-for-byte identical (in structure)
        assert.equal(storeA.operations.length, storeB.operations.length);
        assert.deepEqual(storeA.operations, storeB.operations);
        
        // Assert exactly 2 inserts for facts and 2 for obs despite duplicates
        const insertFacts = storeA.operations.filter(o => o.type === 'InsertFact');
        const insertObs = storeA.operations.filter(o => o.type === 'InsertObservation');
        assert.equal(insertFacts.length, 2);
        assert.equal(insertObs.length, 2);
    });

    it('Builder Purity: Builder never mutates facts or observations', () => {
        const store = new MockStore();
        const builder = new ShadowGraphBuilder(store);
        
        // Verify facts are deeply frozen by factory, but also that builder logic doesn't attempt mutation
        const facts = [fact1];
        const observations = [obs1];
        
        // Clone to track changes
        const factClone = JSON.parse(JSON.stringify(fact1));
        const obsClone = JSON.parse(JSON.stringify(obs1));
        
        builder.ingest(provenance, facts, observations);
        
        assert.deepEqual(facts[0], factClone);
        assert.deepEqual(observations[0], obsClone);
        
        // Ensure the operation directly references the original immutable object
        const insertFact = store.operations.find(o => o.type === 'InsertFact') as any;
        assert.equal(insertFact.fact, fact1); // Reference equality
    });

    it('Storage Abstraction: Verifies communication only through IShadowGraphStore', () => {
        const store = new MockStore();
        const builder = new ShadowGraphBuilder(store);
        builder.ingest(provenance, [fact1], [obs1]);
        
        // store.operations is populated via applyOperations only
        assert.ok(store.operations.length > 0);
    });

    it('No Semantic Reasoning: Verifies the Builder stores what it receives without inference', () => {
        const store = new MockStore();
        const builder = new ShadowGraphBuilder(store);
        
        const aliasFact = CanonicalFactFactory.createFact('ENTITY', { name: 'AliasTarget' });
        
        builder.ingest(provenance, [aliasFact], []);
        
        const ops = store.operations;
        // There should be no automatic alias resolution or missing dependency fetching.
        // It should purely emit ops for what was provided.
        assert.equal(ops.length, 4); // DeleteObs, DeleteOrphans, InsertFact, Commit
        const inserts = ops.filter(o => o.type === 'InsertFact');
        assert.equal(inserts.length, 1);
        assert.equal((inserts[0] as any).fact.payload.name, 'AliasTarget');
    });

    it('Compiler Isolation: Verifies compiler objects cannot appear anywhere inside generated graph operations', () => {
        const store = new MockStore();
        const builder = new ShadowGraphBuilder(store);
        
        builder.ingest(provenance, [fact1], [obs1]);
        
        const opsStr = JSON.stringify(store.operations);
        assert.equal(opsStr.includes('ts.Node'), false);
        assert.equal(opsStr.includes('ts.Symbol'), false);
    });

    it('Invalidation: File update removes obsolete observations and explicitly deletes orphaned facts', () => {
        const store = new MockStore();
        store.previousObs = [obs1, obs2]; // Previously had Alpha and Beta
        
        // Mock that fact1 (Alpha) ONLY had obs1. fact2 (Beta) has another obs from another file.
        const obs2Shared = CanonicalFactFactory.createObservation(fact2.factId, 'other_file.ts', []);
        store.obsByFact.set(fact1.factId, [obs1]);
        store.obsByFact.set(fact2.factId, [obs2, obs2Shared]);
        
        const builder = new ShadowGraphBuilder(store);
        
        // New update: only inserts Gamma (fact3, obs3). Alpha and Beta are dropped.
        builder.ingest(provenance, [fact3], [obs3]);
        
        const ops = store.operations;
        const deleteObs = ops[0] as any;
        const deleteFacts = ops[1] as any;
        const insertFacts = ops.filter(o => o.type === 'InsertFact') as any[];
        
        assert.deepEqual(deleteObs.observationIds, [obs1.observationId, obs2.observationId].sort());
        
        // Alpha is orphaned. Beta is preserved because it has obs2Shared!
        assert.deepEqual(deleteFacts.factIds, [fact1.factId]);
        
        assert.equal(insertFacts.length, 1);
        assert.equal(insertFacts[0].fact.factId, fact3.factId);
    });

    it('Invalidation: File A update does not invalidate File B ownership', () => {
        const store = new MockStore();
        store.previousObs = [obs1];
        
        const builder = new ShadowGraphBuilder(store);
        
        builder.ingest(provenance, [fact1], [obs1]);
        
        const deleteObs = store.operations[0] as any;
        // No obsolete observations for this provenance, array should be empty
        assert.deepEqual(deleteObs.observationIds, []);
    });
});
