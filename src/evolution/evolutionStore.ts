import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';
import { EvolutionEntity, EvolutionEvent, EvolutionEvidence, EvolutionSnapshot } from './evolutionTypes';

export class EvolutionStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS evolution_entities (
                id TEXT PRIMARY KEY,
                entity_type TEXT,
                entity_id TEXT,
                first_seen_at TEXT,
                last_seen_at TEXT,
                current_state TEXT,
                evolution_velocity REAL,
                change_count INTEGER,
                status TEXT
            );

            CREATE TABLE IF NOT EXISTS evolution_events (
                id TEXT PRIMARY KEY,
                entity_id TEXT,
                timestamp TEXT,
                event_type TEXT,
                old_value TEXT,
                new_value TEXT,
                importance_score INTEGER
            );

            CREATE TABLE IF NOT EXISTS evolution_evidence (
                event_id TEXT,
                evidence_type TEXT,
                evidence_id TEXT,
                evidence_text TEXT,
                FOREIGN KEY(event_id) REFERENCES evolution_events(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS evolution_snapshots (
                entity_id TEXT,
                snapshot_date TEXT,
                health_score REAL,
                validity_score REAL,
                hotspot_score REAL,
                bus_factor INTEGER,
                node_count INTEGER,
                PRIMARY KEY (entity_id, snapshot_date)
            );

            CREATE INDEX IF NOT EXISTS idx_evolution_entities_entity ON evolution_entities(entity_type, entity_id);
            CREATE INDEX IF NOT EXISTS idx_evolution_events_entity ON evolution_events(entity_id);
            CREATE INDEX IF NOT EXISTS idx_evolution_snapshots_entity ON evolution_snapshots(entity_id);
            CREATE INDEX IF NOT EXISTS idx_evolution_events_importance ON evolution_events(importance_score DESC);
        `);
    }

    public clearAll(): void {
        const tx = executeTransaction(this.db, () => {
            this.db.exec(`
                DELETE FROM evolution_evidence;
                DELETE FROM evolution_events;
                DELETE FROM evolution_snapshots;
                DELETE FROM evolution_entities;
            `);
        });
        tx();
    }

    public getLatestSnapshot(entityId: string): EvolutionSnapshot | null {
        const row = this.db.prepare(`
            SELECT * FROM evolution_snapshots 
            WHERE entity_id = ? 
            ORDER BY snapshot_date DESC LIMIT 1
        `).get(entityId) as any;
        if (!row) return null;
        return {
            entityId: row.entity_id,
            snapshotDate: new Date(row.snapshot_date),
            healthScore: row.health_score,
            validityScore: row.validity_score,
            hotspotScore: row.hotspot_score,
            busFactor: row.bus_factor,
            nodeCount: row.node_count
        };
    }

    public getEntity(entityId: string): EvolutionEntity | null {
        const row = this.db.prepare(`SELECT * FROM evolution_entities WHERE entity_id = ?`).get(entityId) as any;
        if (!row) return null;
        return {
            id: row.id,
            entityType: row.entity_type as any,
            entityId: row.entity_id,
            firstSeenAt: new Date(row.first_seen_at),
            lastSeenAt: new Date(row.last_seen_at),
            currentState: row.current_state,
            evolutionVelocity: row.evolution_velocity,
            changeCount: row.change_count,
            status: row.status as any
        };
    }

    public saveEntity(entity: EvolutionEntity): void {
        const stmt = this.db.prepare(`
            INSERT INTO evolution_entities (id, entity_type, entity_id, first_seen_at, last_seen_at, current_state, evolution_velocity, change_count, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                first_seen_at=excluded.first_seen_at,
                last_seen_at=excluded.last_seen_at,
                current_state=excluded.current_state,
                evolution_velocity=excluded.evolution_velocity,
                change_count=excluded.change_count,
                status=excluded.status
        `);
        stmt.run(
            entity.id, entity.entityType, entity.entityId, entity.firstSeenAt.toISOString(), 
            entity.lastSeenAt.toISOString(), entity.currentState, entity.evolutionVelocity, 
            entity.changeCount, entity.status
        );
    }

    public saveSnapshot(snapshot: EvolutionSnapshot): void {
        // Force daily resolution by taking YYYY-MM-DD
        const dateStr = snapshot.snapshotDate.toISOString().split('T')[0];
        
        const stmt = this.db.prepare(`
            INSERT INTO evolution_snapshots (entity_id, snapshot_date, health_score, validity_score, hotspot_score, bus_factor, node_count)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(entity_id, snapshot_date) DO UPDATE SET
                health_score=excluded.health_score,
                validity_score=excluded.validity_score,
                hotspot_score=excluded.hotspot_score,
                bus_factor=excluded.bus_factor,
                node_count=excluded.node_count
        `);
        stmt.run(snapshot.entityId, dateStr, snapshot.healthScore, snapshot.validityScore, snapshot.hotspotScore, snapshot.busFactor, snapshot.nodeCount);
    }

    public saveEvent(event: EvolutionEvent, evidence: EvolutionEvidence[]): void {
        const tx = executeTransaction(this.db, () => {
            const insEvent = this.db.prepare(`
                INSERT OR IGNORE INTO evolution_events (id, entity_id, timestamp, event_type, old_value, new_value, importance_score)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            insEvent.run(event.id, event.entityId, event.timestamp.toISOString(), event.eventType, event.oldValue, event.newValue, event.importanceScore);

            const insEv = this.db.prepare(`
                INSERT INTO evolution_evidence (event_id, evidence_type, evidence_id, evidence_text)
                VALUES (?, ?, ?, ?)
            `);
            for (const ev of evidence) {
                insEv.run(ev.eventId, ev.evidenceType, ev.evidenceId, ev.evidenceText);
            }
        });
        tx();
    }
}
