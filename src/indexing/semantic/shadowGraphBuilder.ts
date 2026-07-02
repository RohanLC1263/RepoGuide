import { CanonicalFact, FactObservation } from './canonicalFact';
import { IShadowGraphStore, GraphOperation } from './shadowGraphStoreContract';

export class ShadowGraphBuilder {
    constructor(private readonly store: IShadowGraphStore) {}

    public ingest(provenance: string, facts: CanonicalFact[], observations: FactObservation[]): void {
        const operations = this.buildOperations(provenance, facts, observations);
        this.store.applyOperations(operations);
    }

    public buildOperations(provenance: string, facts: CanonicalFact[], observations: FactObservation[]): GraphOperation[] {
        const operations: GraphOperation[] = [];

        // Invalidation Planner
        const previousObservations = this.store.getObservationsByProvenance(provenance);

        // Deduplicate and sort inputs
        const uniqueFacts = new Map<string, CanonicalFact>();
        for (const fact of facts) {
            if (!uniqueFacts.has(fact.factId)) {
                uniqueFacts.set(fact.factId, fact);
            }
        }

        const uniqueObservations = new Map<string, FactObservation>();
        for (const obs of observations) {
            if (!uniqueObservations.has(obs.observationId)) {
                uniqueObservations.set(obs.observationId, obs);
            }
        }

        const sortedFacts = Array.from(uniqueFacts.values()).sort((a, b) => a.factId.localeCompare(b.factId));
        const sortedObservations = Array.from(uniqueObservations.values()).sort((a, b) => a.observationId.localeCompare(b.observationId));

        // 1. Delete obsolete observations
        const obsoleteObservations = previousObservations.filter(prevObs => !uniqueObservations.has(prevObs.observationId));
        const obsoleteObservationIds = obsoleteObservations.map(obs => obs.observationId).sort();
        
        // Emitting empty arrays is fine to guarantee canonical transaction order deterministic presence
        operations.push({ type: 'DeleteObservations', observationIds: obsoleteObservationIds });

        // 2. Delete explicitly orphaned facts
        const orphanedFactIds: string[] = [];
        
        for (const obsoleteObs of obsoleteObservations) {
            const factId = obsoleteObs.factId;
            // If the fact is being re-inserted in this transaction, it is obviously not orphaned
            if (uniqueFacts.has(factId)) {
                continue;
            }
            
            // Otherwise, check if ANY other observations still reference it globally
            const allStoreObsForFact = this.store.getObservationsByFactId(factId);
            
            // Subtract the obsolete ones we are about to delete
            const remainingObs = allStoreObsForFact.filter(storeObs => !obsoleteObservationIds.includes(storeObs.observationId));
            
            if (remainingObs.length === 0) {
                if (!orphanedFactIds.includes(factId)) {
                    orphanedFactIds.push(factId);
                }
            }
        }
        orphanedFactIds.sort();

        operations.push({ type: 'DeleteOrphanFacts', factIds: orphanedFactIds });

        // 3. InsertFacts
        for (const fact of sortedFacts) {
            operations.push({ type: 'InsertFact', fact });
        }

        // 4. InsertObservations
        for (const observation of sortedObservations) {
            operations.push({ type: 'InsertObservation', observation });
        }

        // 5. CommitTransaction
        operations.push({ type: 'CommitTransaction' });

        return operations;
    }
}
