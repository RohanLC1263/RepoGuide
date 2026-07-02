import { DriftStore } from './driftStore';
import { 
    DriftFinding, 
    DriftEntity, 
    ArchitecturalHealth, 
    DriftEvidence, 
    DriftHistorySnapshot, 
    DriftQueryEngineApi 
} from './driftTypes';

export class DriftQueryEngine implements DriftQueryEngineApi {
    constructor(private store: DriftStore) {}

    public getFindings(): DriftFinding[] {
        const rows = this.store.getDatabase().prepare(`SELECT * FROM drift_findings WHERE resolution_state = 'ACTIVE' ORDER BY severity DESC`).all() as any[];
        return rows.map(r => this.mapFindingRow(r));
    }

    public getCriticalFindings(): DriftFinding[] {
        const rows = this.store.getDatabase().prepare(`SELECT * FROM drift_findings WHERE severity = 'CRITICAL' AND resolution_state = 'ACTIVE'`).all() as any[];
        return rows.map(r => this.mapFindingRow(r));
    }

    public getDriftForEntity(entityId: string): DriftFinding[] {
        const rows = this.store.getDatabase().prepare(`SELECT * FROM drift_findings WHERE entity_id = ? AND resolution_state = 'ACTIVE'`).all(entityId) as any[];
        return rows.map(r => this.mapFindingRow(r));
    }

    public getEntities(): DriftEntity[] {
        const rows = this.store.getDatabase().prepare(`SELECT * FROM drift_entities WHERE resolution_state = 'ACTIVE'`).all() as any[];
        return rows.map(r => ({
            id: r.id,
            entityType: r.entity_type,
            driftScore: r.drift_score,
            findings: [],
            affectedADRs: [],
            affectedIntents: [],
            firstDetectedAt: new Date(r.first_detected_at),
            lastDetectedAt: new Date(r.last_detected_at),
            healthScore: r.health_score,
            driftTrend: r.drift_trend,
            resolutionState: r.resolution_state,
            suppressed: r.suppressed === 1,
            ownerEmail: r.owner_email
        }));
    }

    public getArchitecturalHealth(entityId: string): ArchitecturalHealth | null {
        const row = this.store.getDatabase().prepare(`SELECT * FROM architectural_health WHERE entity_id = ?`).get(entityId) as any;
        if (!row) return null;
        return this.mapHealthRow(row);
    }

    public getOverallArchitecturalHealth(): ArchitecturalHealth[] {
        const rows = this.store.getDatabase().prepare(`SELECT * FROM architectural_health ORDER BY health_score ASC`).all() as any[];
        return rows.map(r => this.mapHealthRow(r));
    }

    public getEvidenceForFinding(findingId: string): DriftEvidence[] {
        const rows = this.store.getDatabase().prepare(`SELECT * FROM drift_evidence WHERE finding_id = ?`).all(findingId) as any[];
        return rows.map(r => ({
            findingId: r.finding_id,
            evidenceType: r.evidence_type,
            evidenceId: r.evidence_id,
            evidenceText: r.evidence_text
        }));
    }

    public getHistoryForFinding(findingId: string): DriftHistorySnapshot[] {
        const rows = this.store.getDatabase().prepare(`SELECT * FROM drift_history WHERE finding_id = ? ORDER BY snapshot_date ASC`).all(findingId) as any[];
        return rows.map(r => ({
            findingId: r.finding_id,
            snapshotDate: new Date(r.snapshot_date),
            severity: r.severity,
            healthScore: r.health_score
        }));
    }

    private mapFindingRow(row: any): DriftFinding {
        return {
            id: row.id,
            entityId: row.entity_id,
            driftType: row.drift_type,
            severity: row.severity,
            adrId: row.adr_id,
            intentId: row.intent_id,
            nodeId: row.node_id,
            confidence: row.confidence,
            evidenceCount: row.evidence_count,
            firstDetectedAt: new Date(row.first_detected_at),
            lastDetectedAt: new Date(row.last_detected_at),
            resolvedAt: row.resolved_at ? new Date(row.resolved_at) : undefined,
            lifetimeDays: row.lifetime_days,
            resolutionState: row.resolution_state,
            suppressed: row.suppressed === 1,
            ownerEmail: row.owner_email
        };
    }

    private mapHealthRow(row: any): ArchitecturalHealth {
        return {
            entityId: row.entity_id,
            entityType: row.entity_type,
            healthScore: row.health_score,
            activeFindings: row.active_findings,
            criticalFindings: row.critical_findings,
            trend: row.trend,
            calculatedAt: new Date(row.calculated_at)
        };
    }
}
