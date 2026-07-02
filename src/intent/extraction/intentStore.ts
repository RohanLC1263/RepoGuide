import { DatabaseSync } from 'node:sqlite';
import { openDatabase, executeTransaction } from '../../store/sqliteLoader';
import { IntentEntity, IntentEvidence, IntentType } from './intentTypes';

export class IntentStore {
    private db: DatabaseSync;

    constructor(dbPathOrDb: string | DatabaseSync = ':memory:') {
        if (typeof dbPathOrDb === 'string') {
            this.db = openDatabase(dbPathOrDb);
        } else {
            this.db = dbPathOrDb;
        }
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS intents (
                id TEXT PRIMARY KEY,
                type TEXT,
                canonical_topic TEXT,
                confidence REAL,
                evidence_count INTEGER,
                adr_count INTEGER DEFAULT 0,
                pr_count INTEGER DEFAULT 0,
                commit_count INTEGER DEFAULT 0,
                first_seen_at TEXT,
                last_seen_at TEXT
            );

            CREATE TABLE IF NOT EXISTS intent_evidence (
                intent_id TEXT,
                source_type TEXT,
                source_id TEXT,
                snippet TEXT,
                created_at TEXT,
                FOREIGN KEY(intent_id) REFERENCES intents(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_intents_type ON intents(type);
            CREATE INDEX IF NOT EXISTS idx_intent_evidence_intent_id ON intent_evidence(intent_id);
            CREATE INDEX IF NOT EXISTS idx_intent_evidence_source ON intent_evidence(source_type, source_id);

            CREATE TABLE IF NOT EXISTS intent_sync_state (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);
    }

    public async saveBatch(intents: Map<string, IntentEntity>, evidence: IntentEvidence[]): Promise<void> {
        const tx = executeTransaction(this.db, () => {
            const stmtIntent = this.db.prepare(`
                INSERT INTO intents (
                    id, type, canonical_topic, confidence, evidence_count, 
                    adr_count, pr_count, commit_count, first_seen_at, last_seen_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    confidence = MAX(confidence, excluded.confidence),
                    evidence_count = evidence_count + excluded.evidence_count,
                    adr_count = adr_count + excluded.adr_count,
                    pr_count = pr_count + excluded.pr_count,
                    commit_count = commit_count + excluded.commit_count,
                    first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
                    last_seen_at = MAX(last_seen_at, excluded.last_seen_at)
            `);

            for (const intent of intents.values()) {
                stmtIntent.run(
                    intent.id,
                    intent.type,
                    intent.canonicalTopic,
                    intent.confidence,
                    intent.evidenceCount,
                    intent.adrCount,
                    intent.prCount,
                    intent.commitCount,
                    intent.firstSeenAt.toISOString(),
                    intent.lastSeenAt.toISOString()
                );
            }

            const stmtEvidence = this.db.prepare(`
                INSERT INTO intent_evidence (intent_id, source_type, source_id, snippet, created_at)
                VALUES (?, ?, ?, ?, ?)
            `);

            // SQLite doesn't natively support INSERT IGNORE or ON CONFLICT DO NOTHING without UNIQUE constraint.
            // Since we might re-process some overlapping events, we can manually check if it exists or use a unique index.
            // Let's create a unique index if it doesn't exist, to make inserts idempotent.
            this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_uniq_intent_evidence ON intent_evidence(intent_id, source_type, source_id)`);

            const stmtEvidenceIdempotent = this.db.prepare(`
                INSERT INTO intent_evidence (intent_id, source_type, source_id, snippet, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(intent_id, source_type, source_id) DO NOTHING
            `);

            for (const ev of evidence) {
                const info = stmtEvidenceIdempotent.run(
                    ev.intentId,
                    ev.sourceType,
                    ev.sourceId,
                    ev.snippet,
                    ev.createdAt.toISOString()
                );
                
                // If it was ignored (already exists), we shouldn't have incremented the intent counts.
                // But the intent update already ran. In a pure system we should check evidence existence before bumping counts.
                // For V1, the orchestration layer (IntentExtractionEngine) guarantees it only passes NEW evidence.
            }
        });

        tx();
    }

    private mapIntentRow(row: any): IntentEntity {
        return {
            id: row.id,
            type: row.type as IntentType,
            canonicalTopic: row.canonical_topic,
            confidence: row.confidence,
            evidenceCount: row.evidence_count,
            adrCount: row.adr_count,
            prCount: row.pr_count,
            commitCount: row.commit_count,
            firstSeenAt: new Date(row.first_seen_at),
            lastSeenAt: new Date(row.last_seen_at)
        };
    }

    public getIntent(id: string): IntentEntity | null {
        const row = this.db.prepare(`SELECT * FROM intents WHERE id = ?`).get(id) as any;
        return row ? this.mapIntentRow(row) : null;
    }

    public listIntents(): IntentEntity[] {
        const rows = this.db.prepare(`SELECT * FROM intents`).all() as any[];
        return rows.map(r => this.mapIntentRow(r));
    }

    public getIntentsByEvidenceSource(sourceId: string, sourceType: string): IntentEntity[] {
        const rows = this.db.prepare(`
            SELECT i.* FROM intents i
            JOIN intent_evidence e ON i.id = e.intent_id
            WHERE e.source_id = ? AND e.source_type = ?
        `).all(sourceId, sourceType) as any[];
        // Needs deduplication as multiple evidences might point to same intent
        const unique = new Map<string, any>();
        for (const row of rows) unique.set(row.id, row);
        return Array.from(unique.values()).map(r => this.mapIntentRow(r));
    }
    
    public getEvidenceForIntent(intentId: string): IntentEvidence[] {
        const rows = this.db.prepare(`SELECT * FROM intent_evidence WHERE intent_id = ? ORDER BY created_at DESC`).all(intentId) as any[];
        return rows.map(r => ({
            intentId: r.intent_id,
            sourceType: r.source_type as any,
            sourceId: r.source_id,
            snippet: r.snippet,
            createdAt: new Date(r.created_at)
        }));
    }

    public getSyncState(key: string): string | null {
        const row = this.db.prepare(`SELECT value FROM intent_sync_state WHERE key = ?`).get(key) as any;
        return row ? row.value : null;
    }

    public setSyncState(key: string, value: string): void {
        this.db.prepare(`
            INSERT INTO intent_sync_state (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
        `).run(key, value);
    }

    public getDatabase(): DatabaseSync {
        return this.db;
    }

    public close() {
        this.db.close();
    }
}
