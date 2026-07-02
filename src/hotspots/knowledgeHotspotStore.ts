import { DatabaseSync } from 'node:sqlite';

export class KnowledgeHotspotStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS knowledge_hotspots (
                id TEXT PRIMARY KEY,
                entity_type TEXT,
                entity_id TEXT,
                hotspot_score REAL,
                severity TEXT,
                bus_factor INTEGER,
                expert_count INTEGER,
                knowledge_concentration_score REAL,
                health_score REAL,
                blast_radius_score REAL,
                coupling_score REAL
            );

            CREATE TABLE IF NOT EXISTS hotspot_evidence (
                hotspot_id TEXT,
                evidence_type TEXT,
                evidence_id TEXT,
                evidence_text TEXT
            );

            CREATE TABLE IF NOT EXISTS hotspot_history (
                hotspot_id TEXT,
                snapshot_date TEXT,
                severity TEXT,
                hotspot_score REAL,
                bus_factor INTEGER,
                expert_count INTEGER,
                health_score REAL,
                blast_radius_score REAL,
                coupling_score REAL
            );

            CREATE INDEX IF NOT EXISTS idx_hotspot_score ON knowledge_hotspots(hotspot_score DESC);
            CREATE INDEX IF NOT EXISTS idx_hotspot_entity ON knowledge_hotspots(entity_type, entity_id);
            CREATE INDEX IF NOT EXISTS idx_hotspot_evidence_id ON hotspot_evidence(hotspot_id);
            CREATE INDEX IF NOT EXISTS idx_hotspot_history_id ON hotspot_history(hotspot_id);
        `);
    }

    public getDatabase(): DatabaseSync {
        return this.db;
    }
}
