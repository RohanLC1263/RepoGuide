export interface MemoryEvalExpectations {
    expectedMemoryUsage?: boolean;
    expectedMentorCapability?: string;
    expectedMemoryCount?: number;
    expectedProvenanceTypes?: string[];
    expectedStaleMemoryBehavior?: 'ignore' | 'acknowledge' | 'reject';
    expectedRoutingBehavior?: 'override_rejected' | 'routed_correctly';
}

export interface MemoryEvalReport {
    timestamp: string;
    totalTests: number;
    passed: number;
    failed: number;
    gates: MemoryGateResults;
}

export interface MemoryGateResults {
    safetyPass: boolean;
    routingPass: boolean;
    stalenessPass: boolean;
    provenancePass: boolean;
    liftPass: boolean;
}
