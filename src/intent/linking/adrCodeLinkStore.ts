import { DatabaseSync } from 'node:sqlite';
import { ADRCodeLink, ADRCodeEvidence } from './adrCodeLinkTypes';
import { executeTransaction } from '../../store/sqliteLoader';

export class ADRCodeLinkStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS adr_code_links (
                id TEXT PRIMARY KEY,
                adr_id TEXT,
                node_id TEXT,
                relationship_type TEXT,
                confidence REAL,
                evidence_count INTEGER,
                score INTEGER
            );

            CREATE TABLE IF NOT EXISTS adr_code_evidence (
                link_id TEXT,
                adr_id TEXT,
                node_id TEXT,
                evidence_type TEXT,
                evidence TEXT,
                score_contribution INTEGER,
                FOREIGN KEY(link_id) REFERENCES adr_code_links(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_adr_links_adr ON adr_code_links(adr_id);
            CREATE INDEX IF NOT EXISTS idx_adr_links_node ON adr_code_links(node_id);
            CREATE INDEX IF NOT EXISTS idx_adr_evidence_link ON adr_code_evidence(link_id);

            -- Uniqueness constraints for idempotent rebuilds
            CREATE UNIQUE INDEX IF NOT EXISTS idx_uniq_adr_link ON adr_code_links(adr_id, node_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_uniq_adr_evidence ON adr_code_evidence(link_id, evidence_type, evidence);
        `);
    }

    public saveBatch(links: Map<string, ADRCodeLink>, evidence: ADRCodeEvidence[]) {
        const tx = executeTransaction(this.db, () => {
            // Full Rebuild: We delete existing data before writing the new bulk load
            this.db.exec(`DELETE FROM adr_code_evidence`);
            this.db.exec(`DELETE FROM adr_code_links`);

            const insertLinkStmt = this.db.prepare(`
                INSERT INTO adr_code_links (id, adr_id, node_id, relationship_type, confidence, evidence_count, score)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            for (const link of links.values()) {
                insertLinkStmt.run(
                    link.id,
                    link.adrId,
                    link.nodeId,
                    link.relationshipType,
                    link.confidence,
                    link.evidenceCount,
                    link.score
                );
            }

            const insertEvStmt = this.db.prepare(`
                INSERT INTO adr_code_evidence (link_id, adr_id, node_id, evidence_type, evidence, score_contribution)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(link_id, evidence_type, evidence) DO NOTHING
            `);

            for (const ev of evidence) {
                insertEvStmt.run(
                    ev.linkId,
                    ev.adrId,
                    ev.nodeId,
                    ev.evidenceType,
                    ev.evidence,
                    ev.scoreContribution
                );
            }
        });

        tx();
    }

    public getLinksForADR(adrId: string): ADRCodeLink[] {
        const rows = this.db.prepare(`SELECT * FROM adr_code_links WHERE adr_id = ?`).all(adrId) as any[];
        return rows.map(r => this.mapLinkRow(r));
    }

    public getLinksForNode(nodeId: string): ADRCodeLink[] {
        const rows = this.db.prepare(`SELECT * FROM adr_code_links WHERE node_id = ?`).all(nodeId) as any[];
        return rows.map(r => this.mapLinkRow(r));
    }

    public getLinksForNodes(nodeIds: string[]): ADRCodeLink[] {
        if (nodeIds.length === 0) return [];
        const placeholders = nodeIds.map(() => '?').join(',');
        const rows = this.db.prepare(`SELECT * FROM adr_code_links WHERE node_id IN (${placeholders})`).all(...nodeIds) as any[];
        return rows.map(r => this.mapLinkRow(r));
    }

    public getEvidenceForLink(linkId: string): ADRCodeEvidence[] {
        const rows = this.db.prepare(`SELECT * FROM adr_code_evidence WHERE link_id = ?`).all(linkId) as any[];
        return rows.map(r => ({
            linkId: r.link_id,
            adrId: r.adr_id,
            nodeId: r.node_id,
            evidenceType: r.evidence_type,
            evidence: r.evidence,
            scoreContribution: r.score_contribution
        }));
    }

    private mapLinkRow(row: any): ADRCodeLink {
        return {
            id: row.id,
            adrId: row.adr_id,
            nodeId: row.node_id,
            relationshipType: row.relationship_type,
            confidence: row.confidence,
            evidenceCount: row.evidence_count,
            score: row.score
        };
    }
}
