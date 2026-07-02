import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';

export class RuntimePatternBuilder {
    constructor(private db: DatabaseSync) {}

    public build(): void {
        this.computePatterns();
    }

    private computePatterns(): void {
        const fn = executeTransaction(this.db, () => {
            const now = new Date().toISOString();

            const activePatterns = this.db.prepare(`
                SELECT pattern_id, component_id, pattern_type, discovered_at 
                FROM runtime_patterns 
                WHERE status = 'ACTIVE'
            `).all() as any[];

            const countQuery = this.db.prepare(`
                SELECT COUNT(*) as count 
                FROM runtime_events 
                WHERE component_id = ? AND event_type = ? AND timestamp >= datetime('now', '-1 day')
            `);

            const baselineQuery = this.db.prepare(`
                SELECT mean_frequency, variance 
                FROM runtime_baselines 
                WHERE component_id = ? AND event_type = ? 
                ORDER BY computed_at DESC LIMIT 1
            `);

            const updateStatus = this.db.prepare(`
                UPDATE runtime_patterns SET status = ? WHERE pattern_id = ?
            `);

            for (const pattern of activePatterns) {
                const discovered = new Date(pattern.discovered_at).getTime();
                const ageDays = (new Date().getTime() - discovered) / (1000 * 60 * 60 * 24);
                
                if (ageDays > 30) {
                    updateStatus.run('EXPIRED', pattern.pattern_id);
                    continue;
                }

                const countRes = countQuery.get(pattern.component_id, pattern.pattern_type) as { count: number };
                const baseline = baselineQuery.get(pattern.component_id, pattern.pattern_type) as { mean_frequency: number, variance: number } | undefined;

                if (baseline) {
                    const threshold = baseline.mean_frequency + 3 * Math.sqrt(baseline.variance);
                    if (countRes.count <= Math.max(5, threshold)) {
                        updateStatus.run('RESOLVED', pattern.pattern_id);
                    }
                } else if (countRes.count < 5) {
                    updateStatus.run('RESOLVED', pattern.pattern_id);
                }
            }

            const newEvents = this.db.prepare(`
                SELECT component_id, event_type, COUNT(*) as count 
                FROM runtime_events 
                WHERE timestamp >= datetime('now', '-1 day')
                GROUP BY component_id, event_type
            `).all() as { component_id: string, event_type: string, count: number }[];

            const insertPattern = this.db.prepare(`
                INSERT INTO runtime_patterns (pattern_id, component_id, pattern_type, frequency, confidence, discovered_at, status)
                VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')
            `);

            const checkActive = this.db.prepare(`
                SELECT COUNT(*) as active_count FROM runtime_patterns 
                WHERE component_id = ? AND pattern_type = ? AND status = 'ACTIVE'
            `);

            for (const ev of newEvents) {
                const activeRes = checkActive.get(ev.component_id, ev.event_type) as { active_count: number };
                if (activeRes.active_count > 0) continue; 

                const baseline = baselineQuery.get(ev.component_id, ev.event_type) as { mean_frequency: number, variance: number } | undefined;
                
                let threshold = 5; 
                if (baseline) {
                    threshold = Math.max(5, baseline.mean_frequency + 3 * Math.sqrt(baseline.variance));
                }

                if (ev.count > threshold) {
                    const pattern_id = `pat_${ev.component_id}_${ev.event_type}_${Math.random().toString(36).substring(7)}`;
                    const confidence = baseline ? 90 : 50; 
                    insertPattern.run(pattern_id, ev.component_id, ev.event_type, ev.count, confidence, now);
                }
            }
        });
        fn();
    }
}
