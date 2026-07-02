import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';
import { KnowledgeValidity, ValidityEvidence, ValidityHistory } from './knowledgeValidityTypes';

export class KnowledgeValidityStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS knowledge_validity (
                id TEXT PRIMARY KEY,
                entity_type TEXT,
                entity_id TEXT,
                validity_score REAL,
                validity_tier TEXT,
                confidence_score REAL,
                trend TEXT,
                last_validated_at TEXT,
                evidence_count INTEGER
            );

            CREATE TABLE IF NOT EXISTS validity_evidence (
                validity_id TEXT,
                evidence_type TEXT,
                evidence_id TEXT,
                evidence_text TEXT,
                FOREIGN KEY(validity_id) REFERENCES knowledge_validity(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS validity_history (
                validity_id TEXT,
                snapshot_date TEXT,
                validity_score REAL,
                confidence_score REAL,
                FOREIGN KEY(validity_id) REFERENCES knowledge_validity(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_validity_score ON knowledge_validity(validity_score ASC);
            CREATE INDEX IF NOT EXISTS idx_validity_entity ON knowledge_validity(entity_type, entity_id);
            CREATE INDEX IF NOT EXISTS idx_validity_evidence_vid ON validity_evidence(validity_id);
            CREATE INDEX IF NOT EXISTS idx_validity_history_vid ON validity_history(validity_id);
        `);
    }

    public clearAll(): void {
        const tx = executeTransaction(this.db, () => {
            this.db.exec(`
                DELETE FROM validity_evidence;
                DELETE FROM validity_history;
                DELETE FROM knowledge_validity;
            `);
        });
        tx();
    }

    public saveValidity(
        validity: KnowledgeValidity,
        evidences: ValidityEvidence[],
        history: ValidityHistory
    ): void {
        const tx = executeTransaction(this.db, () => {
            const insVal = this.db.prepare(`
                INSERT INTO knowledge_validity 
                (id, entity_type, entity_id, validity_score, validity_tier, confidence_score, trend, last_validated_at, evidence_count)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    validity_score=excluded.validity_score,
                    validity_tier=excluded.validity_tier,
                    confidence_score=excluded.confidence_score,
                    trend=excluded.trend,
                    last_validated_at=excluded.last_validated_at,
                    evidence_count=excluded.evidence_count
            `);
            insVal.run(
                validity.id, validity.entityType, validity.entityId, validity.validityScore,
                validity.validityTier, validity.confidenceScore, validity.trend, 
                validity.lastValidatedAt.toISOString(), validity.evidenceCount
            );

            // Delete old evidence for this validity
            this.db.prepare(`DELETE FROM validity_evidence WHERE validity_id = ?`).run(validity.id);

            const insEv = this.db.prepare(`
                INSERT INTO validity_evidence (validity_id, evidence_type, evidence_id, evidence_text)
                VALUES (?, ?, ?, ?)
            `);
            for (const ev of evidences) {
                insEv.run(ev.validityId, ev.evidenceType, ev.evidenceId, ev.evidenceText);
            }

            const insHist = this.db.prepare(`
                INSERT INTO validity_history (validity_id, snapshot_date, validity_score, confidence_score)
                VALUES (?, ?, ?, ?)
            `);
            const dateStr = history.snapshotDate.toISOString().split('T')[0];
            insHist.run(history.validityId, dateStr, history.validityScore, history.confidenceScore);
        });
        tx();
    }

    public getPreviousHistory(validityId: string): ValidityHistory | null {
        const row = this.db.prepare(`
            SELECT * FROM validity_history 
            WHERE validity_id = ? 
            ORDER BY snapshot_date DESC LIMIT 1
        `).get(validityId) as any;
        
        if (!row) return null;
        return {
            validityId: row.validity_id,
            snapshotDate: new Date(row.snapshot_date),
            validityScore: row.validity_score,
            confidenceScore: row.confidence_score
        };
    }
}
