import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { InMemoryShadowGraphStore } from '../../../indexing/semantic/inMemoryShadowGraphStore';
import { CanonicalFactFactory } from '../../../indexing/semantic/canonicalFact';
import { GraphOperation } from '../../../indexing/semantic/shadowGraphStoreContract';

describe('Slice 3: InMemoryShadowGraphStore', () => {
    const provenance1 = 'file1.ts';
    const provenance2 = 'file2.ts';
    
    const fact1 = CanonicalFactFactory.createFact('ENTITY', { name: 'F1' });
    const fact2 = CanonicalFactFactory.createFact('ENTITY', { name: 'F2' });
    const fact3 = CanonicalFactFactory.createFact('ENTITY', { name: 'F3' });

    const obs1 = CanonicalFactFactory.createObservation(fact1.factId, provenance1, []);
    const obs2 = CanonicalFactFactory.createObservation(fact2.factId, provenance1, []);
    const obs3 = CanonicalFactFactory.createObservation(fact2.factId, provenance2, []);

    it('CRUD & Transaction: Successful commit of canonical transaction', () => {
        const store = new InMemoryShadowGraphStore();
        store.applyOperations([
            { type: 'DeleteObservations', observationIds: [obs1.observationId] },
            { type: 'DeleteOrphanFacts', factIds: [fact1.factId] },
            { type: 'InsertFact', fact: fact1 },
            { type: 'InsertObservation', observation: obs1 },
            { type: 'CommitTransaction' }
        ]);

        assert.equal(store.getAllFacts().length, 1);
        assert.equal(store.getAllObservations().length, 1);
        assert.equal(store.getFact(fact1.factId)?.factId, fact1.factId);
        assert.equal(store.getObservation(obs1.observationId)?.observationId, obs1.observationId);
        
        // Check file index
        assert.equal(store.getObservationsByProvenance(provenance1).length, 1);
        assert.equal(store.getObservationsByFactId(fact1.factId).length, 1);
    });

    it('Referential Integrity: Prevents observation insert for missing fact', () => {
        const store = new InMemoryShadowGraphStore();
        
        assert.throws(() => {
            store.applyOperations([
                { type: 'InsertObservation', observation: obs1 }
            ]);
        }, /Referential Integrity Violation/);
        
        // Transaction failed, leaves graph unchanged
        assert.equal(store.getAllObservations().length, 0);
    });

    it('Transaction Rollback: Restores previous state on failure', () => {
        const store = new InMemoryShadowGraphStore();
        // Setup initial state
        store.applyOperations([
            { type: 'InsertFact', fact: fact1 },
            { type: 'InsertObservation', observation: obs1 }
        ]);

        assert.equal(store.getAllFacts().length, 1);

        // Failed transaction
        assert.throws(() => {
            store.applyOperations([
                { type: 'InsertFact', fact: fact2 },
                { type: 'InsertObservation', observation: obs2 }, // obs2 needs fact2 which is provided, this is fine
                { type: 'InsertObservation', observation: obs3 }, // obs3 needs fact2, fine
                { type: 'InsertObservation', observation: CanonicalFactFactory.createObservation('invalid_fact', provenance1, []) } // Will throw
            ]);
        }, /Referential Integrity Violation/);

        // Previous state completely restored
        assert.equal(store.getAllFacts().length, 1);
        assert.equal(store.getAllObservations().length, 1);
        assert.equal(store.getFact(fact2.factId), undefined);
    });

    it('Referential Integrity: Explicit orphan deletion & no implicit removal', () => {
        const store = new InMemoryShadowGraphStore();
        store.applyOperations([
            { type: 'InsertFact', fact: fact1 },
            { type: 'InsertFact', fact: fact2 },
            { type: 'InsertObservation', observation: obs1 },
            { type: 'InsertObservation', observation: obs2 }
        ]);

        // Delete observations for provenance1
        store.applyOperations([
            { type: 'DeleteObservations', observationIds: [obs1.observationId, obs2.observationId] }
        ]);

        // Observations removed
        assert.equal(store.getAllObservations().length, 0);
        
        // Facts STILL remain because NO explicit orphan deletion happened yet
        assert.equal(store.getAllFacts().length, 2);

        // Explicit orphan deletion behaves correctly
        store.applyOperations([
            { type: 'DeleteOrphanFacts', factIds: [fact1.factId, fact2.factId] }
        ]);

        assert.equal(store.getAllFacts().length, 0);
    });

    it('Determinism & Idempotency: Duplicate insertions and identical operations', () => {
        const store1 = new InMemoryShadowGraphStore();
        const store2 = new InMemoryShadowGraphStore();
        
        const ops: GraphOperation[] = [
            { type: 'InsertFact', fact: fact1 },
            { type: 'InsertFact', fact: fact1 }, // duplicate
            { type: 'InsertObservation', observation: obs1 },
            { type: 'InsertObservation', observation: obs1 } // duplicate
        ];

        store1.applyOperations(ops);
        store1.applyOperations(ops); // repeated execution

        // Identical operations
        store2.applyOperations([
            { type: 'InsertFact', fact: fact1 },
            { type: 'InsertObservation', observation: obs1 }
        ]);

        assert.deepEqual(store1.getAllFacts(), store2.getAllFacts());
        assert.deepEqual(store1.getAllObservations(), store2.getAllObservations());
    });

    it('Determinism: Shuffled operation batches produce deterministic results', () => {
        const store1 = new InMemoryShadowGraphStore();
        const store2 = new InMemoryShadowGraphStore();

        store1.applyOperations([
            { type: 'InsertFact', fact: fact1 },
            { type: 'InsertFact', fact: fact2 },
            { type: 'InsertObservation', observation: obs1 },
            { type: 'InsertObservation', observation: obs2 }
        ]);

        store2.applyOperations([
            { type: 'InsertFact', fact: fact2 },
            { type: 'InsertFact', fact: fact1 },
            { type: 'InsertObservation', observation: obs2 },
            { type: 'InsertObservation', observation: obs1 }
        ]);

        // getAllFacts and getAllObservations are sorted intrinsically
        assert.deepEqual(store1.getAllFacts(), store2.getAllFacts());
        assert.deepEqual(store1.getAllObservations(), store2.getAllObservations());
    });

    it('Idempotency: Duplicate deletions handled correctly', () => {
        const store = new InMemoryShadowGraphStore();
        store.applyOperations([
            { type: 'DeleteObservations', observationIds: [obs1.observationId, obs1.observationId] }, // duplicate
            { type: 'DeleteOrphanFacts', factIds: [fact1.factId, fact1.factId] } // duplicate
        ]);
        assert.equal(store.getAllFacts().length, 0);
    });

    it('Isolation: Store never mutates CanonicalFact or FactObservation', () => {
        const store = new InMemoryShadowGraphStore();
        const factClone = JSON.parse(JSON.stringify(fact1));
        const obsClone = JSON.parse(JSON.stringify(obs1));

        store.applyOperations([
            { type: 'InsertFact', fact: fact1 },
            { type: 'InsertObservation', observation: obs1 }
        ]);

        assert.deepEqual(fact1, factClone);
        assert.deepEqual(obs1, obsClone);
        
        // Assert reference integrity
        assert.equal(store.getFact(fact1.factId), fact1);
        assert.equal(store.getObservation(obs1.observationId), obs1);
    });
});
