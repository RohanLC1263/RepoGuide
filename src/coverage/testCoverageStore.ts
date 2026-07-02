import { DatabaseSync } from 'node:sqlite';
import { CoverageEntity, CoverageEvidence, CoverageSnapshot, CoverageRisk } from './testCoverageTypes';

export class TestCoverageStore {
    constructor(private db: DatabaseSync) {
        this.initializeSchemas();
    }

    private initializeSchemas() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS coverage_entities (
                entity_type TEXT,
                entity_id TEXT,
                coverage_percent REAL,
                covered_lines INTEGER,
                total_lines INTEGER,
                coverage_status TEXT,
                calculated_at TEXT,
                PRIMARY KEY(entity_type, entity_id)
            );

            CREATE TABLE IF NOT EXISTS coverage_history (
                entity_type TEXT,
                entity_id TEXT,
                snapshot_date TEXT,
                coverage_percent REAL,
                PRIMARY KEY(entity_type, entity_id, snapshot_date)
            );

            CREATE TABLE IF NOT EXISTS coverage_evidence (
                coverage_id TEXT,
                source_type TEXT,
                source_id TEXT,
                evidence_text TEXT
            );

            CREATE TABLE IF NOT EXISTS coverage_risk (
                entity_type TEXT,
                entity_id TEXT,
                risk_score REAL,
                risk_level TEXT,
                PRIMARY KEY(entity_type, entity_id)
            );
        `);
    }

    public clearAll() {
        this.db.exec(`
            DELETE FROM coverage_entities;
            DELETE FROM coverage_history;
            DELETE FROM coverage_evidence;
            DELETE FROM coverage_risk;
        `);
    }

    public insertEntity(entity: CoverageEntity) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO coverage_entities 
            (entity_type, entity_id, coverage_percent, covered_lines, total_lines, coverage_status, calculated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            entity.entityType, entity.entityId, entity.coveragePercent, 
            entity.coveredLines, entity.totalLines, entity.coverageStatus, entity.calculatedAt
        );
    }

    public insertEvidence(evidence: CoverageEvidence) {
        const stmt = this.db.prepare(`
            INSERT INTO coverage_evidence (coverage_id, source_type, source_id, evidence_text)
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(evidence.coverageId, evidence.sourceType, evidence.sourceId, evidence.evidenceText);
    }

    public insertSnapshot(snapshot: CoverageSnapshot) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO coverage_history (entity_type, entity_id, snapshot_date, coverage_percent)
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(snapshot.entityType, snapshot.entityId, snapshot.snapshotDate, snapshot.coveragePercent);
    }

    public insertRisk(risk: CoverageRisk) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO coverage_risk (entity_type, entity_id, risk_score, risk_level)
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(risk.entityType, risk.entityId, risk.riskScore, risk.riskLevel);
    }

    public getDb(): DatabaseSync {
        return this.db;
    }
}
