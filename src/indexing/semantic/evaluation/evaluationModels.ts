import { RepositoryEntity, RepositoryRelationship, KnownUnknown, ExtractionMetrics, SemanticExtractionResult } from '../semanticProviderContract';

export interface GroundTruthMetadata {
    source: 'manual' | 'generated' | 'enterprise_dataset' | 'benchmark_suite';
    creationMethod: string;
    approvalStatus: 'approved' | 'pending' | 'rejected';
    provenance: string;
}

export interface GroundTruth {
    id: string;
    version: string;
    description: string;
    metadata: GroundTruthMetadata;
    expectedEntities: RepositoryEntity[];
    expectedRelationships: RepositoryRelationship[];
    expectedUnknowns: KnownUnknown[];
}

export interface EvaluationCandidate {
    identifier: string;             // e.g., 'tree-sitter-legacy', 'ts-compiler-v1'
    source: string;                 // e.g., 'ExtractionCoordinator'
    result: SemanticExtractionResult;
}

export type FindingCategory = 
    | 'Extraction Error'
    | 'Resolution Error'
    | 'Relationship Error'
    | 'Coverage Gap'
    | 'Calibration Error'
    | 'Performance Issue';

export interface EvaluationFinding {
    id: string;
    severity: 'critical' | 'warning' | 'info';
    category: FindingCategory;
    affectedCapabilityId?: string;
    recommendation: string;
    evidence?: string;
}

export interface ProviderQualityMetrics {
    precision: number;
    recall: number;
    falsePositives: number;
    falseNegatives: number;
}

export interface RepositoryBrainQualityMetrics {
    knowledgeCoverage: number;       // Holistic graph coverage
    knownUnknownCalibration: number; // Are blind spots correctly identified?
    reasoningReadinessScore: number;
}

export interface CapabilityEvaluation {
    capabilityId: string;
    precision: number;
    recall: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
}

export interface EvaluationResult {
    evaluationId: string;            // Stable uuid for trend tracking
    timestampMs: number;
    fixtureId: string;               // Links back to GroundTruth.id
    candidateIdentifier: string;
    
    // Separation of Quality
    providerQuality: ProviderQualityMetrics;
    repositoryBrainQuality: RepositoryBrainQualityMetrics;
    
    capabilityResults: CapabilityEvaluation[];
    extractionMetrics: ExtractionMetrics;
    findings: EvaluationFinding[];
}
