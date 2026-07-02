export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ReviewDepth = "LIGHT" | "STANDARD" | "DEEP" | "ARCHITECTURAL";
export type EvidenceType = "EXPERTISE" | "ADR" | "BLAST_RADIUS" | "COUPLING" | "HOTSPOT";

export interface ReviewRecommendation {
    id: string;
    changeId: string;
    riskLevel: RiskLevel;
    reviewDepth: ReviewDepth;
    reviewerCount: number;
    createdAt: Date;
}

export interface ReviewRecommendedReviewer {
    recommendationId: string;
    authorEmail: string;
    reviewerScore: number;
}

export interface ReviewScope {
    recommendationId: string;
    filePath: string;
    scopeType: "CHANGED" | "IMPACTED" | "COUPLED" | "GOVERNED";
}

export interface ReviewEvidence {
    recommendationId: string;
    evidenceType: EvidenceType;
    evidenceId: string;
    evidenceText: string;
}

export interface ReviewOutcome {
    reviewId: string;
    entityType: string;
    entityId: string;
    reviewerEmail: string;
    reviewerName: string;
    reviewerAccepted: boolean;
    defectsFound: number;
    postMergeIncidents: number;
    reviewDurationHours: number;
    createdAt: Date;
}
