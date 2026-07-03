import { DatabaseSync } from 'node:sqlite';
import { IncidentEventStore } from './incidentEventStore';
import { IncidentSeverity, IncidentType } from './incidentEventTypes';
import { randomUUID } from 'crypto';

const SEVERITY_LEVELS: Record<IncidentSeverity, number> = {
    'RESOLVED': 0,
    'LOW': 1,
    'MEDIUM': 2,
    'HIGH': 3,
    'CRITICAL': 4
};

export class IncidentBuilder {
    constructor(private db: DatabaseSync, private store: IncidentEventStore) {}

    public async build(): Promise<void> {
        this.processCoverageIncidents();
        this.processHotspotIncidents();
        this.processHealthIncidents();
        this.processOutcomeIncidents();
        this.processValidityIncidents();
    }

    private emitIncident(
        entityType: string,
        entityId: string,
        incidentType: IncidentType,
        severity: IncidentSeverity,
        metric: string,
        value: string
    ) {
        const now = new Date();
        const lock = this.store.getLock(entityId, incidentType);

        if (severity === 'RESOLVED') {
            if (lock) {
                // Recovery edge
                this.store.appendEvent({
                    id: randomUUID(),
                    entity_type: entityType,
                    entity_id: entityId,
                    incident_type: incidentType,
                    severity: 'RESOLVED',
                    trigger_metric: metric,
                    trigger_value: value,
                    created_at: now
                });
                this.store.clearLock(entityId, incidentType);
            }
            return;
        }

        // Active incident
        if (lock && lock.lock_expires_at > now) {
            // Check escalation
            if (SEVERITY_LEVELS[severity] > SEVERITY_LEVELS[lock.last_severity]) {
                // Escalation Edge
                this.store.appendEvent({
                    id: randomUUID(),
                    entity_type: entityType,
                    entity_id: entityId,
                    incident_type: incidentType,
                    severity,
                    trigger_metric: metric,
                    trigger_value: value,
                    created_at: now
                });
                this.store.updateLock({
                    entity_id: entityId,
                    incident_type: incidentType,
                    last_severity: severity,
                    lock_expires_at: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
                });
            }
            // else Suppressed
        } else {
            // New degradation or cooldown expired
            this.store.appendEvent({
                id: randomUUID(),
                entity_type: entityType,
                entity_id: entityId,
                incident_type: incidentType,
                severity,
                trigger_metric: metric,
                trigger_value: value,
                created_at: now
            });
            this.store.updateLock({
                entity_id: entityId,
                incident_type: incidentType,
                last_severity: severity,
                lock_expires_at: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
            });
        }
    }

    private processCoverageIncidents() {
        const rows = this.db.prepare(`
            SELECT 
                curr.entity_id,
                curr.coverage_percent AS current_cov,
                prev.coverage_percent AS past_cov,
                (curr.coverage_percent - prev.coverage_percent) AS cov_delta
            FROM coverage_history curr
            LEFT JOIN coverage_history prev 
                ON curr.entity_id = prev.entity_id 
                AND prev.snapshot_date = (
                    SELECT MAX(snapshot_date) FROM coverage_history 
                    WHERE entity_id = curr.entity_id AND snapshot_date < curr.snapshot_date
                )
            WHERE curr.snapshot_date = (SELECT MAX(snapshot_date) FROM coverage_history)
        `).all() as any[];

        for (const row of rows) {
            const cov = row.current_cov;
            const delta = row.cov_delta || 0;

            let severity: IncidentSeverity | null = null;

            if (cov < 30) severity = 'CRITICAL';
            else if (cov < 50) severity = 'HIGH';
            else if (delta < -10) severity = 'MEDIUM';

            if (severity) {
                this.emitIncident('FILE', row.entity_id, 'COVERAGE_INCIDENT', severity, 'coverage_percent', cov.toString());
            } else if (cov > 55) {
                this.emitIncident('FILE', row.entity_id, 'COVERAGE_INCIDENT', 'RESOLVED', 'coverage_percent', cov.toString());
            }
        }
    }

