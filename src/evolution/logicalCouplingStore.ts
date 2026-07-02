import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';
import { LogicalCouplingEdge, FileChangeStats, LogicalCouplingEvidence } from './logicalCouplingTypes';

export class LogicalCouplingStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS logical_coupling_edges (
                id TEXT PRIMARY KEY,
                source_path TEXT,
                target_path TEXT,
                co_change_count INTEGER,
                confidence REAL,
                first_seen_at TEXT,
                last_seen_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_coupling_source ON logical_coupling_edges(source_path);
            CREATE INDEX IF NOT EXISTS idx_coupling_target ON logical_coupling_edges(target_path);
            CREATE INDEX IF NOT EXISTS idx_coupling_confidence ON logical_coupling_edges(confidence DESC);

            CREATE TABLE IF NOT EXISTS file_change_stats (
                path TEXT PRIMARY KEY,
                change_count INTEGER,
                first_seen_at TEXT,
                last_seen_at TEXT
            );

            CREATE TABLE IF NOT EXISTS logical_coupling_evidence (
                edge_id TEXT,
                commit_sha TEXT,
                FOREIGN KEY(edge_id) REFERENCES logical_coupling_edges(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_coupling_evidence_edge ON logical_coupling_evidence(edge_id);
        `);
    }

    public clearAll(): void {
        const tx = executeTransaction(this.db, () => {
            this.db.exec(`
                DELETE FROM logical_coupling_evidence;
                DELETE FROM logical_coupling_edges;
                DELETE FROM file_change_stats;
            `);
        });
        tx();
    }

    public getCouplings(path: string): LogicalCouplingEdge[] {
        // Query both directions (even though we'll normalize during build, it's safer for queries)
        const rows = this.db.prepare(`
            SELECT * FROM logical_coupling_edges 
            WHERE source_path = ? OR target_path = ?
            ORDER BY confidence DESC
        `).all(path, path) as any[];

        return rows.map(r => this.mapEdgeRow(r));
    }

    public getStrongestCouplings(limit: number): LogicalCouplingEdge[] {
        const rows = this.db.prepare(`
            SELECT * FROM logical_coupling_edges 
            ORDER BY confidence DESC 
            LIMIT ?
        `).all(limit) as any[];

        return rows.map(r => this.mapEdgeRow(r));
    }

    public getCoupling(source: string, target: string): LogicalCouplingEdge | null {
        // Handle undirected lookup
        const path1 = source < target ? source : target;
        const path2 = source < target ? target : source;

        const row = this.db.prepare(`
            SELECT * FROM logical_coupling_edges 
            WHERE source_path = ? AND target_path = ?
        `).get(path1, path2) as any;

        return row ? this.mapEdgeRow(row) : null;
    }

    public getEvidenceForEdge(edgeId: string): string[] {
        const rows = this.db.prepare(`
            SELECT commit_sha FROM logical_coupling_evidence WHERE edge_id = ?
        `).all(edgeId) as any[];
        
        return rows.map(r => r.commit_sha);
    }

    public getFileStats(path: string): FileChangeStats | null {
        const row = this.db.prepare(`
            SELECT * FROM file_change_stats WHERE path = ?
        `).get(path) as any;

        return row ? {
            path: row.path,
            changeCount: row.change_count,
            firstSeenAt: new Date(row.first_seen_at),
            lastSeenAt: new Date(row.last_seen_at)
        } : null;
    }

    private mapEdgeRow(row: any): LogicalCouplingEdge {
        return {
            id: row.id,
            sourcePath: row.source_path,
            targetPath: row.target_path,
            coChangeCount: row.co_change_count,
            confidence: row.confidence,
            firstSeenAt: new Date(row.first_seen_at),
            lastSeenAt: new Date(row.last_seen_at)
        };
    }
}
