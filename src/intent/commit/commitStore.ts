import { DatabaseSync } from 'node:sqlite';
import { openDatabase, executeTransaction } from '../../store/sqliteLoader';
import { CommitEntity, CommitFileChange } from './commitTypes';

export class CommitStore {
    private db: DatabaseSync;

    constructor(dbPathOrDb: string | DatabaseSync = ':memory:') {
        if (typeof dbPathOrDb === 'string') {
            this.db = openDatabase(dbPathOrDb);
        } else {
            this.db = dbPathOrDb;
        }
        this.initSchema();
    }
    
    public getDatabase(): DatabaseSync {
        return this.db;
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS commits (
                sha TEXT PRIMARY KEY,
                author_name TEXT,
                author_email TEXT,
                message TEXT,
                timestamp TEXT,
                parent_shas TEXT,
                repository_id TEXT
            );

            CREATE TABLE IF NOT EXISTS commit_files (
                sha TEXT,
                path TEXT,
                old_path TEXT,
                additions INTEGER,
                deletions INTEGER,
                changes INTEGER,
                change_type TEXT,
                FOREIGN KEY(sha) REFERENCES commits(sha) ON DELETE CASCADE
            );
            
            CREATE INDEX IF NOT EXISTS idx_commit_files_path ON commit_files(path);
            CREATE INDEX IF NOT EXISTS idx_commit_files_old_path ON commit_files(old_path);
            CREATE INDEX IF NOT EXISTS idx_commits_author ON commits(author_name);
            CREATE INDEX IF NOT EXISTS idx_commits_timestamp ON commits(timestamp);

            CREATE TABLE IF NOT EXISTS sync_state (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);
    }

