import { CanonicalFact } from '../canonicalFact';

export interface GraphDelta {
    readonly addedFacts: CanonicalFact[];
    readonly removedFactIds: string[];
}

export interface GraphUpdateRequest {
    readonly delta: GraphDelta;
    readonly requiredContextFactIds: string[];
}

export interface GraphRecomputationPlan {
    readonly delta: GraphDelta;
    readonly contextualFacts: CanonicalFact[];
}
