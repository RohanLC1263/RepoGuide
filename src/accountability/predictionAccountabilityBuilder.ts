import { RepositoryBuilder } from '../orchestrator/orchestratorTypes';
import { PredictionAccountabilityStore } from './predictionAccountabilityStore';

export class PredictionAccountabilityBuilder implements RepositoryBuilder {
    constructor(private store: PredictionAccountabilityStore) {}

    public async build(): Promise<void> {
        try {
            this.buildOutcomes();
            this.computeMetrics();
            this.cleanupStaleData();
        } catch (e) {
            console.error('Accountability Layer encountered non-fatal error:', e);
            // Do not throw to avoid crashing orchestrator
        }
    }

    private buildOutcomes(): void {
        const db = this.store.getDatabase();
        // Mature horizon: 30 days ago
        const matureHorizon = Date.now() - (30 * 24 * 60 * 60 * 1000);
        
        // We need an array intersection function in SQLite.
        // Since we don't have one natively, we will use a simplified string check for MVP
        // In a real app we might register a custom function, but for MVP we will use JSON functions or LIKE.
        // If expected contains actual, or vice versa.
        db.function('check_incident_type_match', (expectedStr: any, actualStr: any) => {
            if (!actualStr) return null;
            try {
                const expected = JSON.parse(expectedStr || '[]');
                const actual = JSON.parse(actualStr || '[]');
                if (!Array.isArray(expected) || !Array.isArray(actual)) return 'TYPE_MISMATCH';

                if (expected.length === actual.length && expected.every(e => actual.includes(e))) {
                    return 'TYPE_MATCH';
                }
                const intersection = expected.filter(e => actual.includes(e));
                if (intersection.length > 0) return 'PARTIAL_MATCH';
                return 'TYPE_MISMATCH';
            } catch {
                return 'TYPE_MISMATCH';
            }
        });

        // The query groups incident_events by time horizon relative to the prediction timestamp.
        db.exec(`
            INSERT INTO prediction_outcomes (prediction_hash, outcome_timestamp, incident_occurred, incident_type_match, resolution_state)
            SELECT 
                p.prediction_hash,
                CAST(strftime('%s', 'now') AS INTEGER) * 1000,
                CASE WHEN i.incident_count > 0 THEN 1 ELSE 0 END,
                CASE WHEN i.incident_count > 0 THEN check_incident_type_match(p.expected_incident_types, i.actual_incident_types) ELSE NULL END,
                CASE 
                    WHEN p.failure_probability >= 0.4 AND i.incident_count > 0 THEN 'TRUE_POSITIVE'
                    WHEN p.failure_probability < 0.4 AND i.incident_count = 0 THEN 'TRUE_NEGATIVE'
                    WHEN p.failure_probability >= 0.4 AND i.incident_count = 0 THEN 'FALSE_POSITIVE'
                    ELSE 'FALSE_NEGATIVE'
                END
            FROM prediction_snapshots p
            LEFT JOIN (
                -- Subquery to aggregate incidents occurring within 30 days of the snapshot
                SELECT 
                    s.prediction_hash,
                    COUNT(e.id) as incident_count,
                    json_group_array(e.incident_type) as actual_incident_types
                FROM prediction_snapshots s
                JOIN incident_events e 
                    ON CAST(e.timestamp AS INTEGER) BETWEEN s.timestamp AND (s.timestamp + 2592000000)
                GROUP BY s.prediction_hash
            ) i ON i.prediction_hash = p.prediction_hash
            WHERE p.timestamp <= ${matureHorizon}
              AND p.prediction_hash NOT IN (SELECT prediction_hash FROM prediction_outcomes)
        `);
    }

    private computeMetrics(): void {
        const db = this.store.getDatabase();
        // Compute Brier Score (30 days window)
        db.exec(`
            INSERT OR REPLACE INTO prediction_metrics (metric_name, engine_version, window_days, metric_value, computed_at)
            SELECT 
                'brier_score',
                p.prediction_engine_version,
                30,
                AVG( (p.failure_probability - o.incident_occurred) * (p.failure_probability - o.incident_occurred) ),
                CAST(strftime('%s', 'now') AS INTEGER) * 1000
            FROM prediction_snapshots p
            JOIN prediction_outcomes o ON p.prediction_hash = o.prediction_hash
            WHERE p.timestamp >= (CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 5184000000) -- 60 days
            GROUP BY p.prediction_engine_version;
        `);

        // Compute FPR (30 days window)
        db.exec(`
            INSERT OR REPLACE INTO prediction_metrics (metric_name, engine_version, window_days, metric_value, computed_at)
            SELECT 
                'false_positive_rate',
                p.prediction_engine_version,
                30,
                CAST(SUM(CASE WHEN o.resolution_state = 'FALSE_POSITIVE' THEN 1 ELSE 0 END) AS REAL) / 
                MAX(1, SUM(CASE WHEN o.resolution_state IN ('FALSE_POSITIVE', 'TRUE_NEGATIVE') THEN 1 ELSE 0 END)),
                CAST(strftime('%s', 'now') AS INTEGER) * 1000
            FROM prediction_snapshots p
            JOIN prediction_outcomes o ON p.prediction_hash = o.prediction_hash
            WHERE p.timestamp >= (CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 5184000000)
            GROUP BY p.prediction_engine_version;
        `);

        // Compute FNR (30 days window)
        db.exec(`
            INSERT OR REPLACE INTO prediction_metrics (metric_name, engine_version, window_days, metric_value, computed_at)
            SELECT 
                'false_negative_rate',
                p.prediction_engine_version,
                30,
                CAST(SUM(CASE WHEN o.resolution_state = 'FALSE_NEGATIVE' THEN 1 ELSE 0 END) AS REAL) / 
                MAX(1, SUM(CASE WHEN o.resolution_state IN ('FALSE_NEGATIVE', 'TRUE_POSITIVE') THEN 1 ELSE 0 END)),
                CAST(strftime('%s', 'now') AS INTEGER) * 1000
            FROM prediction_snapshots p
            JOIN prediction_outcomes o ON p.prediction_hash = o.prediction_hash
            WHERE p.timestamp >= (CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 5184000000)
            GROUP BY p.prediction_engine_version;
        `);
        
        // Incident Type Precision (Derived)
        db.exec(`
            INSERT OR REPLACE INTO prediction_metrics (metric_name, engine_version, window_days, metric_value, computed_at)
            SELECT 
                'incident_type_precision',
                p.prediction_engine_version,
                30,
                CAST(SUM(CASE WHEN o.incident_type_match IN ('TYPE_MATCH', 'PARTIAL_MATCH') THEN 1 ELSE 0 END) AS REAL) / 
                MAX(1, SUM(CASE WHEN o.incident_occurred = 1 THEN 1 ELSE 0 END)),
                CAST(strftime('%s', 'now') AS INTEGER) * 1000
            FROM prediction_snapshots p
            JOIN prediction_outcomes o ON p.prediction_hash = o.prediction_hash
            WHERE p.timestamp >= (CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 5184000000)
            GROUP BY p.prediction_engine_version;
        `);
    }

    private cleanupStaleData(): void {
        const db = this.store.getDatabase();
        const oneYearAgo = Date.now() - (365 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

        db.exec(`
            DELETE FROM prediction_outcomes WHERE outcome_timestamp < ${oneYearAgo};
            DELETE FROM prediction_snapshots WHERE timestamp < ${oneYearAgo};
            DELETE FROM prediction_metrics WHERE computed_at < ${thirtyDaysAgo} AND window_days > 0;
        `);
    }
}