    public async save(commit: CommitEntity): Promise<void> {
        const tx = executeTransaction(this.db, () => {
            // Upsert Commit
            const stmtCommit = this.db.prepare(`
                INSERT INTO commits (sha, author_name, author_email, message, timestamp, parent_shas, repository_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(sha) DO UPDATE SET
                    author_name=excluded.author_name,
                    author_email=excluded.author_email,
                    message=excluded.message,
                    timestamp=excluded.timestamp,
                    parent_shas=excluded.parent_shas
            `);
            stmtCommit.run(
                commit.sha, 
                commit.authorName, 
                commit.authorEmail, 
                commit.message, 
                commit.timestamp.toISOString(), 
                JSON.stringify(commit.parentShas), 
                commit.repositoryId
            );

            // Replace Files
            this.db.prepare(`DELETE FROM commit_files WHERE sha = ?`).run(commit.sha);
            const stmtFile = this.db.prepare(`
                INSERT INTO commit_files (sha, path, old_path, additions, deletions, changes, change_type) 
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            for (const file of commit.files) {
                stmtFile.run(
                    commit.sha, 
                    file.path, 
                    file.oldPath || null, 
                    file.additions, 
                    file.deletions, 
                    file.changes, 
                    file.changeType
                );
            }
        });

        tx();
    }

    public async saveBatch(commits: CommitEntity[]): Promise<void> {
        const tx = executeTransaction(this.db, () => {
            const stmtCommit = this.db.prepare(`
                INSERT INTO commits (sha, author_name, author_email, message, timestamp, parent_shas, repository_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(sha) DO UPDATE SET
                    author_name=excluded.author_name,
                    author_email=excluded.author_email,
                    message=excluded.message,
                    timestamp=excluded.timestamp,
                    parent_shas=excluded.parent_shas
            `);
            
            const stmtDeleteFiles = this.db.prepare(`DELETE FROM commit_files WHERE sha = ?`);
            const stmtFile = this.db.prepare(`
                INSERT INTO commit_files (sha, path, old_path, additions, deletions, changes, change_type) 
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            for (const commit of commits) {
                stmtCommit.run(
                    commit.sha, 
                    commit.authorName, 
                    commit.authorEmail, 
                    commit.message, 
                    commit.timestamp.toISOString(), 
                    JSON.stringify(commit.parentShas), 
                    commit.repositoryId
                );

                stmtDeleteFiles.run(commit.sha);
                
                for (const file of commit.files) {
                    stmtFile.run(
                        commit.sha, 
                        file.path, 
                        file.oldPath || null, 
                        file.additions, 
                        file.deletions, 
                        file.changes, 
                        file.changeType
                    );
                }
            }
        });

        tx();
    }

    private mapCommitRow(row: any): CommitEntity {
        const commit: CommitEntity = {
            sha: row.sha,
            authorName: row.author_name,
            authorEmail: row.author_email,
            message: row.message,
            timestamp: new Date(row.timestamp),
            parentShas: JSON.parse(row.parent_shas || '[]'),
            repositoryId: row.repository_id,
            files: []
        };

        const files = this.db.prepare(`SELECT * FROM commit_files WHERE sha = ?`).all(commit.sha) as any[];
        commit.files = files.map(f => {
            const fc: CommitFileChange = {
                sha: f.sha,
                path: f.path,
                additions: f.additions,
                deletions: f.deletions,
                changes: f.changes,
                changeType: f.change_type as any
            };
            if (f.old_path) fc.oldPath = f.old_path;
            return fc;
        });

        return commit;
    }

    public getBySha(sha: string): CommitEntity | null {
        const row = this.db.prepare(`SELECT * FROM commits WHERE sha = ?`).get(sha);
        if (!row) return null;
        return this.mapCommitRow(row);
    }

    public getByFile(path: string): CommitEntity[] {
        // Find commits that touched this path either directly or via rename (old_path)
        const rows = this.db.prepare(`
            SELECT DISTINCT c.* FROM commits c
            JOIN commit_files f ON c.sha = f.sha
            WHERE f.path = ? OR f.old_path = ?
            ORDER BY c.timestamp DESC
        `).all(path, path);
        
        return rows.map(r => this.mapCommitRow(r));
    }

    public getByAuthor(author: string): CommitEntity[] {
        const rows = this.db.prepare(`
            SELECT * FROM commits 
            WHERE author_name = ? OR author_email = ?
            ORDER BY timestamp DESC
        `).all(author, author);
        
        return rows.map(r => this.mapCommitRow(r));
    }

    public getRecentCommits(limit: number): CommitEntity[] {
        const rows = this.db.prepare(`
            SELECT * FROM commits 
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(limit);
        
        return rows.map(r => this.mapCommitRow(r));
    }

    public getLastProcessedCommit(): string | null {
        const row = this.db.prepare(`SELECT value FROM sync_state WHERE key = 'lastProcessedCommit'`).get() as any;
        if (!row) return null;
        return row.value;
    }

    public getCommitsSince(timestamp: Date | null, limit: number): CommitEntity[] {
        let rows;
        if (timestamp) {
            rows = this.db.prepare(`
                SELECT * FROM commits 
                WHERE timestamp > ?
                ORDER BY timestamp ASC
                LIMIT ?
            `).all(timestamp.toISOString(), limit);
        } else {
            rows = this.db.prepare(`
                SELECT * FROM commits 
                ORDER BY timestamp ASC
                LIMIT ?
            `).all(limit);
        }
        return rows.map(r => this.mapCommitRow(r));
    }

    public setLastProcessedCommit(sha: string): void {
        const stmt = this.db.prepare(`
            INSERT INTO sync_state (key, value) VALUES ('lastProcessedCommit', ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
        `);
        stmt.run(sha);
    }
    
    public truncateAll(): void {
        const tx = executeTransaction(this.db, () => {
            this.db.exec(`
                DELETE FROM commit_files;
                DELETE FROM commits;
                DELETE FROM sync_state;
            `);
        });
        tx();
    }

    public close() {
        this.db.close();
    }
}
