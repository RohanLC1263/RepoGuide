import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';
import { DriftRuleEngine } from './driftRuleEngine';

import { RepositoryBuilder } from '../orchestrator/orchestratorTypes';

export class DriftBuilder implements RepositoryBuilder {
    private ruleEngine: DriftRuleEngine;

    constructor(private db: DatabaseSync) {
        this.ruleEngine = new DriftRuleEngine(db);
    }

    public async build(): Promise<void> {
        const tx = executeTransaction(this.db, () => {
            // 1. Run all SQL queries to populate temp_current_findings
            this.ruleEngine.executeRules();

            const now = new Date().toISOString();

            // 1.5 Ensure entities exist to satisfy foreign keys
            this.db.exec(`
                INSERT OR IGNORE INTO drift_entities (id, entity_type, drift_score, first_detected_at, last_detected_at, resolution_state, suppressed)
                SELECT DISTINCT 
                    entity_id, 
                    CASE WHEN entity_id = 'UNGOVERNED_CLUSTER' THEN 'UNGOVERNED_CLUSTER' ELSE 'ADR' END,
                    0, '${now}', '${now}', 'ACTIVE', 0
                FROM temp_current_findings;
            `);

            // 2. Process active findings into drift_findings (UPSERT pattern for deterministic IDs)
            this.db.exec(`
                INSERT INTO drift_findings (
                    id, entity_id, drift_type, severity, adr_id, intent_id, node_id, 
                    confidence, evidence_count, first_detected_at, last_detected_at, 
                    resolution_state, suppressed
                )
                SELECT 
                    id, entity_id, drift_type, severity, adr_id, intent_id, node_id,
                    confidence, evidence_count, '${now}', '${now}', 'ACTIVE', 0
                FROM temp_current_findings
                WHERE 1=1
                ON CONFLICT(id) DO UPDATE SET
                    last_detected_at = '${now}',
                    resolution_state = 'ACTIVE',
                    resolved_at = NULL,
                    lifetime_days = NULL,
                    severity = excluded.severity,
                    confidence = excluded.confidence,
                    evidence_count = excluded.evidence_count;
            `);

            // 3. Insert fresh evidence, clearing old evidence for ACTIVE findings
            this.db.exec(`
                DELETE FROM drift_evidence 
                WHERE finding_id IN (SELECT id FROM temp_current_findings);

                INSERT INTO drift_evidence (finding_id, evidence_type, evidence_id, evidence_text)
                SELECT finding_id, evidence_type, evidence_id, evidence_text 
                FROM temp_current_evidence;
            `);

            // 4. Resolve missing findings
            this.db.exec(`
                UPDATE drift_findings
                SET resolution_state = 'RESOLVED',
                    resolved_at = '${now}',
                    lifetime_days = julianday('${now}') - julianday(first_detected_at)
                WHERE resolution_state = 'ACTIVE' 
                AND id NOT IN (SELECT id FROM temp_current_findings);
            `);

            // 5. Build DriftEntities
            // Only aggregate ACTIVE findings
            this.db.exec(`
                DELETE FROM drift_entities;

                INSERT INTO drift_entities (
                    id, entity_type, drift_score, first_detected_at, last_detected_at,
                    resolution_state, suppressed
                )
                SELECT 
                    entity_id,
                    CASE 
                        WHEN entity_id = 'UNGOVERNED_CLUSTER' THEN 'UNGOVERNED_CLUSTER'
                        ELSE 'ADR'
                    END,
                    SUM(confidence) * COUNT(id) as drift_score,
                    MIN(first_detected_at),
                    MAX(last_detected_at),
                    'ACTIVE',
                    0
                FROM drift_findings
                WHERE resolution_state = 'ACTIVE'
                GROUP BY entity_id;
            `);

            // 6. Build ArchitecturalHealth
            this.db.exec(`
                DELETE FROM architectural_health;

                INSERT INTO architectural_health (
                    entity_id, entity_type, health_score, active_findings, critical_findings, trend, calculated_at
                )
                SELECT 
                    id,
                    entity_type,
                    MAX(0.0, 100.0 - drift_score), -- Simple health score inversion
                    (SELECT COUNT(*) FROM drift_findings WHERE entity_id = e.id AND resolution_state = 'ACTIVE'),
                    (SELECT COUNT(*) FROM drift_findings WHERE entity_id = e.id AND resolution_state = 'ACTIVE' AND severity = 'CRITICAL'),
                    'STABLE', -- Baseline for V1
                    '${now}'
                FROM drift_entities e;
            `);

            // 7. Snapshot into drift_history
            const dateStr = now.split('T')[0];
            this.db.exec(`
                INSERT INTO drift_history (finding_id, snapshot_date, severity)
                SELECT 
                    f.id,
                    '${dateStr}',
                    f.severity
                FROM drift_findings f
                WHERE f.resolution_state = 'ACTIVE';
            `);
            // 3. Snapshot History
            this.db.exec(`
                INSERT INTO architectural_health_history (entity_type, entity_id, snapshot_date, health_score, active_findings, critical_findings)
                SELECT 
                    entity_type,
                    entity_id, 
                    '${now.substring(0, 10)}', 
                    health_score, 
                    active_findings, 
                    critical_findings 
                FROM architectural_health
                WHERE true
                ON CONFLICT(entity_type, entity_id, snapshot_date) DO UPDATE SET
                    health_score = excluded.health_score,
                    active_findings = excluded.active_findings,
                    critical_findings = excluded.critical_findings;
            `);
        });

        tx();
    }
}
