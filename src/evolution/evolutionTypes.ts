export type EvolutionEntityType = "ADR" | "INTENT" | "SUBSYSTEM";

export type EvolutionStatus = "EMERGING" | "ACTIVE" | "STABLE" | "DECLINING" | "OBSOLETE";

export type EvolutionEventType =
    | "CREATED"
    | "MODIFIED"
    | "EXPANDED"
    | "CONTRACTED"
    | "HEALTH_CHANGED"
    | "RISK_CHANGED"
    | "OWNERSHIP_CHANGED"
    | "VALIDITY_CHANGED"
    | "DRIFT_INTRODUCED"
    | "DRIFT_RESOLVED"
    | "EVOLUTION_MILESTONE";

export type EvolutionEvidenceType = "ADR" | "INTENT" | "COMMIT" | "HEALTH" | "HOTSPOT" | "VALIDITY" | "DRIFT";

export interface EvolutionEntity {
    id: string;
    entityType: EvolutionEntityType;
    entityId: string;
    firstSeenAt: Date;
    lastSeenAt: Date;
    currentState: string;
    evolutionVelocity: number;
    changeCount: number;
    status: EvolutionStatus;
}

export interface EvolutionEvent {
    id: string;
    entityId: string;
    timestamp: Date;
    eventType: EvolutionEventType;
    oldValue: string;
    newValue: string;
    importanceScore: number;
}

export interface EvolutionEvidence {
    eventId: string;
    evidenceType: EvolutionEvidenceType;
    evidenceId: string;
    evidenceText: string;
}

export interface EvolutionSnapshot {
    entityId: string;
    snapshotDate: Date;
    healthScore: number;
    validityScore: number;
    hotspotScore: number;
    busFactor: number;
    nodeCount: number;
}

export interface EvolutionTimeline {
    entityId: string;
    snapshots: EvolutionSnapshot[];
}
