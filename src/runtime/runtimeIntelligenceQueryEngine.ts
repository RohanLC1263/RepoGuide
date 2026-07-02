import { DatabaseSync } from 'node:sqlite';

export class RuntimeIntelligenceQueryEngine {
    constructor(private db: DatabaseSync) {}

    public isAvailable(): boolean {
        const stmt = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_health_history'");
        const row = stmt.get();
        return !!row;
    }

    public getUnhealthyComponents() {
        if (!this.isAvailable()) return [];
        return this.db.prepare(`
            SELECT component_id, health_score, status, primary_driver
            FROM runtime_health_history
            WHERE status IN ('DEGRADED', 'CRITICAL')
            ORDER BY health_score ASC
        `).all();
    }

    public getRecentPatternIncreases() {
        if (!this.isAvailable()) return [];
        return this.db.prepare(`
            SELECT component_id, pattern_type, frequency, status
            FROM runtime_patterns
            WHERE status = 'ACTIVE'
            ORDER BY frequency DESC
        `).all();
    }

    public getFilesForDegradedComponents() {
        if (!this.isAvailable()) return [];
        return this.db.prepare(`
            SELECT r.component_id, m.entity_id, h.status
            FROM runtime_repository_mappings m
            JOIN runtime_health_history h ON m.component_id = h.component_id
            JOIN runtime_patterns r ON m.component_id = r.component_id
            WHERE h.status IN ('DEGRADED', 'CRITICAL')
            GROUP BY r.component_id, m.entity_id, h.status
        `).all();
    }

    public getRuntimeRisks() {
        if (!this.isAvailable()) return [];
        return this.db.prepare(`
            SELECT factor_type, contribution_score
            FROM incident_factors
            WHERE factor_type LIKE 'RUNTIME_%' OR factor_type = 'RECURRING_RUNTIME_PATTERN'
        `).all();
    }
}
