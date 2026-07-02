import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';

export class RuntimeBaselineBuilder {
    constructor(private db: DatabaseSync) {}

    public build(): void {
        this.computeBaselines();
    }

    private computeBaselines(): void {
        const fn = executeTransaction(this.db, () => {
            const query = `
                SELECT 
                    component_id, 
                    event_type, 
                    date(timestamp) as day, 
                    COUNT(*) as daily_count
                FROM runtime_events
                WHERE timestamp >= datetime('now', '-30 days')
                GROUP BY component_id, event_type, date(timestamp)
            `;
            const dailyCounts = this.db.prepare(query).all() as { component_id: string, event_type: string, day: string, daily_count: number }[];

            const grouped = new Map<string, number[]>();
            for (const row of dailyCounts) {
                const key = `${row.component_id}::${row.event_type}`;
                if (!grouped.has(key)) grouped.set(key, []);
                grouped.get(key)!.push(row.daily_count);
            }

            const now = new Date().toISOString();
            const insertStmt = this.db.prepare(`
                INSERT INTO runtime_baselines (component_id, event_type, computed_at, mean_frequency, variance)
                VALUES (?, ?, ?, ?, ?)
            `);

            for (const [key, counts] of grouped.entries()) {
                const paddedCounts = [...counts];
                while (paddedCounts.length < 30) {
                    paddedCounts.push(0);
                }

                const n = paddedCounts.length;
                const mean = paddedCounts.reduce((a, b) => a + b, 0) / n;
                const variance = paddedCounts.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;

                const [component_id, event_type] = key.split('::');
                insertStmt.run(component_id, event_type, now, mean, variance);
            }
        });
        fn();
    }
}
