import { DatabaseSync } from 'node:sqlite';
import { KnowledgeValidity, ValidityEvidence, ValidityHistory } from './knowledgeValidityTypes';

export class KnowledgeValidityQueryEngine {
    constructor(private db: DatabaseSync) {}

    public getValidity(entityId: string): KnowledgeValidity | null {
        const row = this.db.prepare(`
            SELECT * FROM knowledge_validity WHERE entity_id = ?
        `).get(entityId) as any;
        if (!row) return null;
        return this.mapValidity(row);
    }

    public getLowestValidity(): KnowledgeValidity[] {
        const rows = this.db.prepare(`
            SELECT * FROM knowledge_validity ORDER BY validity_score ASC LIMIT 10
        `).all() as any[];
        return rows.map(r => this.mapValidity(r));
    }

    public getMostTrustedKnowledge(): KnowledgeValidity[] {
        const rows = this.db.prepare(`
            SELECT * FROM knowledge_validity 
            WHERE validity_score >= 90 AND confidence_score >= 75
            ORDER BY validity_score DESC, confidence_score DESC 
            LIMIT 10
        `).all() as any[];
        return rows.map(r => this.mapValidity(r));
    }

    public getStaleKnowledge(): KnowledgeValidity[] {
        const rows = this.db.prepare(`
            SELECT v.* 
            FROM knowledge_validity v
            JOIN validity_evidence e ON v.id = e.validity_id
            WHERE e.evidence_type = 'EXPERT' AND e.evidence_id = 'STALE'
        `).all() as any[];
        // Filter out duplicates if multiple stale evidence exists
        const unique = new Map<string, any>();
        rows.forEach(r => unique.set(r.id, r));
        return Array.from(unique.values()).map(r => this.mapValidity(r));
    }

    public getValidityHistory(entityId: string): ValidityHistory[] {
        const rows = this.db.prepare(`
            SELECT h.* 
            FROM validity_history h
            JOIN knowledge_validity v ON h.validity_id = v.id
            WHERE v.entity_id = ?
            ORDER BY h.snapshot_date ASC
        `).all(entityId) as any[];
        return rows.map(r => ({
            validityId: r.validity_id,
            snapshotDate: new Date(r.snapshot_date),
            validityScore: r.validity_score,
            confidenceScore: r.confidence_score
        }));
    }

    public getEvidence(validityId: string): ValidityEvidence[] {
        const rows = this.db.prepare(`
            SELECT * FROM validity_evidence WHERE validity_id = ?
        `).all(validityId) as any[];
        return rows.map(r => ({
            validityId: r.validity_id,
            evidenceType: r.evidence_type,
            evidenceId: r.evidence_id,
            evidenceText: r.evidence_text
        }));
    }

    private mapValidity(row: any): KnowledgeValidity {
        return {
            id: row.id,
            entityType: row.entity_type,
            entityId: row.entity_id,
            validityScore: row.validity_score,
            validityTier: row.validity_tier,
            confidenceScore: row.confidence_score,
            trend: row.trend,
            lastValidatedAt: new Date(row.last_validated_at),
            evidenceCount: row.evidence_count
        };
    }
}
