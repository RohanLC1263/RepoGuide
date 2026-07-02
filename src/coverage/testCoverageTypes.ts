export type CoverageStatus = 'EXCELLENT' | 'GOOD' | 'WEAK' | 'CRITICAL';
export type CoverageSourceType = 'JEST' | 'VITEST' | 'COVERAGE_REPORT' | 'STATIC_MAPPING';
export type CoverageRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface CoverageEntity {
    entityType: 'FILE' | 'FUNCTION' | 'ADR' | 'SUBSYSTEM';
    entityId: string;
    coveragePercent: number;
    coveredLines: number;
    totalLines: number;
    coverageStatus: CoverageStatus;
    calculatedAt: string;
}

export interface CoverageEvidence {
    coverageId: string; // usually entityId for FILE
    sourceType: CoverageSourceType;
    sourceId: string;
    evidenceText: string;
}

export interface CoverageSnapshot {
    entityType: 'FILE' | 'FUNCTION' | 'ADR' | 'SUBSYSTEM';
    entityId: string;
    snapshotDate: string;
    coveragePercent: number;
}

export interface CoverageRisk {
    entityType: 'FILE' | 'FUNCTION' | 'ADR' | 'SUBSYSTEM';
    entityId: string;
    riskScore: number;
    riskLevel: CoverageRiskLevel;
}

export interface CoverageQueryEngine {
    getCoverage(entityType: string, entityId: string): CoverageEntity | null;
    getWeakCoverage(): CoverageEntity[];
    getCriticalCoverage(): CoverageEntity[];
    getCoverageHistory(entityType: string, entityId: string): CoverageSnapshot[];
    getCoverageRisk(entityType: string, entityId: string): CoverageRisk | null;
    getMostDangerousUntestedAreas(): (CoverageEntity & CoverageRisk)[];
}
