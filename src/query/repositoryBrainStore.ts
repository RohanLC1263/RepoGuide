import { DatabaseSync } from 'node:sqlite';
import {
    RepositoryKnowledge,
    KnowledgeLifecycleState,
    RepositoryKnowledgeType
} from './repositoryKnowledgeTypes';

const SCHEMA_VERSION = '1';

export interface RepositoryKnowledgeQueryFilter {
    types?: RepositoryKnowledgeType[];
    lifecycleStates?: KnowledgeLifecycleState[];
    subjectIds?: string[];
    limit?: number;
}

/**
 * Storage layer for RepositoryBrain's unified `repository_knowledge` table.
 * Detail/evidence tables (causal_*, outcome_*, incident_*, etc.) remain owned by their own
 * per-domain stores; this table holds only the top-level RepositoryKnowledge record that
 * lifecycle/lineage tracking protects from silent overwrite.
 */
export class RepositoryBrainStore {
    constructor(private db: DatabaseSync) {
        this.init();
    }

    private init(): void {
        this.db.exec(`PRAGMA journal_mode = WAL;`);
        this.db.exec(`PRAGMA synchronous = NORMAL;`);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS schema_meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE TABLE IF NOT EXISTS repository_knowledge (
                id TEXT PRIMARY KEY,
                schema_version TEXT NOT NULL,
                type TEXT NOT NULL,
                subject_kind TEXT NOT NULL,
                subject_id TEXT NOT NULL,
                subject_file TEXT,
                subject_symbol TEXT,
                lifecycle_state TEXT NOT NULL,
                validation_state TEXT NOT NULL,
                confidence_score REAL NOT NULL,
                freshness_state TEXT NOT NULL,
                owner TEXT NOT NULL,
                created_by TEXT NOT NULL,
                last_updated_by TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                validated_at TEXT,
                promoted_at TEXT,
                stale_at TEXT,
                retired_at TEXT,
                archived_at TEXT,
                knowledge_version INTEGER NOT NULL,
                producer_version TEXT NOT NULL,
                migration_version TEXT NOT NULL,
                claim_json TEXT NOT NULL,
                confidence_json TEXT NOT NULL,
                provenance_json TEXT NOT NULL,
                freshness_json TEXT NOT NULL,
                supporting_evidence_json TEXT NOT NULL,
                contradictions_json TEXT NOT NULL,
                tags_json TEXT NOT NULL,
                diagnostics_json TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_rk_type ON repository_knowledge(type);
            CREATE INDEX IF NOT EXISTS idx_rk_subject ON repository_knowledge(subject_kind, subject_id);
            CREATE INDEX IF NOT EXISTS idx_rk_file ON repository_knowledge(subject_file);
            CREATE INDEX IF NOT EXISTS idx_rk_symbol ON repository_knowledge(subject_symbol);
            CREATE INDEX IF NOT EXISTS idx_rk_lifecycle ON repository_knowledge(lifecycle_state);
            CREATE INDEX IF NOT EXISTS idx_rk_freshness ON repository_knowledge(freshness_state);
            CREATE INDEX IF NOT EXISTS idx_rk_confidence ON repository_knowledge(confidence_score);
            CREATE INDEX IF NOT EXISTS idx_rk_updated ON repository_knowledge(updated_at);
        `);

        const existing = this.db.prepare(`SELECT value FROM schema_meta WHERE key = 'repository_knowledge_schema_version'`).get() as { value: string } | undefined;
        if (!existing) {
            this.db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('repository_knowledge_schema_version', ?)`).run(SCHEMA_VERSION);
        }
        // No migrations exist yet at schema version 1. Future schema changes bump SCHEMA_VERSION
        // and add a migration step here, keyed off the value read from schema_meta.
    }

    public insert(knowledge: RepositoryKnowledge): void {
        const row = toRow(knowledge);
        this.db.prepare(`
            INSERT INTO repository_knowledge (
                id, schema_version, type, subject_kind, subject_id, subject_file, subject_symbol,
                lifecycle_state, validation_state, confidence_score, freshness_state,
                owner, created_by, last_updated_by,
                created_at, updated_at, validated_at, promoted_at, stale_at, retired_at, archived_at,
                knowledge_version, producer_version, migration_version,
                claim_json, confidence_json, provenance_json, freshness_json,
                supporting_evidence_json, contradictions_json, tags_json, diagnostics_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(...row);
    }

    public update(knowledge: RepositoryKnowledge): void {
        const row = toRow(knowledge);
        // Reorder for UPDATE ... SET with id last for WHERE clause.
        const [id, ...rest] = row;
        this.db.prepare(`
            UPDATE repository_knowledge SET
                schema_version = ?, type = ?, subject_kind = ?, subject_id = ?, subject_file = ?, subject_symbol = ?,
                lifecycle_state = ?, validation_state = ?, confidence_score = ?, freshness_state = ?,
                owner = ?, created_by = ?, last_updated_by = ?,
                created_at = ?, updated_at = ?, validated_at = ?, promoted_at = ?, stale_at = ?, retired_at = ?, archived_at = ?,
                knowledge_version = ?, producer_version = ?, migration_version = ?,
                claim_json = ?, confidence_json = ?, provenance_json = ?, freshness_json = ?,
                supporting_evidence_json = ?, contradictions_json = ?, tags_json = ?, diagnostics_json = ?
            WHERE id = ?
        `).run(...rest, id);
    }

    public getById(id: string): RepositoryKnowledge | null {
        const row = this.db.prepare(`SELECT * FROM repository_knowledge WHERE id = ?`).get(id) as any;
        return row ? fromRow(row) : null;
    }

    /** Finds the most recently updated record matching type+subject in any of the given lifecycle states. */
    public findBySubject(type: RepositoryKnowledgeType, subjectId: string, states: KnowledgeLifecycleState[]): RepositoryKnowledge | null {
        if (states.length === 0) return null;
        const placeholders = states.map(() => '?').join(', ');
        const row = this.db.prepare(`
            SELECT * FROM repository_knowledge
            WHERE type = ? AND subject_id = ? AND lifecycle_state IN (${placeholders})
            ORDER BY updated_at DESC
            LIMIT 1
        `).get(type, subjectId, ...states) as any;
        return row ? fromRow(row) : null;
    }

    public query(filter: RepositoryKnowledgeQueryFilter): RepositoryKnowledge[] {
        const clauses: string[] = [];
        const params: any[] = [];

        if (filter.types && filter.types.length > 0) {
            clauses.push(`type IN (${filter.types.map(() => '?').join(', ')})`);
            params.push(...filter.types);
        }
        if (filter.lifecycleStates && filter.lifecycleStates.length > 0) {
            clauses.push(`lifecycle_state IN (${filter.lifecycleStates.map(() => '?').join(', ')})`);
            params.push(...filter.lifecycleStates);
        }
        if (filter.subjectIds && filter.subjectIds.length > 0) {
            const subjectClauses = filter.subjectIds.map(() => `(subject_id = ? OR subject_file = ?)`);
            clauses.push(`(${subjectClauses.join(' OR ')})`);
            for (const subjectId of filter.subjectIds) {
                params.push(subjectId, subjectId);
            }
        }

        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
        const rows = this.db.prepare(`
            SELECT * FROM repository_knowledge
            ${where}
            ORDER BY confidence_score DESC, updated_at DESC
            LIMIT ?
        `).all(...params, limit) as any[];
        return rows.map(fromRow);
    }

    public deleteById(id: string): boolean {
        const result = this.db.prepare(`DELETE FROM repository_knowledge WHERE id = ?`).run(id);
        return result.changes > 0;
    }

    public countByType(): Record<string, number> {
        const rows = this.db.prepare(`SELECT type, COUNT(*) as cnt FROM repository_knowledge GROUP BY type`).all() as any[];
        const result: Record<string, number> = {};
        for (const row of rows) {
            result[row.type] = row.cnt;
        }
        return result;
    }
}

function toRow(k: RepositoryKnowledge): any[] {
    return [
        k.id,
        k.schemaVersion,
        k.type,
        k.subject.kind,
        k.subject.id,
        k.subject.file ?? null,
        k.subject.symbol ?? null,
        k.lifecycleState,
        k.validationState,
        k.confidence.score,
        k.freshness.state,
        k.ownership.owner,
        k.ownership.createdBy,
        k.ownership.lastUpdatedBy,
        k.timestamps.createdAt,
        k.timestamps.updatedAt,
        k.timestamps.validatedAt ?? null,
        k.timestamps.promotedAt ?? null,
        k.timestamps.staleAt ?? null,
        k.timestamps.retiredAt ?? null,
        k.timestamps.archivedAt ?? null,
        k.version.knowledgeVersion,
        k.version.producerVersion,
        k.version.migrationVersion,
        JSON.stringify(k.claim),
        JSON.stringify(k.confidence),
        JSON.stringify(k.provenance),
        JSON.stringify(k.freshness),
        JSON.stringify(k.supportingEvidence),
        JSON.stringify(k.contradictions),
        JSON.stringify(k.tags),
        JSON.stringify(k.diagnostics)
    ];
}

function fromRow(row: any): RepositoryKnowledge {
    return {
        id: row.id,
        schemaVersion: row.schema_version,
        type: row.type,
        subject: {
            kind: row.subject_kind,
            id: row.subject_id,
            file: row.subject_file ?? undefined,
            symbol: row.subject_symbol ?? undefined
        },
        claim: JSON.parse(row.claim_json),
        confidence: JSON.parse(row.confidence_json),
        provenance: JSON.parse(row.provenance_json),
        freshness: JSON.parse(row.freshness_json),
        lifecycleState: row.lifecycle_state,
        validationState: row.validation_state,
        supportingEvidence: JSON.parse(row.supporting_evidence_json),
        contradictions: JSON.parse(row.contradictions_json),
        ownership: {
            owner: row.owner,
            createdBy: row.created_by,
            lastUpdatedBy: row.last_updated_by
        },
        timestamps: {
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            validatedAt: row.validated_at ?? undefined,
            promotedAt: row.promoted_at ?? undefined,
            staleAt: row.stale_at ?? undefined,
            retiredAt: row.retired_at ?? undefined,
            archivedAt: row.archived_at ?? undefined
        },
        version: {
            knowledgeVersion: row.knowledge_version,
            producerVersion: row.producer_version,
            migrationVersion: row.migration_version
        },
        tags: JSON.parse(row.tags_json),
        diagnostics: JSON.parse(row.diagnostics_json)
    };
}
