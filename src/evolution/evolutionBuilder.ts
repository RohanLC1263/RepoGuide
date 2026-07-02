import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EvolutionStore } from './evolutionStore';
import { 
    EvolutionEntity, EvolutionEvent, EvolutionEvidence, EvolutionSnapshot, 
    EvolutionStatus, EvolutionEventType 
} from './evolutionTypes';

import { RepositoryBuilder } from '../orchestrator/orchestratorTypes';

export class EvolutionBuilder implements RepositoryBuilder {
    constructor(
        private db: DatabaseSync,
        private store: EvolutionStore
    ) {}

    public async build(): Promise<void> {
        const adrs = this.db.prepare(`SELECT id FROM adrs`).all() as any[];
        for (const adr of adrs) {
            this.buildForADR(adr.id);
        }
    }



    public buildForADR(adrId: string): EvolutionEntity {
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];

        // 1. Fetch Current State
        const healthRow = this.db.prepare(`SELECT health_score FROM architectural_health WHERE entity_id = ?`).get(adrId) as any;
        const validityRow = this.db.prepare(`SELECT validity_score FROM knowledge_validity WHERE entity_id = ?`).get(adrId) as any;
        const hotspotRow = this.db.prepare(`SELECT hotspot_score, bus_factor, severity FROM knowledge_hotspots WHERE entity_id = ?`).get(adrId) as any;
        const filesRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM adr_code_links WHERE adr_id = ?`).get(adrId) as any;

        const currentHealth = healthRow?.health_score ?? 100;
        const currentValidity = validityRow?.validity_score ?? 100;
        const currentHotspot = hotspotRow?.hotspot_score ?? 0;
        const currentBusFactor = hotspotRow?.bus_factor ?? 99;
        const currentNodeCount = filesRow?.cnt ?? 0;

        // 2. Fetch Latest Snapshot
        const latestSnapshot = this.store.getLatestSnapshot(adrId);

        let entity = this.store.getEntity(adrId);
        let isNew = false;
        if (!entity) {
            isNew = true;
            entity = {
                id: `EVO-${adrId}`,
                entityType: 'ADR',
                entityId: adrId,
                firstSeenAt: now,
                lastSeenAt: now,
                currentState: '',
                evolutionVelocity: 0,
                changeCount: 0,
                status: 'EMERGING'
            };
        } else {
            entity.lastSeenAt = now;
        }

        const eventsToSave: { event: EvolutionEvent, evidence: EvolutionEvidence[] }[] = [];

        const pushEvent = (type: EvolutionEventType, oldV: string, newV: string, importance: number, evType: any, evId: string, evText: string) => {
            // Deterministic hash based on entityId + type + date + evType to prevent duplicates on same day runs
            const eventId = `EV-${adrId}-${type}-${evType}-${dateStr}`;
            eventsToSave.push({
                event: {
                    id: eventId,
                    entityId: adrId,
                    timestamp: now,
                    eventType: type,
                    oldValue: oldV,
                    newValue: newV,
                    importanceScore: importance
                },
                evidence: [{ eventId, evidenceType: evType, evidenceId: evId, evidenceText: evText }]
            });
            entity!.changeCount++;
        };

        if (isNew) {
            pushEvent('CREATED', '', 'CREATED', 10, 'ADR', adrId, 'Entity first seen by Evolution Engine');
        } else if (latestSnapshot) {
            // Check deltas
            const hDelta = currentHealth - latestSnapshot.healthScore;
            if (Math.abs(hDelta) > 5) {
                pushEvent('HEALTH_CHANGED', latestSnapshot.healthScore.toString(), currentHealth.toString(), 40, 'HEALTH', adrId, `Health changed by ${hDelta.toFixed(1)} points`);
                if (latestSnapshot.healthScore >= 80 && currentHealth < 80) {
                    pushEvent('EVOLUTION_MILESTONE', 'HEALTHY', 'DEGRADED', 90, 'HEALTH', adrId, 'Health dropped below 80');
                }
            }

            const vDelta = currentValidity - latestSnapshot.validityScore;
            if (Math.abs(vDelta) > 5) {
                pushEvent('VALIDITY_CHANGED', latestSnapshot.validityScore.toString(), currentValidity.toString(), 60, 'VALIDITY', adrId, `Validity changed by ${vDelta.toFixed(1)} points`);
                if (latestSnapshot.validityScore >= 50 && currentValidity < 50) {
                    pushEvent('EVOLUTION_MILESTONE', 'TRUSTED', 'UNTRUSTED', 90, 'VALIDITY', adrId, 'Validity dropped below 50');
                }
            }

            if (currentBusFactor !== latestSnapshot.busFactor) {
                pushEvent('RISK_CHANGED', latestSnapshot.busFactor.toString(), currentBusFactor.toString(), 50, 'HOTSPOT', adrId, `Bus Factor changed to ${currentBusFactor}`);
                if (latestSnapshot.busFactor > 1 && currentBusFactor === 1) {
                    pushEvent('EVOLUTION_MILESTONE', 'SAFE', 'SILOED', 90, 'HOTSPOT', adrId, 'Bus factor dropped to 1');
                }
            }

            const nDelta = currentNodeCount - latestSnapshot.nodeCount;
            if (nDelta > 0) {
                pushEvent('EXPANDED', latestSnapshot.nodeCount.toString(), currentNodeCount.toString(), 10, 'ADR', adrId, `Scope expanded by ${nDelta} files`);
            } else if (nDelta < 0) {
                pushEvent('CONTRACTED', latestSnapshot.nodeCount.toString(), currentNodeCount.toString(), 10, 'ADR', adrId, `Scope contracted by ${Math.abs(nDelta)} files`);
            }
        }

        // Save events
        for (const e of eventsToSave) {
            this.store.saveEvent(e.event, e.evidence);
        }

        // Save snapshot
        const newSnapshot: EvolutionSnapshot = {
            entityId: adrId,
            snapshotDate: now,
            healthScore: currentHealth,
            validityScore: currentValidity,
            hotspotScore: currentHotspot,
            busFactor: currentBusFactor,
            nodeCount: currentNodeCount
        };
        this.store.saveSnapshot(newSnapshot);

        // Calculate Velocity & Status
        const msPerDay = 1000 * 60 * 60 * 24;
        const daysActive = Math.max(1, (now.getTime() - entity.firstSeenAt.getTime()) / msPerDay);
        
        // Sum importance of all events
        const rows = this.db.prepare(`SELECT SUM(importance_score) as tot FROM evolution_events WHERE entity_id = ?`).get(adrId) as any;
        const totalImportance = rows?.tot ?? 0;
        
        // Size Normalized Velocity
        const sizeFactor = Math.log10(Math.max(10, currentNodeCount));
        // Importance is roughly 10 to 90. Normalize it slightly so velocity is usually 0.1 to 2.0
        entity.evolutionVelocity = (totalImportance / 100) / (daysActive * sizeFactor);

        let status: EvolutionStatus = 'ACTIVE';
        if (daysActive < 30) status = 'EMERGING';
        else if (currentValidity < 25 || currentBusFactor === 0) status = 'OBSOLETE';
        else if (entity.evolutionVelocity < 0.2 && currentHealth > 80) status = 'STABLE';
        else {
            // Check trend
            const healthRow = this.db.prepare(`SELECT trend FROM architectural_health WHERE entity_id = ?`).get(adrId) as any;
            const valRow = this.db.prepare(`SELECT trend FROM knowledge_validity WHERE entity_id = ?`).get(adrId) as any;
            if (healthRow?.trend === 'DEGRADING' || valRow?.trend === 'DEGRADING') {
                status = 'DECLINING';
            }
        }

        if (entity.status !== status && !isNew) {
            const evId = `EV-${adrId}-MILE-${dateStr}`;
            this.store.saveEvent({
                id: evId,
                entityId: adrId,
                timestamp: now,
                eventType: 'EVOLUTION_MILESTONE',
                oldValue: entity.status,
                newValue: status,
                importanceScore: 90
            }, [{
                eventId: evId, evidenceType: 'ADR', evidenceId: adrId, evidenceText: `Lifecycle changed to ${status}`
            }]);
        }

        entity.status = status;
        this.store.saveEntity(entity);

        return entity;
    }
}
