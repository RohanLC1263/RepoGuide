export type ExplanationType = "SUCCESS" | "FAILURE" | "DEGRADATION" | "RECOVERY";
export type FactorType = "HEALTH" | "VALIDITY" | "HOTSPOT" | "REVIEW" | "INCIDENT" | "EVOLUTION";
export type RelationshipType = "CONTRIBUTED_TO" | "PRECEDED" | "AMPLIFIED" | "CORRELATED_WITH";

export interface CausalExplanation {
    id: string;
    entityType: string; // ADR, INTENT, SUBSYSTEM
    entityId: string;
    outcomeId: string;
    explanationType: ExplanationType;
    confidenceScore: number;
    generatedAt: string;
}

export interface CausalFactor {
    explanationId: string;
    factorType: FactorType;
    factorId: string;
    contributionScore: number;
    description: string;
}

export interface CausalChain {
    explanationId: string;
    sequenceOrder: number;
    sourceEventId: string;
    targetEventId: string;
    relationship: RelationshipType;
}

export interface CausalEvidence {
    explanationId: string;
    evidenceType: FactorType;
    evidenceId: string;
    evidenceText: string;
}
