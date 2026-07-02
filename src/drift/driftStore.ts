import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';

export class DriftStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS drift_entities (
                id TEXT PRIMARY KEY,
                entity_type TEXT,
                drift_score REAL,
                first_detected_at TEXT,
                last_detected_at TEXT,
                health_score REAL,
                drift_trend TEXT,
                resolution_state TEXT,
                suppressed INTEGER,
                owner_email TEXT
            );

            CREATE TABLE IF NOT EXISTS drift_findings (
                id TEXT PRIMARY KEY,
                entity_id TEXT,
                drift_type TEXT,
                severity TEXT,
                adr_id TEXT,
                intent_id TEXT,
                node_id TEXT,
                confidence REAL,
                evidence_count INTEGER,
                first_detected_at TEXT,
                last_detected_at TEXT,
                resolved_at TEXT,
                lifetime_days REAL,
                resolution_state TEXT,
                suppressed INTEGER,
                owner_email TEXT
            );

            CREATE TABLE IF NOT EXISTS drift_evidence (
                finding_id TEXT,
                evidence_type TEXT,
                evidence_id TEXT,
                evidence_text TEXT
            );

            CREATE TABLE IF NOT EXISTS drift_history (
                finding_id TEXT,
                snapshot_date TEXT,
                severity TEXT
            );

            CREATE TABLE IF NOT EXISTS architectural_health_history (
                entity_type TEXT,
                entity_id TEXT,
                snapshot_date TEXT,
                health_score REAL,
                active_findings INTEGER,
                critical_findings INTEGER,
                PRIMARY KEY (entity_type, entity_id, snapshot_date)
            );

            CREATE TABLE IF NOT EXISTS architectural_health (
                entity_id TEXT PRIMARY KEY,
                entity_type TEXT,
                health_score REAL,
                active_findings INTEGER,
                critical_findings INTEGER,
                trend TEXT,
                calculated_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_drift_findings_entity ON drift_findings(entity_id);
            CREATE INDEX IF NOT EXISTS idx_drift_findings_state ON drift_findings(resolution_state);
            CREATE INDEX IF NOT EXISTS idx_drift_findings_type ON drift_findings(drift_type);
            CREATE INDEX IF NOT EXISTS idx_drift_evidence_finding ON drift_evidence(finding_id);
            CREATE INDEX IF NOT EXISTS idx_drift_history_finding ON drift_history(finding_id);
            CREATE INDEX IF NOT EXISTS idx_arch_health_history_entity ON architectural_health_history(entity_id);
        `);
    }

    public getDatabase(): DatabaseSync {
        return this.db;
    }
}
