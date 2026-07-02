import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';

export class RuntimeCalibrationBuilder {
    constructor(private db: DatabaseSync) {}

    public build(): void {
        this.computeCalibration();
    }

    private computeCalibration(): void {
        const fn = executeTransaction(this.db, () => {
            // Ensure incident_events exists just in case (for testing isolation)
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS incident_events (
                    id TEXT PRIMARY KEY,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    incident_type TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    trigger_metric TEXT NOT NULL,
                    trigger_value TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    payload TEXT
                );
            `);

            // Human-Only Filter Query
            const filter = `
                trigger_metric NOT LIKE '%REPOGUIDE_AUTOMATION%'
                AND trigger_metric NOT LIKE '%PREDICTIVE_BOT%'
                AND trigger_metric NOT LIKE '%CHAOS_MONKEY%'
                AND (payload IS NULL OR (
                    payload NOT LIKE '%"author":"bot"%'
                    AND payload NOT LIKE '%"type":"synthetic"%'
                ))
            `;

            const query = `
                SELECT trigger_metric as event_type, COUNT(*) as incident_count
                FROM incident_events
                WHERE ${filter}
                GROUP BY trigger_metric
            `;

            const empiricalCounts = this.db.prepare(query).all() as { event_type: string, incident_count: number }[];
            
            let totalIncidents = 0;
            for (const row of empiricalCounts) {
                totalIncidents += row.incident_count;
            }

            // Mode Determination
            let mode: 'COLD' | 'WARM' | 'CALIBRATED' = 'COLD';
            if (totalIncidents >= 30) mode = 'CALIBRATED';
            else if (totalIncidents >= 10) mode = 'WARM';

            // Calculate Entropy and Overfit Risk
            let entropy = 0;
            const numClasses = empiricalCounts.length;
            if (numClasses > 1) {
                for (const row of empiricalCounts) {
                    const p = row.incident_count / totalIncidents;
                    entropy -= p * Math.log2(p);
                }
            }
            
            const maxEntropy = numClasses > 1 ? Math.log2(numClasses) : 1;
            const normalizedEntropy = numClasses > 1 ? entropy / maxEntropy : 0;
            
            const diversityPenalty = numClasses === 0 ? 1 : (normalizedEntropy < 0.5 ? 0.6 : 1.0); // Simple penalty
            let confidenceScore = Math.min(1.0, totalIncidents / 30.0) * diversityPenalty;

            const defaultPriors: Record<string, number> = {
                'OOM': 0.8,
                'TIMEOUT': 0.5,
                'DEADLOCK': 0.7,
                'CRASH': 0.9,
                'DEFAULT': 0.1
            };

            const eventTypes = new Set(empiricalCounts.map(e => e.event_type));
            // Add known types so we provide floor probabilities
            Object.keys(defaultPriors).forEach(k => eventTypes.add(k));

            const now = new Date().toISOString();
            const insertStmt = this.db.prepare(`
                INSERT INTO runtime_calibration_weight_history (event_type, computed_at, weight, confidence_score, mode)
                VALUES (?, ?, ?, ?, ?)
            `);

            // Overfit Protection: Laplace smoothing if diversity is low and we have incidents
            const useLaplace = totalIncidents > 0 && normalizedEntropy < 0.5;
            const alpha = 1.0; // Laplace pseudocount

            for (const et of eventTypes) {
                const countRow = empiricalCounts.find(e => e.event_type === et);
                const count = countRow ? countRow.incident_count : 0;

                let empiricalP = 0;
                if (totalIncidents > 0) {
                    if (useLaplace) {
                        empiricalP = (count + alpha) / (totalIncidents + alpha * eventTypes.size);
                    } else {
                        empiricalP = count / totalIncidents;
                    }
                }

                const prior = defaultPriors[et] || defaultPriors['DEFAULT'];

                let finalWeight = prior;
                if (mode === 'WARM') {
                    const blendAlpha = (totalIncidents - 9) / 20.0;
                    finalWeight = (prior * (1 - blendAlpha)) + (empiricalP * blendAlpha);
                } else if (mode === 'CALIBRATED') {
                    finalWeight = empiricalP;
                }

                insertStmt.run(et, now, finalWeight, confidenceScore, mode);
            }
        });
        fn();
    }
}
