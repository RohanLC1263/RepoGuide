import { GroundTruth, EvaluationCandidate, EvaluationResult, ProviderQualityMetrics, RepositoryBrainQualityMetrics } from './evaluationModels';
import { ComparisonStrategy } from './comparisonStrategy';
import { randomUUID } from 'crypto';

export class EvaluationEngine {
    
    /**
     * Evaluates a candidate against ground truth using the provided strategy.
     */
    public evaluate(candidate: EvaluationCandidate, truth: GroundTruth, strategy: ComparisonStrategy): EvaluationResult {
        const comparison = strategy.compare(candidate, truth);

        // Calculate precision & recall globally for provider
        const precision = (comparison.truePositives + comparison.falsePositives) === 0 
            ? 1 
            : comparison.truePositives / (comparison.truePositives + comparison.falsePositives);
            
        const recall = (comparison.truePositives + comparison.falseNegatives) === 0 
            ? 1 
            : comparison.truePositives / (comparison.truePositives + comparison.falseNegatives);

        const providerQuality: ProviderQualityMetrics = {
            precision,
            recall,
            falsePositives: comparison.falsePositives,
            falseNegatives: comparison.falseNegatives
        };

        // For CP3A.5, Repo Brain Quality is a placeholder metric linked to Provider Quality, 
        // to be expanded later when the graph and querying are fully integrated.
        const repositoryBrainQuality: RepositoryBrainQualityMetrics = {
            knowledgeCoverage: recall,
            knownUnknownCalibration: precision,
            reasoningReadinessScore: (precision + recall) / 2
        };

        return {
            evaluationId: randomUUID(),
            timestampMs: Date.now(),
            fixtureId: truth.id,
            candidateIdentifier: candidate.identifier,
            providerQuality,
            repositoryBrainQuality,
            capabilityResults: comparison.capabilityEvaluations,
            extractionMetrics: candidate.result.metrics,
            findings: comparison.findings
        };
    }
}
