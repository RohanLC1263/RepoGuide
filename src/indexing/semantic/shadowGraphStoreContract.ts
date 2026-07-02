import { CanonicalFact, FactObservation } from './canonicalFact';

export type GraphOperation =
    | { type: 'DeleteObservations'; observationIds: string[] }
    | { type: 'DeleteOrphanFacts'; factIds: string[] }
    | { type: 'InsertFact'; fact: CanonicalFact }
    | { type: 'InsertObservation'; observation: FactObservation }
    | { type: 'CommitTransaction' };

export interface IShadowGraphStore {
    getObservationsByProvenance(provenance: string): FactObservation[];
    getObservationsByFactId(factId: string): FactObservation[];
    getAllFacts(): CanonicalFact[];
    applyOperations(operations: GraphOperation[]): void;
}
