import { DatabaseSync } from 'node:sqlite';
import { ChangeImpactStore } from './changeImpactStore';

export class ChangeImpactBuilder {
    constructor(private db: DatabaseSync, private store: ChangeImpactStore) {}

    public async build(): Promise<void> {
        this.store.truncateFrequencies();
        this.store.truncatePredictions();

        this.buildFrequencies();
        this.buildBasePredictions();
    }

    private buildFrequencies() {
        // Laplace smoothed probability calculation
        this.db.exec(`
            INSERT INTO change_risk_frequencies (feature_name, total_occurrences, incident_occurrences, probability)
            SELECT 
                factor_type,
                COUNT(*),
                SUM(CASE WHEN i.id IS NOT NULL THEN 1 ELSE 0 END),
                CAST((SUM(CASE WHEN i.id IS NOT NULL THEN 1 ELSE 0 END) + 1.0) AS REAL) / (COUNT(*) + 20.0)
            FROM incident_factors f
            LEFT JOIN incident_events i ON i.id = f.incident_id AND i.severity != 'RESOLVED'
            GROUP BY factor_type;
        `);
    }

    private buildBasePredictions() {
        // Create active entities list
        this.db.exec(`
            CREATE TEMP TABLE IF NOT EXISTS impact_active_entities AS
            SELECT DISTINCT entity_id FROM incident_predictions;
        `);

        // Compute base failure probability
        const rows = this.db.prepare(`
            SELECT 
                e.entity_id,
                COALESCE(ip.risk_score, 0) / 100.0 as base_risk,
                COALESCE(ip.primary_risk_driver, 'UNKNOWN') as driver
            FROM impact_active_entities e
            JOIN incident_predictions ip ON ip.entity_id = e.entity_id
        `).all() as any[];

        const stmt = this.db.prepare(`
            INSERT INTO change_risk_predictions (entity_id, base_failure_probability, primary_risk_driver, sample_size)
            VALUES (?, ?, ?, ?)
        `);

        for (const row of rows) {
            stmt.run(row.entity_id, row.base_risk, row.driver, 100); // 100 is dummy sample size
        }
    }
}
