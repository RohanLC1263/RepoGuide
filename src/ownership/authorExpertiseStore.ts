import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';
import { AuthorExpertise, EntityType } from './authorExpertiseTypes';

export class AuthorExpertiseStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS author_expertise (
                author_email TEXT,
                author_name TEXT,
                entity_type TEXT,
                entity_id TEXT,
                expertise_score REAL,
                contribution_count INTEGER,
                coverage_percentage REAL,
                first_contribution_at TEXT,
                last_contribution_at TEXT,
                knowledge_age_days INTEGER,
                PRIMARY KEY (author_email, entity_type, entity_id)
            );

            CREATE INDEX IF NOT EXISTS idx_expertise_entity 
            ON author_expertise(entity_type, entity_id);

            CREATE INDEX IF NOT EXISTS idx_expertise_author 
            ON author_expertise(author_email);

            CREATE INDEX IF NOT EXISTS idx_expertise_top 
            ON author_expertise(entity_type, entity_id, expertise_score DESC);

            CREATE TABLE IF NOT EXISTS author_expertise_evidence (
                author_email TEXT,
                entity_type TEXT,
                entity_id TEXT,
                commit_sha TEXT,
                FOREIGN KEY(author_email, entity_type, entity_id) 
                REFERENCES author_expertise(author_email, entity_type, entity_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_expertise_evidence_edge 
            ON author_expertise_evidence(author_email, entity_type, entity_id);
        `);
    }

    public clearAll(): void {
        const tx = executeTransaction(this.db, () => {
            this.db.exec(`
                DELETE FROM author_expertise_evidence;
                DELETE FROM author_expertise;
            `);
        });
        tx();
    }

    public getExperts(entityType: EntityType, entityId: string): AuthorExpertise[] {
        const rows = this.db.prepare(`
            SELECT * FROM author_expertise 
            WHERE entity_type = ? AND entity_id = ?
            ORDER BY expertise_score DESC
        `).all(entityType, entityId) as any[];

        return rows.map(r => this.mapRow(r));
    }

    public getExpertsForDirectory(directoryPath: string): AuthorExpertise[] {
        const rows = this.db.prepare(`
            SELECT * FROM author_expertise 
            WHERE entity_type = 'DIRECTORY' AND entity_id = ?
            ORDER BY expertise_score DESC
        `).all(directoryPath) as any[];

        return rows.map(r => this.mapRow(r));
    }

    public getExpertsForFiles(paths: string[]): AuthorExpertise[] {
        if (paths.length === 0) return [];
        const placeholders = paths.map(() => '?').join(',');
        const rows = this.db.prepare(`
            SELECT author_email, MAX(author_name) as author_name, 
                   SUM(expertise_score) as expertise_score,
                   SUM(contribution_count) as contribution_count,
                   1.0 as coverage_percentage,
                   MIN(first_contribution_at) as first_contribution_at,
                   MAX(last_contribution_at) as last_contribution_at,
                   MIN(knowledge_age_days) as knowledge_age_days
            FROM author_expertise 
            WHERE entity_type = 'FILE' AND entity_id IN (${placeholders})
            GROUP BY author_email
            ORDER BY expertise_score DESC
        `).all(...paths) as any[];

        return rows.map(r => ({
            authorEmail: r.author_email,
            authorName: r.author_name,
            entityType: 'FILE',
            entityId: 'Multiple',
            expertiseScore: r.expertise_score,
            contributionCount: r.contribution_count,
            coveragePercentage: r.coverage_percentage,
            firstContributionAt: new Date(r.first_contribution_at),
            lastContributionAt: new Date(r.last_contribution_at),
            knowledgeAgeDays: r.knowledge_age_days
        }));
    }

    public getAuthorKnowledge(authorEmail: string): AuthorExpertise[] {
        const rows = this.db.prepare(`
            SELECT * FROM author_expertise 
            WHERE author_email = ?
            ORDER BY expertise_score DESC
        `).all(authorEmail) as any[];

        return rows.map(r => this.mapRow(r));
    }

    public getTopExperts(limit: number): AuthorExpertise[] {
        const rows = this.db.prepare(`
            SELECT * FROM author_expertise 
            ORDER BY expertise_score DESC
            LIMIT ?
        `).all(limit) as any[];

        return rows.map(r => this.mapRow(r));
    }

    public getEvidence(authorEmail: string, entityType: EntityType, entityId: string): string[] {
        const rows = this.db.prepare(`
            SELECT commit_sha FROM author_expertise_evidence 
            WHERE author_email = ? AND entity_type = ? AND entity_id = ?
        `).all(authorEmail, entityType, entityId) as any[];

        return rows.map(r => r.commit_sha);
    }

    private mapRow(row: any): AuthorExpertise {
        return {
            authorEmail: row.author_email,
            authorName: row.author_name,
            entityType: row.entity_type as EntityType,
            entityId: row.entity_id,
            expertiseScore: row.expertise_score,
            contributionCount: row.contribution_count,
            coveragePercentage: row.coverage_percentage,
            firstContributionAt: new Date(row.first_contribution_at),
            lastContributionAt: new Date(row.last_contribution_at),
            knowledgeAgeDays: row.knowledge_age_days
        };
    }
}
