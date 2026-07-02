import { PredictionAccountabilityStore } from './predictionAccountabilityStore';

export interface AccountabilityReport {
    brierScore: number | null;
    falsePositiveRate: number | null;
    falseNegativeRate: number | null;
    incidentTypePrecision: number | null;
    isTrustworthy: boolean;
}

export class PredictionAccountabilityQueryEngine {
    constructor(private store: PredictionAccountabilityStore) {}

    public getEngineTrustScore(version: string): AccountabilityReport {
        const db = this.store.getDatabase();
        const row = db.prepare(`
            SELECT 
                MAX(CASE WHEN metric_name = 'brier_score' THEN metric_value END) as brier,
                MAX(CASE WHEN metric_name = 'false_positive_rate' THEN metric_value END) as fpr,
                MAX(CASE WHEN metric_name = 'false_negative_rate' THEN metric_value END) as fnr,
                MAX(CASE WHEN metric_name = 'incident_type_precision' THEN metric_value END) as itp
            FROM prediction_metrics
            WHERE engine_version = ? AND window_days = 30
            ORDER BY computed_at DESC LIMIT 1
        `).get(version) as any;

        if (!row || row.brier == null) {
            return {
                brierScore: null,
                falsePositiveRate: null,
                falseNegativeRate: null,
                incidentTypePrecision: null,
                isTrustworthy: false
            };
        }

        return {
            brierScore: row.brier,
            falsePositiveRate: row.fpr,
            falseNegativeRate: row.fnr,
            incidentTypePrecision: row.itp,
            isTrustworthy: row.brier < 0.15 && row.fpr < 0.10 && row.fnr < 0.05
        };
    }
}
