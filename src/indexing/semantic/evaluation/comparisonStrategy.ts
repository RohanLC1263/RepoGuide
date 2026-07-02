import { GroundTruth, EvaluationCandidate, EvaluationFinding, CapabilityEvaluation } from './evaluationModels';

export interface ComparisonResult {
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    findings: EvaluationFinding[];
    capabilityEvaluations: CapabilityEvaluation[];
}

export interface ComparisonStrategy {
    readonly name: string;
    compare(candidate: EvaluationCandidate, truth: GroundTruth): ComparisonResult;
}
