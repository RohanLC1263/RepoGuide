import { DatabaseSync } from 'node:sqlite';
import { openDatabase, executeTransaction } from '../../store/sqliteLoader';
import { PullRequestEntity, PullRequestCommit, PullRequestFile, PullRequestComment, PullRequestReview } from './prTypes';

export class PullRequestStore {
    private db: DatabaseSync;

    constructor(dbPath: string = ':memory:') {
        this.db = openDatabase(dbPath);
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS prs (
                id TEXT PRIMARY KEY,
                number INTEGER,
                title TEXT,
                body TEXT,
                state TEXT,
                author TEXT,
                createdAt TEXT,
                updatedAt TEXT,
                mergedAt TEXT,
                repositoryId TEXT
            );

            CREATE TABLE IF NOT EXISTS pr_commits (
                sha TEXT PRIMARY KEY,
                pr_id TEXT,
                message TEXT,
                author TEXT,
                timestamp TEXT,
                FOREIGN KEY(pr_id) REFERENCES prs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS pr_files (
                pr_id TEXT,
                path TEXT,
                additions INTEGER,
                deletions INTEGER,
                changes INTEGER,
                FOREIGN KEY(pr_id) REFERENCES prs(id) ON DELETE CASCADE
            );
            
            CREATE INDEX IF NOT EXISTS idx_pr_files_path ON pr_files(path);

            CREATE TABLE IF NOT EXISTS pr_comments (
                id TEXT PRIMARY KEY,
                pr_id TEXT,
                author TEXT,
                body TEXT,
                createdAt TEXT,
                FOREIGN KEY(pr_id) REFERENCES prs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS pr_reviews (
                id TEXT PRIMARY KEY,
                pr_id TEXT,
                reviewer TEXT,
                state TEXT,
                submittedAt TEXT,
                FOREIGN KEY(pr_id) REFERENCES prs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS sync_state (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);
    }

    public async save(pr: PullRequestEntity): Promise<void> {
        const tx = executeTransaction(this.db, () => {
            // Upsert PR
            const stmtPr = this.db.prepare(`
                INSERT INTO prs (id, number, title, body, state, author, createdAt, updatedAt, mergedAt, repositoryId)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title,
                    body=excluded.body,
                    state=excluded.state,
                    updatedAt=excluded.updatedAt,
                    mergedAt=excluded.mergedAt
            `);
            stmtPr.run(
                pr.id, pr.number, pr.title, pr.body, pr.state, pr.author, 
                pr.createdAt.toISOString(), pr.updatedAt.toISOString(), pr.mergedAt?.toISOString() || null, pr.repositoryId
            );

            // Replace Commits
            this.db.prepare(`DELETE FROM pr_commits WHERE pr_id = ?`).run(pr.id);
            const stmtCommit = this.db.prepare(`INSERT INTO pr_commits (sha, pr_id, message, author, timestamp) VALUES (?, ?, ?, ?, ?)`);
            for (const commit of pr.commits) {
                stmtCommit.run(commit.sha, pr.id, commit.message, commit.author, commit.timestamp.toISOString());
            }

            // Replace Files
            this.db.prepare(`DELETE FROM pr_files WHERE pr_id = ?`).run(pr.id);
            const stmtFile = this.db.prepare(`INSERT INTO pr_files (pr_id, path, additions, deletions, changes) VALUES (?, ?, ?, ?, ?)`);
            for (const file of pr.files) {
                stmtFile.run(pr.id, file.path, file.additions, file.deletions, file.changes);
            }

            // Replace Comments
            this.db.prepare(`DELETE FROM pr_comments WHERE pr_id = ?`).run(pr.id);
            const stmtComment = this.db.prepare(`INSERT INTO pr_comments (id, pr_id, author, body, createdAt) VALUES (?, ?, ?, ?, ?)`);
            for (const comment of pr.comments) {
                stmtComment.run(comment.id, pr.id, comment.author, comment.body, comment.createdAt.toISOString());
            }

            // Replace Reviews
            this.db.prepare(`DELETE FROM pr_reviews WHERE pr_id = ?`).run(pr.id);
            const stmtReview = this.db.prepare(`INSERT INTO pr_reviews (id, pr_id, reviewer, state, submittedAt) VALUES (?, ?, ?, ?, ?)`);
            for (const review of pr.reviews) {
                stmtReview.run(review.id, pr.id, review.reviewer, review.state, review.submittedAt.toISOString());
            }
        });

        tx();
    }

    private mapPrRow(row: any): PullRequestEntity {
        const pr: PullRequestEntity = {
            id: row.id,
            number: row.number,
            title: row.title,
            body: row.body,
            state: row.state as any,
            author: row.author,
            createdAt: new Date(row.createdAt),
            updatedAt: new Date(row.updatedAt),
            repositoryId: row.repositoryId,
            commits: [],
            files: [],
            comments: [],
            reviews: []
        };
        if (row.mergedAt) pr.mergedAt = new Date(row.mergedAt);

        // Fetch Commits
        const commits = this.db.prepare(`SELECT * FROM pr_commits WHERE pr_id = ?`).all(pr.id) as any[];
        pr.commits = commits.map(c => ({
            sha: c.sha, message: c.message, author: c.author, timestamp: new Date(c.timestamp)
        }));

        // Fetch Files
        const files = this.db.prepare(`SELECT * FROM pr_files WHERE pr_id = ?`).all(pr.id) as any[];
        pr.files = files.map(f => ({
            path: f.path, additions: f.additions, deletions: f.deletions, changes: f.changes
        }));

        // Fetch Comments
        const comments = this.db.prepare(`SELECT * FROM pr_comments WHERE pr_id = ?`).all(pr.id) as any[];
        pr.comments = comments.map(c => ({
            id: c.id, author: c.author, body: c.body, createdAt: new Date(c.createdAt)
        }));

        // Fetch Reviews
        const reviews = this.db.prepare(`SELECT * FROM pr_reviews WHERE pr_id = ?`).all(pr.id) as any[];
        pr.reviews = reviews.map(r => ({
            id: r.id, reviewer: r.reviewer, state: r.state as any, submittedAt: new Date(r.submittedAt)
        }));

        return pr;
    }

    public getById(id: string): PullRequestEntity | null {
        const row = this.db.prepare(`SELECT * FROM prs WHERE id = ?`).get(id);
        if (!row) return null;
        return this.mapPrRow(row);
    }

    public getByNumber(number: number): PullRequestEntity | null {
        const row = this.db.prepare(`SELECT * FROM prs WHERE number = ?`).get(number);
        if (!row) return null;
        return this.mapPrRow(row);
    }

    public getPRsForFile(path: string): PullRequestEntity[] {
        // Fast index lookup
        const rows = this.db.prepare(`
            SELECT p.* FROM prs p
            JOIN pr_files f ON p.id = f.pr_id
            WHERE f.path = ?
        `).all(path);
        
        return rows.map(r => this.mapPrRow(r));
    }

    public getLastSyncTimestamp(): Date | null {
        const row = this.db.prepare(`SELECT value FROM sync_state WHERE key = 'lastSyncTimestamp'`).get() as any;
        if (!row) return null;
        return new Date(row.value);
    }

    public getPRsSince(timestamp: Date | null, limit: number): PullRequestEntity[] {
        let rows;
        if (timestamp) {
            rows = this.db.prepare(`
                SELECT * FROM prs 
                WHERE updatedAt > ?
                ORDER BY updatedAt ASC
                LIMIT ?
            `).all(timestamp.toISOString(), limit);
        } else {
            rows = this.db.prepare(`
                SELECT * FROM prs 
                ORDER BY updatedAt ASC
                LIMIT ?
            `).all(limit);
        }
        return rows.map(r => this.mapPrRow(r));
    }

    public setLastSyncTimestamp(date: Date): void {
        const stmt = this.db.prepare(`
            INSERT INTO sync_state (key, value) VALUES ('lastSyncTimestamp', ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
        `);
        stmt.run(date.toISOString());
    }

    public close() {
        this.db.close();
    }
}
