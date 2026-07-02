import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'crypto';
import { executeTransaction } from '../store/sqliteLoader';
import { LogicalCouplingStore } from './logicalCouplingStore';
import { RepositoryBuilder } from '../orchestrator/orchestratorTypes';

export class LogicalCouplingBuilder implements RepositoryBuilder {
    private readonly MAX_FILES_PER_COMMIT = 50;
    private readonly MIN_CO_CHANGE_COUNT = 2;

    constructor(
        private db: DatabaseSync,
        private store: LogicalCouplingStore
    ) {}

    public async build(): Promise<void> {
        // 1. Clear existing logical coupling data
        this.store.clearAll();

        const tx = executeTransaction(this.db, () => {
            // 2. Setup temporary workspace
            this.db.exec(`
                DROP TABLE IF EXISTS temp_valid_commits;
                DROP TABLE IF EXISTS temp_valid_files;
                DROP TABLE IF EXISTS temp_pairs;
                
                CREATE TEMP TABLE temp_valid_files (
                    sha TEXT,
                    path TEXT,
                    timestamp TEXT
                );
                
                CREATE TEMP TABLE temp_pairs (
                    source_path TEXT,
                    target_path TEXT,
                    sha TEXT,
                    timestamp TEXT
                );
            `);

            // 3. Filter noise and insert valid files
            // Exclude common generated directories/lockfiles
            this.db.exec(`
                INSERT INTO temp_valid_files (sha, path, timestamp)
                SELECT f.sha, f.path, c.timestamp
                FROM commit_files f
                JOIN commits c ON c.sha = f.sha
                WHERE f.change_type != 'DELETE'
                AND f.path NOT LIKE '%package-lock.json'
                AND f.path NOT LIKE '%yarn.lock'
                AND f.path NOT LIKE '%pnpm-lock.yaml'
                AND f.path NOT LIKE '%/node_modules/%'
                AND f.path NOT LIKE '%/vendor/%'
                AND f.path NOT LIKE '%/dist/%'
                AND f.path NOT LIKE '%/build/%';
            `);

            // 4. Exclude large commits (> 50 files) to prevent pairing explosion
            this.db.exec(`
                CREATE TEMP TABLE temp_valid_commits AS
                SELECT sha 
                FROM temp_valid_files 
                GROUP BY sha 
                HAVING COUNT(*) <= ${this.MAX_FILES_PER_COMMIT};
            `);

            // 5. Delete files from invalid commits
            this.db.exec(`
                DELETE FROM temp_valid_files 
                WHERE sha NOT IN (SELECT sha FROM temp_valid_commits);
            `);

            // 6. Compute File Change Stats (only counting valid changes)
            this.db.exec(`
                INSERT INTO file_change_stats (path, change_count, first_seen_at, last_seen_at)
                SELECT 
                    path,
                    COUNT(sha) as change_count,
                    MIN(timestamp) as first_seen_at,
                    MAX(timestamp) as last_seen_at
                FROM temp_valid_files
                GROUP BY path;
            `);

            // 7. Generate File Pairs (Normalized: source_path < target_path)
            this.db.exec(`
                INSERT INTO temp_pairs (source_path, target_path, sha, timestamp)
                SELECT 
                    a.path as source_path,
                    b.path as target_path,
                    a.sha as sha,
                    a.timestamp as timestamp
                FROM temp_valid_files a
                JOIN temp_valid_files b ON a.sha = b.sha AND a.path < b.path;
            `);

            // 8. Aggregate and Compute Confidence
            const edgesStmt = this.db.prepare(`
                SELECT 
                    p.source_path,
                    p.target_path,
                    COUNT(p.sha) as co_change_count,
                    MIN(p.timestamp) as first_seen_at,
                    MAX(p.timestamp) as last_seen_at
                FROM temp_pairs p
                GROUP BY p.source_path, p.target_path
                HAVING COUNT(p.sha) >= ${this.MIN_CO_CHANGE_COUNT}
            `);

            const insertEdge = this.db.prepare(`
                INSERT INTO logical_coupling_edges 
                (id, source_path, target_path, co_change_count, confidence, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            const getStats = this.db.prepare(`
                SELECT change_count FROM file_change_stats WHERE path = ?
            `);

            const edgesIter = edgesStmt.iterate() as IterableIterator<any>;
            
            // Collect edge info for evidence insertion
            const validEdgeMap = new Map<string, {source: string, target: string}>();

            for (const edge of edgesIter) {
                const sourceStats = getStats.get(edge.source_path) as any;
                const targetStats = getStats.get(edge.target_path) as any;
                
                const sourceCount = sourceStats ? sourceStats.change_count : 0;
                const targetCount = targetStats ? targetStats.change_count : 0;
                
                // Jaccard Similarity = (A ∩ B) / (A ∪ B)
                // A ∪ B = A + B - (A ∩ B)
                const union = sourceCount + targetCount - edge.co_change_count;
                const confidence = union > 0 ? edge.co_change_count / union : 0;

                const edgeId = randomUUID();
                validEdgeMap.set(edgeId, { source: edge.source_path, target: edge.target_path });

                insertEdge.run(
                    edgeId,
                    edge.source_path,
                    edge.target_path,
                    edge.co_change_count,
                    confidence,
                    edge.first_seen_at,
                    edge.last_seen_at
                );
            }

            // 9. Collect Evidence (Bounded at 20 commits per edge)
            const getEvidence = this.db.prepare(`
                SELECT sha FROM temp_pairs 
                WHERE source_path = ? AND target_path = ?
                ORDER BY timestamp DESC
                LIMIT 20
            `);

            const insertEvidence = this.db.prepare(`
                INSERT INTO logical_coupling_evidence (edge_id, commit_sha)
                VALUES (?, ?)
            `);

            for (const [edgeId, paths] of validEdgeMap.entries()) {
                const evidences = getEvidence.all(paths.source, paths.target) as any[];
                for (const ev of evidences) {
                    insertEvidence.run(edgeId, ev.sha);
                }
            }

            // Cleanup
            this.db.exec(`
                DROP TABLE temp_valid_commits;
                DROP TABLE temp_valid_files;
                DROP TABLE temp_pairs;
            `);
        });

        tx();
    }
}
