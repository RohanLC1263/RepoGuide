export type IntentType =
  | "SECURITY"
  | "PERFORMANCE"
  | "RELIABILITY"
  | "SCALABILITY"
  | "ARCHITECTURE"
  | "COMPLIANCE"
  | "MIGRATION"
  | "TECHNICAL_DEBT"
  | "OBSERVABILITY"
  | "DEVELOPER_EXPERIENCE"
  | "COST"
  | "TESTING"
  | "DATA_QUALITY"
  | "OTHER";

export interface IntentEntity {
    id: string; // hash(type + canonicalTopic)
    type: IntentType;
    canonicalTopic: string;
    confidence: number;
    evidenceCount: number;
    adrCount: number;
    prCount: number;
    commitCount: number;
    firstSeenAt: Date;
    lastSeenAt: Date;
}

export interface IntentEvidence {
    intentId: string;
    sourceType: "ADR" | "PR" | "COMMIT";
    sourceId: string;
    snippet: string;
    createdAt: Date;
}
