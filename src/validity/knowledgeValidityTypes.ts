export type KnowledgeValidityTier = "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW";
export type ValidityTrend = "IMPROVING" | "STABLE" | "DEGRADING";
export type EvidenceType = "AGE" | "EXPERT" | "HEALTH" | "DRIFT" | "HOTSPOT" | "REVIEW";

export interface KnowledgeValidity {
    id: string;
    entityType: "ADR" | "INTENT" | "SUBSYSTEM";
    entityId: string;
    validityScore: number;
    validityTier: KnowledgeValidityTier;
    confidenceScore: number;
    trend: ValidityTrend;
    lastValidatedAt: Date;
    evidenceCount: number;
}

export interface ValidityEvidence {
    validityId: string;
    evidenceType: EvidenceType;
    evidenceId: string;
    evidenceText: string;
}

export interface ValidityHistory {
    validityId: string;
    snapshotDate: Date;
    validityScore: number;
    confidenceScore: number;
}
