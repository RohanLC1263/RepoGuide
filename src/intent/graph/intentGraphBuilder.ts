import { IntentGraphStore } from './intentGraphStore';
import { executeTransaction } from '../../store/sqliteLoader';

export class IntentGraphBuilder {
    constructor(private store: IntentGraphStore) {}

    /**
     * Rebuilds the entire intent graph from scratch based on intent_evidence co-occurrences.
     * Operates purely in SQLite for massive performance.
     */
    public build(): void {
        const db = this.store.getDatabase();

        const tx = executeTransaction(db, () => {
            // 1. Truncate existing graph edges
            db.exec(`DELETE FROM intent_graph_edges`);

            // 2. Perform the JOIN and aggregate into the undirected edges
            db.exec(`
                INSERT INTO intent_graph_edges (
                    id, 
                    source_intent_id, 
                    target_intent_id, 
                    relationship_type, 
                    weight, 
                    confidence, 
                    adr_evidence_count, 
                    pr_evidence_count, 
                    commit_evidence_count
                )
                SELECT 
                    hex(randomblob(16)) as id,
                    a.intent_id as source_intent_id,
                    b.intent_id as target_intent_id,
                    'RELATED_TO' as relationship_type,
                    COUNT(*) as weight,
                    MIN(1.0, COUNT(*) / 10.0) as confidence,
                    SUM(CASE WHEN a.source_type = 'ADR' THEN 1 ELSE 0 END) as adr_evidence_count,
                    SUM(CASE WHEN a.source_type = 'PR' THEN 1 ELSE 0 END) as pr_evidence_count,
                    SUM(CASE WHEN a.source_type = 'COMMIT' THEN 1 ELSE 0 END) as commit_evidence_count
                FROM intent_evidence a
                JOIN intent_evidence b 
                  ON a.source_type = b.source_type AND a.source_id = b.source_id
                WHERE a.intent_id < b.intent_id
                GROUP BY a.intent_id, b.intent_id
                HAVING COUNT(*) >= 2
            `);
        });

        tx();
    }
}
