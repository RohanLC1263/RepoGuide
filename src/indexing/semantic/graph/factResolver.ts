import { IShadowGraphStore } from '../shadowGraphStoreContract';
import { GraphUpdateRequest, GraphRecomputationPlan } from './graphRecomputationModels';
import { CanonicalFact } from '../canonicalFact';

export class FactResolver {
    /**
     * Materializes the requested graph facts by retrieving them from the Store.
     * Preserves deterministic ordering.
     */
    public static resolve(request: GraphUpdateRequest, store: IShadowGraphStore): GraphRecomputationPlan {
        const contextualFacts: CanonicalFact[] = [];
        
        // If the store supported retrieving multiple facts by ID, we would use that.
        // Currently IShadowGraphStore supports getAllFacts() or getObservationsByFactId() / getObservationsByProvenance().
        // Since we need CanonicalFacts, and getObservationsByFactId returns FactObservation (which has a `fact` property),
        // we could use `store.getObservationsByFactId()`. But `getAllFacts()` is already in the contract and we can filter.
        
        // Use a set for fast lookup
        const requiredIds = new Set(request.requiredContextFactIds);
        
        if (requiredIds.size > 0) {
            const allFacts = store.getAllFacts();
            for (const fact of allFacts) {
                if (requiredIds.has(fact.factId)) {
                    contextualFacts.push(fact);
                }
            }
        }

        // Deterministically sort the resolved contextual facts
        contextualFacts.sort((a, b) => a.factId.localeCompare(b.factId));

        return {
            delta: request.delta,
            contextualFacts
        };
    }
}
