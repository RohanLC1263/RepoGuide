import { DatabaseSync } from 'node:sqlite';
import { DecisionOutcome, DecisionOutcomeSnapshot } from './decisionOutcomeTypes';

export class DecisionOutcomeQueryEngine {
    constructor(private db: DatabaseSync) {}

    public getOutcome(entityType: string, entityId: string): DecisionOutcome | null {
        const row = this.db.prepare(
            `SELECT * FROM decision_outcomes WHERE entity_type = ? AND entity_id = ?`
        ).get(entityType, entityId) as any;
        if (!row) return null;
        return this.mapToOutcome(row);
    }

    public getOutcomes(): DecisionOutcome[] {
        const rows = this.db.prepare(`SELECT * FROM decision_outcomes ORDER BY outcome_score DESC LIMIT 10`).all() as any[];
        return rows.map(r => this.mapToOutcome(r));
    }

    public getSuccessfulDecisions(): DecisionOutcome[] {
        const rows = this.db.prepare(`SELECT * FROM decision_outcomes WHERE outcome_type = 'SUCCESSFUL' ORDER BY outcome_score DESC LIMIT 10`).all() as any[];
        return rows.map(r => this.mapToOutcome(r));
    }

    public getFailedDecisions(): DecisionOutcome[] {
        const rows = this.db.prepare(`SELECT * FROM decision_outcomes WHERE outcome_type = 'FAILED' ORDER BY outcome_score ASC LIMIT 10`).all() as any[];
        return rows.map(r => this.mapToOutcome(r));
    }

    public getMostImprovedSubsystems(): DecisionOutcome[] {
        const rows = this.db.prepare(
            `SELECT * FROM decision_outcomes WHERE health_trend = 'IMPROVING' AND outcome_type != 'FAILED' ORDER BY outcome_score DESC LIMIT 10`
        ).all() as any[];
        return rows.map(r => this.mapToOutcome(r));
    }

    public getMostDegradedSubsystems(): DecisionOutcome[] {
        const rows = this.db.prepare(
            `SELECT * FROM decision_outcomes WHERE health_trend = 'DEGRADING' ORDER BY outcome_score ASC LIMIT 10`
        ).all() as any[];
        return rows.map(r => this.mapToOutcome(r));
    }

    public getOutcomeHistory(entityType: string, entityId: string): DecisionOutcomeSnapshot[] {
        const rows = this.db.prepare(
            `SELECT * FROM outcome_history WHERE entity_type = ? AND entity_id = ? ORDER BY snapshot_date ASC`
        ).all(entityType, entityId) as any[];
        
        return rows.map(r => ({
            entityType: r.entity_type,
            entityId: r.entity_id,
            snapshotDate: r.snapshot_date,
            outcomeType: r.outcome_type,
            outcomeScore: r.outcome_score,
            confidenceScore: r.confidence_score,
            evidenceCount: r.evidence_count
        }));
    }

    private mapToOutcome(row: any): DecisionOutcome {
        return {
            entityType: row.entity_type,
            entityId: row.entity_id,
            outcomeType: row.outcome_type,
            outcomeScore: row.outcome_score,
            confidenceScore: row.confidence_score,
            evidenceCount: row.evidence_count,
            incidentCount: row.incident_count,
            reviewFailureCount: row.review_failure_count,
            healthTrend: row.health_trend,
            validityTrend: row.validity_trend,
            calculatedAt: row.calculated_at
        };
    }
}
