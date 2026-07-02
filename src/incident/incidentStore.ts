import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';

export class IncidentStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS incident_events (
                id TEXT PRIMARY KEY,
                entity_type TEXT,
                entity_id TEXT,
                incident_type TEXT,
                source_type TEXT,
                severity TEXT,
                timestamp TEXT,
                resolved_at TEXT,
                root_cause_desc TEXT
            );

            CREATE TABLE IF NOT EXISTS incident_evidence (
                event_id TEXT,
                evidence_type TEXT,
                evidence_id TEXT,
                evidence_text TEXT,
                FOREIGN KEY(event_id) REFERENCES incident_events(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS incident_history (
                entity_id TEXT,
                snapshot_date TEXT,
                incident_count INTEGER,
                critical_incident_count INTEGER,
                PRIMARY KEY (entity_id, snapshot_date)
            );

            CREATE INDEX IF NOT EXISTS idx_incident_entity ON incident_events(entity_id);
            CREATE INDEX IF NOT EXISTS idx_incident_source ON incident_events(source_type);
        `);
    }

    public clearAll(): void {
        const tx = executeTransaction(this.db, () => {
            this.db.exec(`
                DELETE FROM incident_evidence;
                DELETE FROM incident_history;
                DELETE FROM incident_events;
            `);
        });
        tx();
    }
}
