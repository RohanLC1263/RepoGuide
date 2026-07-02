import { GovernanceSeverity } from './intentAwareBlastRadiusTypes';

export class GovernanceScorer {
    // Scoring constants
    private static readonly SCORE_PER_ADR = 10;
    private static readonly SCORE_PER_INTENT = 5;
    private static readonly SCORE_PER_NEIGHBOR_INTENT = 2;

    // Saturation caps (Max limit per category to avoid uncontrolled inflation)
    private static readonly MAX_SCORE_ADR = 60; // Max 6 ADRs fully scored
    private static readonly MAX_SCORE_INTENT = 40; // Max 8 Intents fully scored
    private static readonly MAX_SCORE_NEIGHBOR = 20; // Max 10 Neighbors fully scored

    public calculateScore(
        uniqueADRCount: number,
        uniqueIntentCount: number,
        uniqueNeighborCount: number
    ): number {
        const adrScore = Math.min(uniqueADRCount * GovernanceScorer.SCORE_PER_ADR, GovernanceScorer.MAX_SCORE_ADR);
        const intentScore = Math.min(uniqueIntentCount * GovernanceScorer.SCORE_PER_INTENT, GovernanceScorer.MAX_SCORE_INTENT);
        const neighborScore = Math.min(uniqueNeighborCount * GovernanceScorer.SCORE_PER_NEIGHBOR_INTENT, GovernanceScorer.MAX_SCORE_NEIGHBOR);

        return adrScore + intentScore + neighborScore;
    }

    public determineSeverity(score: number): GovernanceSeverity {
        if (score <= 10) return "LOW";
        if (score <= 30) return "MEDIUM";
        if (score <= 60) return "HIGH";
        return "CRITICAL";
    }
}
