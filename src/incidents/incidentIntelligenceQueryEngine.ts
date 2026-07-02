import { DatabaseSync } from 'node:sqlite';

export class IncidentIntelligenceQueryEngine {
    constructor(private db: DatabaseSync) {}

    public getIncident(id: string): any {
        return this.db.prepare(`SELECT * FROM incident_events WHERE id = ?`).get(id);
    }

    public getIncidents(limit: number = 10): any[] {
        return this.db.prepare(`
            SELECT * FROM incident_events 
            ORDER BY created_at DESC 
            LIMIT ?
        `).all(limit) as any[];
    }

    public getTopPatterns(limit: number = 10): any[] {
        return this.db.prepare(`
            SELECT * FROM incident_patterns
            ORDER BY confidence DESC, frequency DESC
            LIMIT ?
        `).all(limit) as any[];
    }

    public getHighRiskAreas(limit: number = 10): any[] {
        return this.db.prepare(`
            SELECT * FROM incident_predictions
            ORDER BY risk_score DESC
            LIMIT ?
        `).all(limit) as any[];
    }

    public getPredictions(limit: number = 10): any[] {
        return this.getHighRiskAreas(limit);
    }

    public getCoverageDrivenIncidents(limit: number = 10): any[] {
        return this.db.prepare(`
            SELECT e.* 
            FROM incident_events e
            JOIN incident_factors f ON f.incident_id = e.id
            WHERE f.factor_type = 'COVERAGE_DEGRADATION'
            ORDER BY e.created_at DESC
            LIMIT ?
        `).all(limit) as any[];
    }

    public getHotspotDrivenIncidents(limit: number = 10): any[] {
        return this.db.prepare(`
            SELECT e.* 
            FROM incident_events e
            JOIN incident_factors f ON f.incident_id = e.id
            WHERE f.factor_type = 'BUS_FACTOR_RISK'
            ORDER BY e.created_at DESC
            LIMIT ?
        `).all(limit) as any[];
    }
}
