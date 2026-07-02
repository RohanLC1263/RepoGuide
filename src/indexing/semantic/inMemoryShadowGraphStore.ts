import { CanonicalFact, FactObservation } from './canonicalFact';
import { IShadowGraphStore, GraphOperation } from './shadowGraphStoreContract';

export class InMemoryShadowGraphStore implements IShadowGraphStore {
    private facts = new Map<string, CanonicalFact>();
    private observations = new Map<string, FactObservation>();

    private ownershipIndex = new Map<string, Set<string>>();
    private factReferenceIndex = new Map<string, Set<string>>();

    public getFact(factId: string): CanonicalFact | undefined {
        return this.facts.get(factId);
    }

    public getObservation(observationId: string): FactObservation | undefined {
        return this.observations.get(observationId);
    }

    public getAllFacts(): CanonicalFact[] {
        return Array.from(this.facts.values()).sort((a, b) => a.factId.localeCompare(b.factId));
    }

    public getAllObservations(): FactObservation[] {
        return Array.from(this.observations.values()).sort((a, b) => a.observationId.localeCompare(b.observationId));
    }

    public getObservationsByProvenance(provenance: string): FactObservation[] {
        const obsIds = this.ownershipIndex.get(provenance) || new Set();
        const obs: FactObservation[] = [];
        for (const id of obsIds) {
            const o = this.observations.get(id);
            if (o) obs.push(o);
        }
        return obs.sort((a, b) => a.observationId.localeCompare(b.observationId));
    }

    public getObservationsByFactId(factId: string): FactObservation[] {
        const obsIds = this.factReferenceIndex.get(factId) || new Set();
        const obs: FactObservation[] = [];
        for (const id of obsIds) {
            const o = this.observations.get(id);
            if (o) obs.push(o);
        }
        return obs.sort((a, b) => a.observationId.localeCompare(b.observationId));
    }

    public applyOperations(operations: GraphOperation[]): void {
        const backupFacts = new Map(this.facts);
        const backupObservations = new Map(this.observations);
        // We also need to backup indices
        const backupOwnershipIndex = new Map<string, Set<string>>();
        for (const [k, v] of this.ownershipIndex.entries()) backupOwnershipIndex.set(k, new Set(v));
        const backupFactReferenceIndex = new Map<string, Set<string>>();
        for (const [k, v] of this.factReferenceIndex.entries()) backupFactReferenceIndex.set(k, new Set(v));

        try {
            for (const op of operations) {
                switch (op.type) {
                    case 'DeleteObservations': {
                        for (const obsId of op.observationIds) {
                            const obs = this.observations.get(obsId);
                            if (obs) {
                                this.ownershipIndex.get(obs.provenance)?.delete(obsId);
                                this.factReferenceIndex.get(obs.factId)?.delete(obsId);
                                this.observations.delete(obsId);
                            }
                        }
                        break;
                    }
                    case 'DeleteOrphanFacts': {
                        for (const factId of op.factIds) {
                            this.facts.delete(factId);
                        }
                        break;
                    }
                    case 'InsertFact': {
                        this.facts.set(op.fact.factId, op.fact);
                        break;
                    }
                    case 'InsertObservation': {
                        if (!this.facts.has(op.observation.factId)) {
                            throw new Error(`Referential Integrity Violation: Cannot insert observation for missing factId: ${op.observation.factId}`);
                        }
                        this.observations.set(op.observation.observationId, op.observation);
                        
                        if (!this.ownershipIndex.has(op.observation.provenance)) {
                            this.ownershipIndex.set(op.observation.provenance, new Set());
                        }
                        this.ownershipIndex.get(op.observation.provenance)!.add(op.observation.observationId);

                        if (!this.factReferenceIndex.has(op.observation.factId)) {
                            this.factReferenceIndex.set(op.observation.factId, new Set());
                        }
                        this.factReferenceIndex.get(op.observation.factId)!.add(op.observation.observationId);
                        break;
                    }
                    case 'CommitTransaction': {
                        break;
                    }
                    default: {
                        throw new Error(`Unknown operation type: ${(op as any).type}`);
                    }
                }
            }
        } catch (error) {
            this.facts = backupFacts;
            this.observations = backupObservations;
            this.ownershipIndex = backupOwnershipIndex;
            this.factReferenceIndex = backupFactReferenceIndex;
            throw error;
        }
    }
}
