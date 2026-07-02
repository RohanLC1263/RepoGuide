import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';
import { RuntimeEvent, RuntimeComponent, RuntimeRepositoryMapping } from './runtimeSchema';

export class RuntimeStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS runtime_components (
                component_id TEXT PRIMARY KEY,
                description TEXT
            );

            CREATE TABLE IF NOT EXISTS runtime_events (
                event_id TEXT PRIMARY KEY,
                component_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                severity TEXT NOT NULL,
                payload TEXT,
                timestamp TEXT NOT NULL,
                repository_commit_hash TEXT NOT NULL,
                FOREIGN KEY (component_id) REFERENCES runtime_components(component_id)
            );

            CREATE INDEX IF NOT EXISTS idx_runtime_events_time ON runtime_events(component_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_runtime_events_type ON runtime_events(component_id, event_type);

            CREATE TABLE IF NOT EXISTS runtime_repository_mappings (
                mapping_id TEXT NOT NULL,
                component_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                snapshot_date TEXT NOT NULL,
                PRIMARY KEY (mapping_id, snapshot_date),
                FOREIGN KEY (component_id) REFERENCES runtime_components(component_id)
            );

            CREATE INDEX IF NOT EXISTS idx_runtime_mappings ON runtime_repository_mappings(component_id, entity_id);

            CREATE TABLE IF NOT EXISTS runtime_health_history (
                component_id TEXT NOT NULL,
                computed_at TEXT NOT NULL,
                health_score INTEGER NOT NULL,
                status TEXT NOT NULL,
                primary_driver TEXT NOT NULL,
                PRIMARY KEY (component_id, computed_at),
                FOREIGN KEY (component_id) REFERENCES runtime_components(component_id)
            );

            CREATE TABLE IF NOT EXISTS runtime_patterns (
                pattern_id TEXT PRIMARY KEY,
                component_id TEXT NOT NULL,
                pattern_type TEXT NOT NULL,
                frequency INTEGER NOT NULL,
                confidence INTEGER NOT NULL,
                discovered_at TEXT NOT NULL,
                status TEXT NOT NULL,
                FOREIGN KEY (component_id) REFERENCES runtime_components(component_id)
            );

            CREATE TABLE IF NOT EXISTS runtime_calibration_weight_history (
                event_type TEXT NOT NULL,
                computed_at TEXT NOT NULL,
                weight REAL NOT NULL,
                confidence_score REAL NOT NULL,
                mode TEXT NOT NULL,
                PRIMARY KEY (event_type, computed_at)
            );

            CREATE TABLE IF NOT EXISTS runtime_baselines (
                component_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                computed_at TEXT NOT NULL,
                mean_frequency REAL NOT NULL,
                variance REAL NOT NULL,
                PRIMARY KEY (component_id, event_type, computed_at),
                FOREIGN KEY (component_id) REFERENCES runtime_components(component_id)
            );
        `);

        // Retention sweeps
        this.applyRetention();
    }

    private applyRetention() {
        this.db.exec(`DELETE FROM runtime_events WHERE timestamp < datetime('now', '-30 days')`);
        this.db.exec(`DELETE FROM runtime_health_history WHERE computed_at < datetime('now', '-365 days')`);
        this.db.exec(`DELETE FROM runtime_patterns WHERE discovered_at < datetime('now', '-365 days')`);
        this.db.exec(`DELETE FROM runtime_baselines WHERE computed_at < datetime('now', '-365 days')`);
    }

    public appendEvents(events: RuntimeEvent[]): void {
        const fn = executeTransaction(this.db, (events: RuntimeEvent[]) => {
            const stmt = this.db.prepare(`
                INSERT OR IGNORE INTO runtime_events (event_id, component_id, event_type, severity, payload, timestamp, repository_commit_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            for (const e of events) {
                stmt.run(e.event_id, e.component_id, e.event_type, e.severity, e.payload, e.timestamp.toISOString(), e.repository_commit_hash);
            }
        });
        fn(events);
    }

    public upsertComponent(component: RuntimeComponent) {
        const stmt = this.db.prepare(`
            INSERT INTO runtime_components (component_id, description)
            VALUES (?, ?)
            ON CONFLICT(component_id) DO UPDATE SET
                description = excluded.description
        `);
        stmt.run(component.component_id, component.description || null);
    }

    public upsertMapping(mapping: RuntimeRepositoryMapping) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO runtime_repository_mappings (mapping_id, component_id, entity_type, entity_id, snapshot_date)
            VALUES (?, ?, ?, ?, ?)
        `);
        stmt.run(mapping.mapping_id, mapping.component_id, mapping.entity_type, mapping.entity_id, mapping.snapshot_date.toISOString());
    }

    // Additional query methods will be added as required by other builders.
}
