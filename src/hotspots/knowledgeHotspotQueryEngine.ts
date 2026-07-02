import { KnowledgeHotspotStore } from './knowledgeHotspotStore';
import { KnowledgeHotspot, HotspotEvidence, HotspotHistorySnapshot, KnowledgeHotspotQueryEngineApi } from './knowledgeHotspotTypes';

export class KnowledgeHotspotQueryEngine implements KnowledgeHotspotQueryEngineApi {
    constructor(private store: KnowledgeHotspotStore) {}

    private mapHotspotRow(row: any): KnowledgeHotspot {
        return {
            id: row.id,
            entityType: row.entity_type,
            entityId: row.entity_id,
            hotspotScore: row.hotspot_score,
            severity: row.severity,
            busFactor: row.bus_factor,
            expertCount: row.expert_count,
            knowledgeConcentrationScore: row.knowledge_concentration_score,
            healthScore: row.health_score,
            blastRadiusScore: row.blast_radius_score,
            couplingScore: row.coupling_score
        };
    }

    public getHotspots(): KnowledgeHotspot[] {
        const rows = this.store.getDatabase().prepare(`SELECT * FROM knowledge_hotspots ORDER BY hotspot_score DESC LIMIT 10`).all() as any[];
        return rows.map(r => this.mapHotspotRow(r));
    }

    public getCriticalHotspots(): KnowledgeHotspot[] {
        const rows = this.store.getDatabase().prepare(`SELECT * FROM knowledge_hotspots WHERE severity = 'CRITICAL' ORDER BY hotspot_score DESC LIMIT 10`).all() as any[];
        return rows.map(r => this.mapHotspotRow(r));
    }

    public getHotspot(entityId: string): KnowledgeHotspot | null {
        const row = this.store.getDatabase().prepare(`SELECT * FROM knowledge_hotspots WHERE entity_id = ?`).get(entityId) as any;
        return row ? this.mapHotspotRow(row) : null;
    }

    public getMostRiskySubsystems(): KnowledgeHotspot[] {
        return this.getHotspots().slice(0, 10);
    }

    public getBusFactorRisks(): KnowledgeHotspot[] {
        const rows = this.store.getDatabase().prepare(`
            SELECT * FROM knowledge_hotspots 
            WHERE bus_factor <= 1 
            ORDER BY hotspot_score DESC
            LIMIT 10
        `).all() as any[];
        return rows.map(r => this.mapHotspotRow(r));
    }

    public getEvidence(hotspotId: string): HotspotEvidence[] {
        const rows = this.store.getDatabase().prepare(`SELECT * FROM hotspot_evidence WHERE hotspot_id = ?`).all(hotspotId) as any[];
        return rows.map(r => ({
            hotspotId: r.hotspot_id,
            evidenceType: r.evidence_type,
            evidenceId: r.evidence_id,
            evidenceText: r.evidence_text
        }));
    }

    public getHistory(hotspotId: string): HotspotHistorySnapshot[] {
        const rows = this.store.getDatabase().prepare(`SELECT * FROM hotspot_history WHERE hotspot_id = ? ORDER BY snapshot_date ASC`).all(hotspotId) as any[];
        return rows.map(r => ({
            hotspotId: r.hotspot_id,
            snapshotDate: new Date(r.snapshot_date),
            severity: r.severity,
            hotspotScore: r.hotspot_score
        }));
    }
}
