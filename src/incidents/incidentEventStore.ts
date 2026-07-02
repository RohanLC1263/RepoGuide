import { DatabaseSync } from 'node:sqlite';
import { IncidentEvent, IncidentStateLock, IncidentType } from './incidentEventTypes';

export class IncidentEventStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS incident_events (
                id TEXT PRIMARY KEY,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                incident_type TEXT NOT NULL,
                severity TEXT NOT NULL,
                trigger_metric TEXT NOT NULL,
                trigger_value TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS incident_state_locks (
                entity_id TEXT NOT NULL,
                incident_type TEXT NOT NULL,
                last_severity TEXT NOT NULL,
                lock_expires_at TEXT NOT NULL,
                PRIMARY KEY (entity_id, incident_type)
            );
        `);
    }

    public appendEvent(event: IncidentEvent): void {
        const stmt = this.db.prepare(`
            INSERT INTO incident_events (id, entity_type, entity_id, incident_type, severity, trigger_metric, trigger_value, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            event.id,
            event.entity_type,
            event.entity_id,
            event.incident_type,
            event.severity,
            event.trigger_metric,
            event.trigger_value,
            event.created_at.toISOString()
        );
    }

    public getLock(entityId: string, incidentType: IncidentType): IncidentStateLock | null {
        const row = this.db.prepare(`
            SELECT entity_id, incident_type, last_severity, lock_expires_at
            FROM incident_state_locks
            WHERE entity_id = ? AND incident_type = ?
        `).get(entityId, incidentType) as any;

        if (!row) return null;
        return {
            entity_id: row.entity_id,
            incident_type: row.incident_type as IncidentType,
            last_severity: row.last_severity,
            lock_expires_at: new Date(row.lock_expires_at)
        };
    }

    public updateLock(lock: IncidentStateLock): void {
        const stmt = this.db.prepare(`
            INSERT INTO incident_state_locks (entity_id, incident_type, last_severity, lock_expires_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(entity_id, incident_type) DO UPDATE SET
                last_severity=excluded.last_severity,
                lock_expires_at=excluded.lock_expires_at
        `);
        stmt.run(
            lock.entity_id,
            lock.incident_type,
            lock.last_severity,
            lock.lock_expires_at.toISOString()
        );
    }

    public clearLock(entityId: string, incidentType: IncidentType): void {
        const stmt = this.db.prepare(`
            DELETE FROM incident_state_locks
            WHERE entity_id = ? AND incident_type = ?
        `);
        stmt.run(entityId, incidentType);
    }
}
