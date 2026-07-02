import { CausalReasoningStore } from './causalReasoningStore';
import { CausalExplanation, CausalFactor, CausalChain, CausalEvidence } from './causalReasoningTypes';

export class CausalReasoningQueryEngine {
    constructor(private store: CausalReasoningStore) {}

    public getExplanation(entityType: string, entityId: string): CausalExplanation | null {
        const row = this.store.getDatabase().prepare(
            `SELECT * FROM causal_explanations WHERE entity_type = ? AND entity_id = ? ORDER BY generated_at DESC LIMIT 1`
        ).get(entityType, entityId) as any;

        if (!row) return null;
        return {
            id: row.id,
            entityType: row.entity_type,
            entityId: row.entity_id,
            outcomeId: row.outcome_id,
            explanationType: row.explanation_type,
            confidenceScore: row.confidence_score,
            generatedAt: row.generated_at
        };
    }

    public getFactors(explanationId: string): CausalFactor[] {
        const rows = this.store.getDatabase().prepare(
            `SELECT * FROM causal_factors WHERE explanation_id = ? ORDER BY contribution_score DESC`
        ).all(explanationId) as any[];

        return rows.map(row => ({
            explanationId: row.explanation_id,
            factorType: row.factor_type,
            factorId: row.factor_id,
            contributionScore: row.contribution_score,
            description: row.description
        }));
    }

    public getChains(explanationId: string): CausalChain[] {
        const rows = this.store.getDatabase().prepare(
            `SELECT * FROM causal_chains WHERE explanation_id = ? ORDER BY sequence_order ASC`
        ).all(explanationId) as any[];

        return rows.map(row => ({
            explanationId: row.explanation_id,
            sequenceOrder: row.sequence_order,
            sourceEventId: row.source_event_id,
            targetEventId: row.target_event_id,
            relationship: row.relationship
        }));
    }

    public getRootCause(entityType: string, entityId: string): CausalFactor | null {
        const explanation = this.getExplanation(entityType, entityId);
        if (!explanation) return null;

        const factors = this.getFactors(explanation.id);
        if (factors.length === 0) return null;

        // The root cause is the factor with the highest contribution score
        return factors[0];
    }
}
