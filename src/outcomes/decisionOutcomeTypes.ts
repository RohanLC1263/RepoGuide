export interface DecisionOutcome {
    entityType: "ADR" | "INTENT" | "SUBSYSTEM" | string;
    entityId: string;
    outcomeType: "SUCCESSFUL" | "STABLE" | "DEGRADING" | "FAILED";
    outcomeScore: number;
    confidenceScore: number;
    evidenceCount: number;
    incidentCount: number;
    reviewFailureCount: number;
    healthTrend: "IMPROVING" | "STABLE" | "DEGRADING";
    validityTrend: "IMPROVING" | "STABLE" | "DEGRADING";
    calculatedAt: string;
}

export interface OutcomeEvidence {
    entityType: string;
    entityId: string;
    evidenceType: "HEALTH" | "VALIDITY" | "EVOLUTION" | "REVIEW" | "INCIDENT";
    evidenceId: string;
    evidenceText: string;
}

export interface DecisionOutcomeSnapshot {
    entityType: string;
    entityId: string;
    snapshotDate: string;
    outcomeType: string;
    outcomeScore: number;
    confidenceScore: number;
    evidenceCount: number;
}