    private processHotspotIncidents() {
        // hotspot_history has no entity_id column — it's keyed by hotspot_id, a foreign key to
        // knowledge_hotspots.id (format 'HOTSPOT|type|entity_id'). Join through
        // knowledge_hotspots to reach the real entity_id (same pattern already used correctly
        // in causalReasoningBuilder.ts/decisionOutcomeBuilder.ts).
        const rows = this.db.prepare(`
            SELECT
                kh.entity_id,
                curr.bus_factor AS current_bf,
                curr.hotspot_score AS current_score,
                curr.blast_radius_score AS current_blast,
                curr.coupling_score AS current_coupling
            FROM hotspot_history curr
            JOIN knowledge_hotspots kh ON kh.id = curr.hotspot_id
            WHERE curr.snapshot_date = (SELECT MAX(snapshot_date) FROM hotspot_history)
        `).all() as any[];

        for (const row of rows) {
            const bf = row.current_bf;
            const score = row.current_score;
            const blast = row.current_blast;
            const coupling = row.current_coupling;

            let severity: IncidentSeverity | null = null;

            if (bf === 1) {
                const criticality = (blast * 0.6) + (coupling * 0.4);
                if (criticality >= 80) severity = 'CRITICAL';
                else if (criticality >= 60) severity = 'HIGH';
                else if (criticality >= 30) severity = 'MEDIUM';
                else severity = 'LOW';
            } else {
                if (score > 90) severity = 'HIGH';
                else if (score > 70) severity = 'MEDIUM';
            }

            if (severity) {
                this.emitIncident('FILE', row.entity_id, 'HOTSPOT_INCIDENT', severity, 'bus_factor_criticality', bf.toString());
            } else if (bf >= 2 && score <= 70) {
                this.emitIncident('FILE', row.entity_id, 'HOTSPOT_INCIDENT', 'RESOLVED', 'bus_factor_criticality', bf.toString());
            }
        }
    }

    private processHealthIncidents() {
        const rows = this.db.prepare(`
            SELECT 
                curr.entity_id,
                curr.health_score AS current_health,
                prev.health_score AS past_health,
                (curr.health_score - prev.health_score) AS health_delta
            FROM architectural_health_history curr
            LEFT JOIN architectural_health_history prev 
                ON curr.entity_id = prev.entity_id 
                AND prev.snapshot_date = (
                    SELECT MAX(snapshot_date) FROM architectural_health_history 
                    WHERE entity_id = curr.entity_id AND snapshot_date < curr.snapshot_date
                )
            WHERE curr.snapshot_date = (SELECT MAX(snapshot_date) FROM architectural_health_history)
        `).all() as any[];

        for (const row of rows) {
            const health = row.current_health;
            const delta = row.health_delta || 0;

            let severity: IncidentSeverity | null = null;

            if (health < 40) severity = 'CRITICAL';
            else if (delta < -25) severity = 'HIGH';
            else if (delta < -15) severity = 'MEDIUM';

            if (severity) {
                this.emitIncident('MODULE', row.entity_id, 'HEALTH_INCIDENT', severity, 'health_score', health.toString());
            } else if (health > 80) {
                this.emitIncident('MODULE', row.entity_id, 'HEALTH_INCIDENT', 'RESOLVED', 'health_score', health.toString());
            }
        }
    }

    private processOutcomeIncidents() {
        // decision_outcomes has no adr_id column — its primary key is entity_type/entity_id.
        // This method is ADR-scoped (emitIncident always passes entity_type='ADR' below), so
        // filter to entity_type = 'ADR' rather than assuming all rows are ADRs.
        const rows = this.db.prepare(`
            SELECT entity_id, outcome_type
            FROM decision_outcomes
            WHERE entity_type = 'ADR'
        `).all() as any[];

        for (const row of rows) {
            const outcome = row.outcome_type;

            if (outcome === 'FAILED') {
                this.emitIncident('ADR', row.entity_id, 'OUTCOME_INCIDENT', 'CRITICAL', 'outcome_type', outcome);
            } else if (outcome === 'DEGRADED') {
                this.emitIncident('ADR', row.entity_id, 'OUTCOME_INCIDENT', 'MEDIUM', 'outcome_type', outcome);
            } else if (outcome === 'SUCCESSFUL') {
                this.emitIncident('ADR', row.entity_id, 'OUTCOME_INCIDENT', 'RESOLVED', 'outcome_type', outcome);
            }
        }
    }

    private processValidityIncidents() {
        // validity_history has no entity_id column — it's keyed by validity_id, a foreign key
        // to knowledge_validity.id. Join through knowledge_validity to reach entity_id (same
        // pattern already used correctly in knowledgeValidityQueryEngine.ts).
        const rows = this.db.prepare(`
            SELECT
                kv.entity_id,
                curr.validity_score AS current_val
            FROM validity_history curr
            JOIN knowledge_validity kv ON kv.id = curr.validity_id
            WHERE curr.snapshot_date = (SELECT MAX(snapshot_date) FROM validity_history)
        `).all() as any[];

        for (const row of rows) {
            const val = row.current_val;

            if (val < 40) {
                this.emitIncident('MODULE', row.entity_id, 'VALIDITY_INCIDENT', 'HIGH', 'validity_score', val.toString());
            } else if (val < 60) {
                this.emitIncident('MODULE', row.entity_id, 'VALIDITY_INCIDENT', 'MEDIUM', 'validity_score', val.toString());
            } else if (val > 80) {
                this.emitIncident('MODULE', row.entity_id, 'VALIDITY_INCIDENT', 'RESOLVED', 'validity_score', val.toString());
            }
        }
    }
}
