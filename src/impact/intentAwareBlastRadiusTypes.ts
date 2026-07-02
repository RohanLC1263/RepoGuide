export type GovernanceSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface IntentAwareImpact {
    id: string;
    rootNodeId: string;
    governanceSnapshotVersion: string;
    impactedNodeIds: string[];
    impactedADRIds: string[];
    impactedIntentIds: string[];
    impactedNeighborIntentIds: string[];
    governanceScore: number;
    governanceSeverity: GovernanceSeverity;
    generatedAt: Date;
}

export interface IntentImpactPath {
    impactId: string;
    rootNodeId: string;
    impactedNodeId: string;
    adrId: string;
    intentId: string;
    pathLength: number;
}

export type GovernanceEvidenceType = "ADR_LINK" | "INTENT_LINK" | "INTENT_GRAPH";

export interface GovernanceEvidence {
    impactId: string;
    evidenceType: GovernanceEvidenceType;
    sourceId: string;
    targetId: string;
}
