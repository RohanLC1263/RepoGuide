export type DriftType = 
    | "MISSING_IMPLEMENTATION"
    | "ORPHANED_IMPLEMENTATION"
    | "INTENT_MISMATCH"
    | "GOVERNANCE_VIOLATION"
    | "STALE_DECISION"
    | "EXCESSIVE_COUPLING";

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type ResolutionState = "ACTIVE" | "RESOLVED";

export type DriftTrend = "IMPROVING" | "STABLE" | "DEGRADING";

export interface DriftFinding {
    id: string; // Deterministic hash
    entityId: string; // The subsystem this finding belongs to
    driftType: DriftType;
    severity: Severity;
    
    adrId?: string;
    intentId?: string;
    nodeId?: string;
    
    confidence: number;
    evidenceCount: number;
    
    firstDetectedAt: Date;
    lastDetectedAt: Date;
    resolvedAt?: Date;
    lifetimeDays?: number;
    
    resolutionState: ResolutionState;
    suppressed: boolean;
    ownerEmail?: string;
}

export interface DriftEntity {
    id: string; // ADR_ID, INTENT_ID, or 'UNGOVERNED_CLUSTER'
    entityType: "ADR" | "INTENT" | "UNGOVERNED_CLUSTER";
    driftScore: number;
    
    findings: DriftFinding[];
    affectedADRs: string[];
    affectedIntents: string[];
    
    firstDetectedAt: Date;
    lastDetectedAt: Date;
    
    healthScore: number;
    driftTrend: DriftTrend;
    resolutionState: ResolutionState;
    suppressed: boolean;
    ownerEmail?: string;
}

export interface DriftEvidence {
    findingId: string;
    evidenceType: "ADR" | "NODE" | "INTENT" | "COUPLING" | "COMMIT";
    evidenceId: string;
    evidenceText: string;
}

export interface DriftHistorySnapshot {
    findingId: string;
    snapshotDate: Date;
    severity: Severity;
    healthScore: number;
}

export interface ArchitecturalHealth {
    entityId: string;
    entityType: "ADR" | "INTENT" | "UNGOVERNED_CLUSTER";
    healthScore: number;
    activeFindings: number;
    criticalFindings: number;
    trend: DriftTrend;
    calculatedAt: Date;
}

export interface DriftQueryEngineApi {
    getFindings(): DriftFinding[];
    getCriticalFindings(): DriftFinding[];
    getDriftForEntity(entityId: string): DriftFinding[];
    getEntities(): DriftEntity[];
    getArchitecturalHealth(entityId: string): ArchitecturalHealth | null;
    getOverallArchitecturalHealth(): ArchitecturalHealth[];
    getEvidenceForFinding(findingId: string): DriftEvidence[];
    getHistoryForFinding(findingId: string): DriftHistorySnapshot[];
}
