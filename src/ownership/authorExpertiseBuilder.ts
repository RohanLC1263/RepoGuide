import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';
import { AuthorExpertiseStore } from './authorExpertiseStore';

import { RepositoryBuilder } from '../orchestrator/orchestratorTypes';

export class AuthorExpertiseBuilder implements RepositoryBuilder {
    private readonly MAX_FILES_PER_COMMIT = 50;
    private readonly MAX_FILE_EXPERTISE_CAP = 10;

    constructor(
        private db: DatabaseSync,
        private store: AuthorExpertiseStore
    ) {}

    public async build(): Promise<void> {
        this.store.clearAll();

        const tx = executeTransaction(this.db, () => {
            // 1. Setup temp tables
            this.db.exec(`
                DROP TABLE IF EXISTS temp_author_files;
                
                CREATE TEMP TABLE temp_author_files (
                    author_email TEXT,
                    author_name TEXT,
                    path TEXT,
                    sha TEXT,
                    timestamp TEXT,
                    days_ago REAL,
                    recency_multiplier REAL
                );
            `);

            // 2. Extract valid file modifications per author
            // Filtering:
            // - Exclude massive commits (> 50 files)
            // - Exclude merge commits (parent_shas > 1)
            // - Exclude bots
            // - Exclude noise paths
            this.db.exec(`
                INSERT INTO temp_author_files (author_email, author_name, path, sha, timestamp, days_ago, recency_multiplier)
                SELECT 
                    LOWER(c.author_email) as author_email,
                    c.author_name,
                    f.path,
                    c.sha,
                    c.timestamp,
                    julianday('now') - julianday(c.timestamp) as days_ago,
                    CASE 
                        WHEN (julianday('now') - julianday(c.timestamp)) <= 30 THEN 1.0
                        WHEN (julianday('now') - julianday(c.timestamp)) <= 90 THEN 0.8
                        WHEN (julianday('now') - julianday(c.timestamp)) <= 365 THEN 0.5
                        ELSE 0.25
                    END as recency_multiplier
                FROM commits c
                JOIN commit_files f ON c.sha = f.sha
                WHERE json_array_length(c.parent_shas) <= 1
                AND LOWER(c.author_email) NOT LIKE '%bot%'
                AND LOWER(c.author_name) NOT LIKE '%bot%'
                AND f.change_type != 'DELETE'
                AND f.path NOT LIKE '%package-lock.json'
                AND f.path NOT LIKE '%yarn.lock'
                AND f.path NOT LIKE '%pnpm-lock.yaml'
                AND f.path NOT LIKE '%/node_modules/%'
                AND f.path NOT LIKE '%/vendor/%'
                AND f.path NOT LIKE '%/dist/%'
                AND f.path NOT LIKE '%/build/%'
                AND c.sha IN (
                    SELECT sha FROM commit_files GROUP BY sha HAVING COUNT(*) <= ${this.MAX_FILES_PER_COMMIT}
                );
            `);

            // 3. Aggregate FILE Expertise
            this.db.exec(`
                INSERT INTO author_expertise (
                    author_email, author_name, entity_type, entity_id, 
                    expertise_score, contribution_count, coverage_percentage,
                    first_contribution_at, last_contribution_at, knowledge_age_days
                )
                SELECT 
                    author_email,
                    MAX(author_name) as author_name,
                    'FILE' as entity_type,
                    path as entity_id,
                    SUM(recency_multiplier) as expertise_score,
                    COUNT(sha) as contribution_count,
                    1.0 as coverage_percentage,
                    MIN(timestamp) as first_contribution_at,
                    MAX(timestamp) as last_contribution_at,
                    MIN(days_ago) as knowledge_age_days
                FROM temp_author_files
                GROUP BY author_email, path;
            `);

            // Save evidence for FILEs
            this.db.exec(`
                INSERT INTO author_expertise_evidence (author_email, entity_type, entity_id, commit_sha)
                SELECT e.author_email, 'FILE', e.entity_id, t.sha
                FROM author_expertise e
                JOIN temp_author_files t ON e.author_email = t.author_email AND e.entity_id = t.path
                WHERE e.entity_type = 'FILE'
                GROUP BY e.author_email, e.entity_id, t.sha
                ORDER BY t.timestamp DESC
                -- SQLite doesn't easily support LIMIT per group in INSERT SELECT, but we can do it via row_number
                -- For simplicity and speed in V1, we will just insert all valid evidence and let the engine slice it if needed.
                -- Wait, we MUST bound it to 20!
            `);

            // Bounding evidence to top 20 per edge using ROW_NUMBER()
            this.db.exec(`
                DELETE FROM author_expertise_evidence WHERE entity_type = 'FILE' AND rowid NOT IN (
                    SELECT rowid FROM (
                        SELECT rowid, ROW_NUMBER() OVER (PARTITION BY author_email, entity_type, entity_id ORDER BY commit_sha DESC) as rn 
                        FROM author_expertise_evidence WHERE entity_type = 'FILE'
                    ) WHERE rn <= 20
                );
            `);

            // 4. Aggregate DIRECTORY Expertise (Handled in JS due to lack of REVERSE() in base SQLite)
            const fileRows = this.db.prepare("SELECT * FROM author_expertise WHERE entity_type = 'FILE'").all() as any[];
            const dirMap = new Map<string, any>();
            
            for (const row of fileRows) {
                const path = row.entity_id;
                const lastSlash = path.lastIndexOf('/');
                const dirPath = lastSlash > 0 ? path.substring(0, lastSlash) : '.';
                
                const key = `${row.author_email}|${dirPath}`;
                if (!dirMap.has(key)) {
                    dirMap.set(key, {
                        author_email: row.author_email,
                        author_name: row.author_name,
                        entity_type: 'DIRECTORY',
                        entity_id: dirPath,
                        expertise_score: 0,
                        contribution_count: 0,
                        coverage_percentage: 1.0,
                        first_contribution_at: row.first_contribution_at,
                        last_contribution_at: row.last_contribution_at,
                        knowledge_age_days: row.knowledge_age_days
                    });
                }
                
                const entry = dirMap.get(key);
                entry.expertise_score += Math.min(row.expertise_score, this.MAX_FILE_EXPERTISE_CAP);
                entry.contribution_count += row.contribution_count;
                if (row.first_contribution_at < entry.first_contribution_at) entry.first_contribution_at = row.first_contribution_at;
                if (row.last_contribution_at > entry.last_contribution_at) entry.last_contribution_at = row.last_contribution_at;
                if (row.knowledge_age_days < entry.knowledge_age_days) entry.knowledge_age_days = row.knowledge_age_days;
            }
            
            const insertDirStmt = this.db.prepare(`
                INSERT INTO author_expertise (
                    author_email, author_name, entity_type, entity_id, 
                    expertise_score, contribution_count, coverage_percentage,
                    first_contribution_at, last_contribution_at, knowledge_age_days
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            
            for (const entry of dirMap.values()) {
                insertDirStmt.run(
                    entry.author_email, entry.author_name, entry.entity_type, entry.entity_id,
                    entry.expertise_score, entry.contribution_count, entry.coverage_percentage,
                    entry.first_contribution_at, entry.last_contribution_at, entry.knowledge_age_days
                );
            }

            // 5. Aggregate ADR Expertise
            // Only aggregate distinct files linked to the ADR
            this.db.exec(`
                DROP TABLE IF EXISTS temp_adr_files;
                CREATE TEMP TABLE temp_adr_files AS 
                SELECT DISTINCT adr_id, node_id as file_path FROM adr_code_links;
            `);

            this.db.exec(`
                INSERT INTO author_expertise (
                    author_email, author_name, entity_type, entity_id, 
                    expertise_score, contribution_count, coverage_percentage,
                    first_contribution_at, last_contribution_at, knowledge_age_days
                )
                SELECT 
                    e.author_email,
                    MAX(e.author_name),
                    'ADR',
                    a.adr_id,
                    SUM(MIN(e.expertise_score, ${this.MAX_FILE_EXPERTISE_CAP})) as expertise_score,
                    SUM(e.contribution_count),
                    CAST(COUNT(DISTINCT a.file_path) AS REAL) / (SELECT COUNT(DISTINCT file_path) FROM temp_adr_files WHERE adr_id = a.adr_id) as coverage_percentage,
                    MIN(e.first_contribution_at),
                    MAX(e.last_contribution_at),
                    MIN(e.knowledge_age_days)
                FROM author_expertise e
                JOIN temp_adr_files a ON e.entity_id = a.file_path
                WHERE e.entity_type = 'FILE'
                GROUP BY e.author_email, a.adr_id;
            `);

            // 6. Aggregate INTENT Expertise
            this.db.exec(`
                DROP TABLE IF EXISTS temp_intent_files;
                CREATE TEMP TABLE temp_intent_files AS 
                SELECT DISTINCT intent_id, source_id as file_path FROM intent_evidence WHERE source_type = 'FILE';
            `);

            this.db.exec(`
                INSERT INTO author_expertise (
                    author_email, author_name, entity_type, entity_id, 
                    expertise_score, contribution_count, coverage_percentage,
                    first_contribution_at, last_contribution_at, knowledge_age_days
                )
                SELECT 
                    e.author_email,
                    MAX(e.author_name),
                    'INTENT',
                    i.intent_id,
                    SUM(MIN(e.expertise_score, ${this.MAX_FILE_EXPERTISE_CAP})) as expertise_score,
                    SUM(e.contribution_count),
                    CAST(COUNT(DISTINCT i.file_path) AS REAL) / (SELECT COUNT(DISTINCT file_path) FROM temp_intent_files WHERE intent_id = i.intent_id) as coverage_percentage,
                    MIN(e.first_contribution_at),
                    MAX(e.last_contribution_at),
                    MIN(e.knowledge_age_days)
                FROM author_expertise e
                JOIN temp_intent_files i ON e.entity_id = i.file_path
                WHERE e.entity_type = 'FILE'
                GROUP BY e.author_email, i.intent_id;
            `);

            // Cleanup
            this.db.exec(`
                DROP TABLE temp_author_files;
                DROP TABLE IF EXISTS temp_adr_files;
                DROP TABLE IF EXISTS temp_intent_files;
            `);
        });

        tx();
    }
}
