export interface LogicalCouplingEdge {
    id: string;
    sourcePath: string;
    targetPath: string;
    coChangeCount: number;
    confidence: number;
    firstSeenAt: Date;
    lastSeenAt: Date;
}

export interface FileChangeStats {
    path: string;
    changeCount: number;
    firstSeenAt: Date;
    lastSeenAt: Date;
}

export interface LogicalCouplingEvidence {
    edgeId: string;
    commitSha: string;
}

export interface LogicalCouplingQueryEngineApi {
    getCoupledFiles(path: string): LogicalCouplingEdge[];
    getStrongestCouplings(limit: number): LogicalCouplingEdge[];
    getCoupling(source: string, target: string): LogicalCouplingEdge | null;
}
