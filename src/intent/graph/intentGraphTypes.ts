import { IntentEntity } from '../extraction/intentTypes';

export type IntentRelationshipType =
    | "RELATED_TO"
    | "SUPPORTS"
    | "CO_OCCURS_WITH"
    | "CONFLICTS_WITH"
    | "EVOLVES_INTO"
    | "GOVERNS";

export interface IntentGraphEdge {
    id: string; // hash(sourceIntentId + targetIntentId + relationshipType)
    sourceIntentId: string;
    targetIntentId: string;
    relationshipType: IntentRelationshipType;
    weight: number;
    confidence: number;
    adrEvidenceCount: number;
    prEvidenceCount: number;
    commitEvidenceCount: number;
}

export interface IntentNeighborhood {
    centerIntentId: string;
    intents: IntentEntity[];
    edges: IntentGraphEdge[];
}

export interface IntentGraphMetrics {
    nodeCount: number;
    edgeCount: number;
    mostCentralIntents: string[];
    averageDegree: number;
}
