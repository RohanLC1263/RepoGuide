import { DatabaseSync } from 'node:sqlite';
import { EvolutionEntity, EvolutionEvent, EvolutionEvidence, EvolutionTimeline } from './evolutionTypes';

export class EvolutionQueryEngine {
    constructor(private db: DatabaseSync) {}

    public getTimeline(entityId: string): EvolutionTimeline {
        const rows = this.db.prepare(`
            SELECT * FROM evolution_snapshots 
            WHERE entity_id = ? 
            ORDER BY snapshot_date ASC
        `).all(entityId) as any[];

        return {
            entityId,
            snapshots: rows.map(r => ({
                entityId: r.entity_id,
                snapshotDate: new Date(r.snapshot_date),
                healthScore: r.health_score,
                validityScore: r.validity_score,
                hotspotScore: r.hotspot_score,
                busFactor: r.bus_factor,
                nodeCount: r.node_count
            }))
        };
    }

    public getEvolutionEvents(entityId: string): EvolutionEvent[] {
        const rows = this.db.prepare(`
            SELECT * FROM evolution_events 
            WHERE entity_id = ? 
            ORDER BY timestamp DESC
        `).all(entityId) as any[];

        return rows.map(r => ({
            id: r.id,
            entityId: r.entity_id,
            timestamp: new Date(r.timestamp),
            eventType: r.event_type as any,
            oldValue: r.old_value,
            newValue: r.new_value,
            importanceScore: r.importance_score
        }));
    }

    public getMilestones(entityId: string): EvolutionEvent[] {
        const rows = this.db.prepare(`
            SELECT * FROM evolution_events 
            WHERE entity_id = ? AND event_type = 'EVOLUTION_MILESTONE'
            ORDER BY timestamp DESC
        `).all(entityId) as any[];

        return rows.map(r => ({
            id: r.id,
            entityId: r.entity_id,
            timestamp: new Date(r.timestamp),
            eventType: r.event_type as any,
            oldValue: r.old_value,
            newValue: r.new_value,
            importanceScore: r.importance_score
        }));
    }

    public getEvidence(eventId: string): EvolutionEvidence[] {
        const rows = this.db.prepare(`
            SELECT * FROM evolution_evidence WHERE event_id = ?
        `).all(eventId) as any[];
        return rows.map(r => ({
            eventId: r.event_id,
            evidenceType: r.evidence_type as any,
            evidenceId: r.evidence_id,
            evidenceText: r.evidence_text
        }));
    }

    public getFastestChangingSubsystems(): EvolutionEntity[] {
        const rows = this.db.prepare(`
            SELECT * FROM evolution_entities 
            ORDER BY evolution_velocity DESC LIMIT 10
        `).all() as any[];
        return rows.map(r => this.mapEntity(r));
    }

    public getMostStableSubsystems(): EvolutionEntity[] {
        const rows = this.db.prepare(`
            SELECT * FROM evolution_entities 
            WHERE status = 'STABLE'
            ORDER BY evolution_velocity ASC LIMIT 10
        `).all() as any[];
        return rows.map(r => this.mapEntity(r));
    }

    public getDecliningArchitectures(): EvolutionEntity[] {
        const rows = this.db.prepare(`
            SELECT * FROM evolution_entities 
            WHERE status = 'DECLINING'
            ORDER BY evolution_velocity DESC LIMIT 10
        `).all() as any[];
        return rows.map(r => this.mapEntity(r));
    }

    public getObsoleteArchitectures(): EvolutionEntity[] {
        const rows = this.db.prepare(`
            SELECT * FROM evolution_entities 
            WHERE status = 'OBSOLETE'
            ORDER BY last_seen_at DESC LIMIT 10
        `).all() as any[];
        return rows.map(r => this.mapEntity(r));
    }

    private mapEntity(row: any): EvolutionEntity {
        return {
            id: row.id,
            entityType: row.entity_type,
            entityId: row.entity_id,
            firstSeenAt: new Date(row.first_seen_at),
            lastSeenAt: new Date(row.last_seen_at),
            currentState: row.current_state,
            evolutionVelocity: row.evolution_velocity,
            changeCount: row.change_count,
            status: row.status
        };
    }
}
