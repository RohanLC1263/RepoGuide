import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';
import { IntentAwareImpact, IntentImpactPath, GovernanceEvidence } from './intentAwareBlastRadiusTypes';

export class IntentAwareBlastRadiusStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS intent_aware_impacts (
                id TEXT PRIMARY KEY,
                root_node_id TEXT,
                governance_snapshot_version TEXT,
                governance_score REAL,
                governance_severity TEXT,
                generated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS impact_nodes (
                impact_id TEXT,
                node_id TEXT,
                FOREIGN KEY(impact_id) REFERENCES intent_aware_impacts(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS impact_adrs (
                impact_id TEXT,
                adr_id TEXT,
                FOREIGN KEY(impact_id) REFERENCES intent_aware_impacts(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS impact_intents (
                impact_id TEXT,
                intent_id TEXT,
                is_neighbor INTEGER,
                FOREIGN KEY(impact_id) REFERENCES intent_aware_impacts(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS impact_paths (
                impact_id TEXT,
                root_node_id TEXT,
                impacted_node_id TEXT,
                adr_id TEXT,
                intent_id TEXT,
                path_length INTEGER,
                FOREIGN KEY(impact_id) REFERENCES intent_aware_impacts(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS governance_evidence (
                impact_id TEXT,
                evidence_type TEXT,
                source_id TEXT,
                target_id TEXT,
                FOREIGN KEY(impact_id) REFERENCES intent_aware_impacts(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_impacts_root ON intent_aware_impacts(root_node_id);
            CREATE INDEX IF NOT EXISTS idx_impacts_version ON intent_aware_impacts(governance_snapshot_version);
            
            CREATE UNIQUE INDEX IF NOT EXISTS idx_uniq_impact_version ON intent_aware_impacts(root_node_id, governance_snapshot_version);
            
            CREATE INDEX IF NOT EXISTS idx_impact_nodes_impact ON impact_nodes(impact_id);
            CREATE INDEX IF NOT EXISTS idx_impact_adrs_impact ON impact_adrs(impact_id);
            CREATE INDEX IF NOT EXISTS idx_impact_intents_impact ON impact_intents(impact_id);
            CREATE INDEX IF NOT EXISTS idx_paths_impact ON impact_paths(impact_id);
            CREATE INDEX IF NOT EXISTS idx_evidence_impact ON governance_evidence(impact_id);
        `);
    }

    public saveImpact(
        impact: IntentAwareImpact,
        paths: IntentImpactPath[],
        evidence: GovernanceEvidence[]
    ) {
        const tx = executeTransaction(this.db, () => {
            // Upsert the main impact record for idempotency
            this.db.prepare(`
                INSERT INTO intent_aware_impacts (
                    id, root_node_id, governance_snapshot_version, governance_score, governance_severity, generated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(root_node_id, governance_snapshot_version) DO UPDATE SET
                    id=excluded.id,
                    governance_score=excluded.governance_score,
                    governance_severity=excluded.governance_severity,
                    generated_at=excluded.generated_at
            `).run(
                impact.id, impact.rootNodeId, impact.governanceSnapshotVersion,
                impact.governanceScore, impact.governanceSeverity, impact.generatedAt.toISOString()
            );

            // Clean up old relational records for this impact (if overwriting due to conflict)
            this.db.prepare(`DELETE FROM impact_nodes WHERE impact_id = ?`).run(impact.id);
            this.db.prepare(`DELETE FROM impact_adrs WHERE impact_id = ?`).run(impact.id);
            this.db.prepare(`DELETE FROM impact_intents WHERE impact_id = ?`).run(impact.id);
            this.db.prepare(`DELETE FROM impact_paths WHERE impact_id = ?`).run(impact.id);
            this.db.prepare(`DELETE FROM governance_evidence WHERE impact_id = ?`).run(impact.id);

            // Insert related data
            const insertNode = this.db.prepare(`INSERT INTO impact_nodes (impact_id, node_id) VALUES (?, ?)`);
            for (const n of impact.impactedNodeIds) insertNode.run(impact.id, n);

            const insertADR = this.db.prepare(`INSERT INTO impact_adrs (impact_id, adr_id) VALUES (?, ?)`);
            for (const a of impact.impactedADRIds) insertADR.run(impact.id, a);

            const insertIntent = this.db.prepare(`INSERT INTO impact_intents (impact_id, intent_id, is_neighbor) VALUES (?, ?, ?)`);
            for (const i of impact.impactedIntentIds) insertIntent.run(impact.id, i, 0);
            for (const i of impact.impactedNeighborIntentIds) insertIntent.run(impact.id, i, 1);

            const insertPath = this.db.prepare(`
                INSERT INTO impact_paths (impact_id, root_node_id, impacted_node_id, adr_id, intent_id, path_length)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            for (const p of paths) {
                insertPath.run(p.impactId, p.rootNodeId, p.impactedNodeId, p.adrId, p.intentId, p.pathLength);
            }

            const insertEv = this.db.prepare(`
                INSERT INTO governance_evidence (impact_id, evidence_type, source_id, target_id)
                VALUES (?, ?, ?, ?)
            `);
            for (const e of evidence) {
                insertEv.run(e.impactId, e.evidenceType, e.sourceId, e.targetId);
            }
        });
        tx();
    }

    public getImpact(rootNodeId: string, snapshotVersion: string): IntentAwareImpact | null {
        const row = this.db.prepare(`
            SELECT * FROM intent_aware_impacts 
            WHERE root_node_id = ? AND governance_snapshot_version = ?
        `).get(rootNodeId, snapshotVersion) as any;

        if (!row) return null;

        const impactId = row.id;

        const impactedNodeIds = (this.db.prepare(`SELECT node_id FROM impact_nodes WHERE impact_id = ?`).all(impactId) as any[]).map(r => r.node_id);
        const impactedADRIds = (this.db.prepare(`SELECT adr_id FROM impact_adrs WHERE impact_id = ?`).all(impactId) as any[]).map(r => r.adr_id);
        
        const intentRows = this.db.prepare(`SELECT intent_id, is_neighbor FROM impact_intents WHERE impact_id = ?`).all(impactId) as any[];
        const impactedIntentIds = intentRows.filter(r => r.is_neighbor === 0).map(r => r.intent_id);
        const impactedNeighborIntentIds = intentRows.filter(r => r.is_neighbor === 1).map(r => r.intent_id);

        return {
            id: impactId,
            rootNodeId: row.root_node_id,
            governanceSnapshotVersion: row.governance_snapshot_version,
            impactedNodeIds,
            impactedADRIds,
            impactedIntentIds,
            impactedNeighborIntentIds,
            governanceScore: row.governance_score,
            governanceSeverity: row.governance_severity,
            generatedAt: new Date(row.generated_at)
        };
    }
}
