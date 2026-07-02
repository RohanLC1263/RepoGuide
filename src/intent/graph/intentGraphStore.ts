import { DatabaseSync } from 'node:sqlite';
import { IntentGraphEdge, IntentRelationshipType } from './intentGraphTypes';

export class IntentGraphStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS intent_graph_edges (
                id TEXT PRIMARY KEY,
                source_intent_id TEXT,
                target_intent_id TEXT,
                relationship_type TEXT,
                weight INTEGER,
                confidence REAL,
                adr_evidence_count INTEGER DEFAULT 0,
                pr_evidence_count INTEGER DEFAULT 0,
                commit_evidence_count INTEGER DEFAULT 0,
                FOREIGN KEY(source_intent_id) REFERENCES intents(id) ON DELETE CASCADE,
                FOREIGN KEY(target_intent_id) REFERENCES intents(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON intent_graph_edges(source_intent_id);
            CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON intent_graph_edges(target_intent_id);
        `);
    }

    public getEdgesForIntent(intentId: string): IntentGraphEdge[] {
        const rows = this.db.prepare(`
            SELECT * FROM intent_graph_edges 
            WHERE source_intent_id = ? OR target_intent_id = ?
            ORDER BY weight DESC
        `).all(intentId, intentId) as any[];

        return rows.map(r => this.mapEdgeRow(r));
    }

    public getAllEdges(): IntentGraphEdge[] {
        const rows = this.db.prepare(`SELECT * FROM intent_graph_edges`).all() as any[];
        return rows.map(r => this.mapEdgeRow(r));
    }

    private mapEdgeRow(row: any): IntentGraphEdge {
        return {
            id: row.id,
            sourceIntentId: row.source_intent_id,
            targetIntentId: row.target_intent_id,
            relationshipType: row.relationship_type as IntentRelationshipType,
            weight: row.weight,
            confidence: row.confidence,
            adrEvidenceCount: row.adr_evidence_count,
            prEvidenceCount: row.pr_evidence_count,
            commitEvidenceCount: row.commit_evidence_count
        };
    }

    public getCentralIntents(limit: number): string[] {
        // Since V1 is undirected and normalized (source = min, target = max),
        // the degree centrality for node N is SUM(weight) where source = N OR target = N.
        const rows = this.db.prepare(`
            SELECT node, SUM(weight) as total_weight
            FROM (
                SELECT source_intent_id as node, weight FROM intent_graph_edges
                UNION ALL
                SELECT target_intent_id as node, weight FROM intent_graph_edges
            )
            GROUP BY node
            ORDER BY total_weight DESC
            LIMIT ?
        `).all(limit) as any[];

        return rows.map(r => r.node);
    }
    
    public getDatabase(): DatabaseSync {
        return this.db;
    }
}
