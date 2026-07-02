export type HotspotSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface KnowledgeHotspot {
    id: string;
    entityType: "ADR" | "INTENT" | "UNGOVERNED_CLUSTER";
    entityId: string;
    
    hotspotScore: number;
    severity: HotspotSeverity;
    
    busFactor: number;
    expertCount: number;
    knowledgeConcentrationScore: number; // topExpertiseScore / sum(allExpertiseScores)
    
    healthScore: number;
    blastRadiusScore: number;
    couplingScore: number;
}

export interface HotspotEvidence {
    hotspotId: string;
    evidenceType: "EXPERT" | "HEALTH" | "BLAST_RADIUS" | "COUPLING";
    evidenceId: string;
    evidenceText: string;
}

export interface HotspotHistorySnapshot {
    hotspotId: string;
    snapshotDate: Date;
    severity: HotspotSeverity;
    hotspotScore: number;
}

export interface KnowledgeHotspotQueryEngineApi {
    getHotspots(): KnowledgeHotspot[];
    getCriticalHotspots(): KnowledgeHotspot[];
    getHotspot(entityId: string): KnowledgeHotspot | null;
    getMostRiskySubsystems(): KnowledgeHotspot[];
    getBusFactorRisks(): KnowledgeHotspot[];
    getEvidence(hotspotId: string): HotspotEvidence[];
    getHistory(hotspotId: string): HotspotHistorySnapshot[];
}
