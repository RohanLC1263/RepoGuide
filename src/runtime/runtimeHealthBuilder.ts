import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';

export class RuntimeHealthBuilder {
    constructor(private db: DatabaseSync) {}

    public build(): void {
        this.computeHealth();
    }

    private computeHealth(): void {
        const fn = executeTransaction(this.db, () => {
            const now = new Date().toISOString();

            const components = this.db.prepare(`SELECT DISTINCT component_id FROM runtime_events`).all() as { component_id: string }[];

            const eventQuery = this.db.prepare(`
                SELECT event_type, COUNT(*) as count 
                FROM runtime_events 
                WHERE component_id = ? AND timestamp >= datetime('now', '-1 day')
                GROUP BY event_type
            `);

            const calibQuery = this.db.prepare(`
                SELECT weight 
                FROM runtime_calibration_weight_history 
                WHERE event_type = ? 
                ORDER BY computed_at DESC LIMIT 1
            `);

            const baselineQuery = this.db.prepare(`
                SELECT mean_frequency, variance 
                FROM runtime_baselines 
                WHERE component_id = ? AND event_type = ? 
                ORDER BY computed_at DESC LIMIT 1
            `);

            const insertStmt = this.db.prepare(`
                INSERT INTO runtime_health_history (component_id, computed_at, health_score, status, primary_driver)
                VALUES (?, ?, ?, ?, ?)
            `);

            for (const { component_id } of components) {
                const recentEvents = eventQuery.all(component_id) as { event_type: string, count: number }[];

                if (recentEvents.length === 0) {
                    insertStmt.run(component_id, now, 100, 'HEALTHY', 'NONE');
                    continue;
                }

                let totalPenalty = 0;
                let primaryDriver = 'NONE';
                let maxPenalty = 0;

                for (const ev of recentEvents) {
                    const calib = calibQuery.get(ev.event_type) as { weight: number } | undefined;
                    const weight = calib ? calib.weight : 0.5;

                    const baseline = baselineQuery.get(component_id, ev.event_type) as { mean_frequency: number, variance: number } | undefined;
                    
                    let excess = ev.count;
                    if (baseline) {
                        const stddev = Math.sqrt(baseline.variance);
                        const expectedMax = Math.ceil(baseline.mean_frequency + stddev);
                        excess = Math.max(0, ev.count - expectedMax);
                    }

                    // Calculate penalty
                    let penalty = ev.count * weight * 1.5; 
                    if (excess > 0) {
                        penalty += excess * weight * 4.0;
                    }

                    totalPenalty += penalty;

                    if (penalty > maxPenalty) {
                        maxPenalty = penalty;
                        primaryDriver = ev.event_type;
                    }
                }

                let healthScore = Math.max(0, Math.round(100 - totalPenalty));
                
                let status = 'HEALTHY';
                if (healthScore < 50) status = 'CRITICAL';
                else if (healthScore < 90) status = 'DEGRADED';

                insertStmt.run(component_id, now, healthScore, status, primaryDriver);
            }
        });
        fn();
    }
}
