export type IncidentSourceType = "REVIEW" | "MANUAL" | "CI" | "RUNTIME";
export type IncidentSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface IncidentEvent {
    id: string;
    entityType: string;
    entityId: string;
    incidentType: string;
    sourceType: IncidentSourceType;
    severity: IncidentSeverity;
    timestamp: Date;
    resolvedAt?: Date;
    rootCauseDesc?: string;
}

export interface IncidentEvidence {
    eventId: string;
    evidenceType: string;
    evidenceId: string;
    evidenceText: string;
}

export interface IncidentHistory {
    entityId: string;
    snapshotDate: Date;
    incidentCount: number;
    criticalIncidentCount: number;
}
