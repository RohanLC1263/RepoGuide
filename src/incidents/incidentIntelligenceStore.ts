import { DatabaseSync } from 'node:sqlite';

export class IncidentIntelligenceStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS incident_factors (
                factor_id TEXT PRIMARY KEY,
                incident_id TEXT NOT NULL,
                factor_type TEXT NOT NULL,
                contribution_score INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS incident_patterns (
                pattern_id TEXT PRIMARY KEY,
                incident_type TEXT NOT NULL,
                factor_pattern TEXT NOT NULL,
                frequency INTEGER NOT NULL,
                confidence INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS incident_predictions (
                entity_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                risk_score REAL NOT NULL,
                severity TEXT NOT NULL,
                confidence INTEGER NOT NULL,
                primary_risk_driver TEXT NOT NULL,
                PRIMARY KEY (entity_id, entity_type)
            );
            
            CREATE INDEX IF NOT EXISTS idx_incident_predictions_risk ON incident_predictions(risk_score DESC);
            CREATE INDEX IF NOT EXISTS idx_incident_patterns_conf ON incident_patterns(confidence DESC);
        `);
    }

    public clear() {
        this.db.exec(`
            DELETE FROM incident_factors;
            DELETE FROM incident_patterns;
            DELETE FROM incident_predictions;
        `);
    }
}
