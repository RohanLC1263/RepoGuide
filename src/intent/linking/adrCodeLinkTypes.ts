export type ADRCodeRelationshipType = "GOVERNS";

export interface ADRCodeLink {
    id: string; // hash(adrId + nodeId)
    adrId: string;
    nodeId: string;
    relationshipType: ADRCodeRelationshipType;
    confidence: number;
    evidenceCount: number;
    score: number;
}

export type ADRCodeEvidenceType = "INTENT_MATCH" | "SYMBOL_MATCH" | "PATH_MATCH";

export interface ADRCodeEvidence {
    linkId: string;
    adrId: string;
    nodeId: string;
    evidenceType: ADRCodeEvidenceType;
    evidence: string;
    scoreContribution: number;
}
