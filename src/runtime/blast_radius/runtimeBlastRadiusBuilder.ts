import { DatabaseSync } from 'node:sqlite';
import { RuntimeBlastRadiusCalculator, FailingSource } from './runtimeBlastRadiusCalculator';
import { RuntimeBlastRadiusStore } from './runtimeBlastRadiusStore';

export class RuntimeBlastRadiusBuilder {
    constructor(
        private db: DatabaseSync,
        private calculator: RuntimeBlastRadiusCalculator,
        private store: RuntimeBlastRadiusStore
    ) {}

    public async build(cycleId: string): Promise<void> {
        // Query failing sources from Component 25 (runtime_health_history)
        const events = this.db.prepare(`
            SELECT component_id, risk_score
            FROM (
                SELECT component_id, 
                       CASE WHEN status = 'CRITICAL' THEN 1.0 ELSE 0.5 END as risk_score,
                       computed_at,
                       ROW_NUMBER() OVER (PARTITION BY component_id ORDER BY computed_at DESC) as rn
                FROM runtime_health_history
                WHERE status IN ('DEGRADED', 'CRITICAL')
            )
            WHERE rn = 1
        `).all() as any[];

        const failingSources: FailingSource[] = events.map(e => ({
            component_id: e.component_id,
            riskScore: e.risk_score
        }));

        if (failingSources.length === 0) return;

        const results = this.calculator.calculate(cycleId, failingSources);
        
        if (results.length > 0) {
            this.store.saveBatch(results);
        }
    }
}
