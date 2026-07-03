import { DatabaseSync } from 'node:sqlite';
import { IncidentIntelligenceStore } from './incidentIntelligenceStore';
import { RepositoryBrain } from '../query/repositoryBrain';

export class IncidentIntelligenceBuilder {
    constructor(private db: DatabaseSync, private store: IncidentIntelligenceStore, private repositoryBrain?: RepositoryBrain) {}

    public async build(): Promise<void> {
        this.store.clear();
        this.reconstructFactors();
        this.minePatterns();
        // Observe patterns before computing predictions: predictions read additional upstream
        // tables (decision_outcomes, hotspot_history, etc.) and can fail independently of
        // pattern mining. Patterns already mined should still reach RepositoryBrain even if
        // prediction computation fails.
        await this.observePatterns();
        this.computePredictions();
    }

    private async observePatterns(): Promise<void> {
        if (!this.repositoryBrain) return;
        const patterns = this.db.prepare(`SELECT * FROM incident_patterns`).all() as any[];
        for (const pattern of patterns) {
            await this.repositoryBrain.observe({
                type: 'incident_pattern',
                subject: { kind: 'repository', id: `incident_pattern:${pattern.pattern_id}` },
                claim: {
                    text: `Incident pattern for ${pattern.incident_type}: factors [${pattern.factor_pattern}] observed in ${pattern.frequency} incident(s).`,
                    data: { incidentType: pattern.incident_type, factorPattern: pattern.factor_pattern, frequency: pattern.frequency }
                },
                confidence: { score: pattern.confidence, breakdown: { frequency: pattern.frequency } },
                provenance: {
                    sourceArtifacts: [`incident_patterns:${pattern.pattern_id}`],
                    producedBy: 'incidentIntelligenceBuilder'
                },
                supportingEvidence: [{ sourceTable: 'incident_patterns', sourceId: pattern.pattern_id, description: `${pattern.incident_type} x${pattern.frequency}` }],
                createdBy: 'incidentIntelligenceBuilder'
            });
        }
    }

    private reconstructFactors() {
        // Find coverage factors (if an entity had coverage < 50 in the 30 days prior to the incident)
        this.db.exec(`
            INSERT INTO incident_factors (factor_id, incident_id, factor_type, contribution_score)
            SELECT 
                hex(randomblob(16)), i.id, 'COVERAGE_DEGRADATION', 80
            FROM incident_events i
            JOIN coverage_history c ON c.entity_id = i.entity_id
            WHERE c.snapshot_date >= datetime(i.created_at, '-30 days') 
              AND c.snapshot_date <= i.created_at
              AND c.coverage_percent < 50
              AND i.severity != 'RESOLVED'
            GROUP BY i.id;
        `);

        // Find hotspot factors
        this.db.exec(`
            INSERT INTO incident_factors (factor_id, incident_id, factor_type, contribution_score)
            SELECT 
                hex(randomblob(16)), i.id, 'BUS_FACTOR_RISK', 90
            FROM incident_events i
            JOIN hotspot_history h ON h.entity_id = i.entity_id
            WHERE h.snapshot_date >= datetime(i.created_at, '-30 days') 
              AND h.snapshot_date <= i.created_at
              AND h.bus_factor = 1
              AND i.severity != 'RESOLVED'
            GROUP BY i.id;
        `);

        // Find health factors
        this.db.exec(`
            INSERT INTO incident_factors (factor_id, incident_id, factor_type, contribution_score)
            SELECT 
                hex(randomblob(16)), i.id, 'ARCHITECTURAL_DECAY', 70
            FROM incident_events i
            JOIN architectural_health_history h ON h.entity_id = i.entity_id
            WHERE h.snapshot_date >= datetime(i.created_at, '-30 days') 
              AND h.snapshot_date <= i.created_at
              AND h.health_score < 50
              AND i.severity != 'RESOLVED'
            GROUP BY i.id;
        `);

        // Check if Runtime Intelligence tables exist (Rollback validation support)
        const runtimeExists = this.db.prepare(`
            SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_health_history'
        `).get();

        if (runtimeExists) {
            this.db.exec(`
                INSERT INTO incident_factors (factor_id, incident_id, factor_type, contribution_score)
                SELECT 
                    hex(randomblob(16)), i.id, 'RUNTIME_DEGRADATION', 60
                FROM incident_events i
                JOIN runtime_repository_mappings m ON m.entity_id = i.entity_id
                JOIN runtime_health_history h ON h.component_id = m.component_id
                WHERE h.computed_at >= datetime(i.created_at, '-30 days') 
                  AND h.computed_at <= i.created_at
                  AND h.status = 'DEGRADED'
                  AND i.severity != 'RESOLVED'
                GROUP BY i.id;

                INSERT INTO incident_factors (factor_id, incident_id, factor_type, contribution_score)
                SELECT 
                    hex(randomblob(16)), i.id, 'RUNTIME_CRITICAL', 95
                FROM incident_events i
                JOIN runtime_repository_mappings m ON m.entity_id = i.entity_id
                JOIN runtime_health_history h ON h.component_id = m.component_id
                WHERE h.computed_at >= datetime(i.created_at, '-30 days') 
                  AND h.computed_at <= i.created_at
                  AND h.status = 'CRITICAL'
                  AND i.severity != 'RESOLVED'
                GROUP BY i.id;

                INSERT INTO incident_factors (factor_id, incident_id, factor_type, contribution_score)
                SELECT 
                    hex(randomblob(16)), i.id, 'RECURRING_RUNTIME_PATTERN', 85
                FROM incident_events i
                JOIN runtime_repository_mappings m ON m.entity_id = i.entity_id
                JOIN runtime_patterns p ON p.component_id = m.component_id
                WHERE p.discovered_at >= datetime(i.created_at, '-30 days') 
                  AND p.discovered_at <= i.created_at
                  AND p.status = 'ACTIVE'
                  AND i.severity != 'RESOLVED'
                GROUP BY i.id;
            `);
        }
    }

    private minePatterns() {
        // Mine patterns via GROUP_CONCAT of factors
        this.db.exec(`
            INSERT INTO incident_patterns (pattern_id, incident_type, factor_pattern, frequency, confidence)
            SELECT 
                hex(randomblob(16)),
                incident_type,
                factor_pattern,
                COUNT(DISTINCT incident_id) as frequency,
                MIN(100, COUNT(DISTINCT incident_id) * 10) as confidence
            FROM (
                SELECT i.id as incident_id, i.incident_type, GROUP_CONCAT(f.factor_type) as factor_pattern
                FROM incident_events i
                JOIN (
                    SELECT incident_id, factor_type 
                    FROM incident_factors 
                    ORDER BY factor_type -- enforce deterministic ordering
                ) f ON f.incident_id = i.id
                WHERE i.severity != 'RESOLVED'
                GROUP BY i.id, i.incident_type
            )
            GROUP BY incident_type, factor_pattern
            HAVING frequency >= 2;
        `);
    }

    private computePredictions() {
        this.db.exec(`
            CREATE TEMP TABLE active_entities AS
            SELECT DISTINCT entity_id, 'FILE' as entity_type FROM coverage_history
            UNION
            SELECT DISTINCT entity_id, 'FILE' as entity_type FROM hotspot_history
            UNION
            SELECT DISTINCT entity_id, 'MODULE' as entity_type FROM architectural_health_history
            UNION
            SELECT DISTINCT adr_id as entity_id, 'ADR' as entity_type FROM decision_outcomes;
        `);

        const runtimeExists = this.db.prepare(`
            SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_health_history'
        `).get();

        if (runtimeExists) {
            this.db.exec(`
                INSERT INTO active_entities (entity_id, entity_type)
                SELECT DISTINCT entity_id, entity_type FROM runtime_repository_mappings
                WHERE entity_id NOT IN (SELECT entity_id FROM active_entities);
            `);
        }

        const rows = this.db.prepare(`
            SELECT 
                e.entity_id, 
                e.entity_type,
                COALESCE(c.coverage_percent, 100) as cov,
                COALESCE(h.bus_factor, 10) as bf,
                COALESCE(h.hotspot_score, 0) as hs,
                COALESCE(h.blast_radius_score, 0) as blast,
                COALESCE(h.coupling_score, 0) as coupling,
                COALESCE(ah.health_score, 100) as health,
                COALESCE(o.outcome_type, 'SUCCESSFUL') as outcome,
                COALESCE(v.validity_score, 100) as validity
            FROM active_entities e
            LEFT JOIN coverage_history c ON c.entity_id = e.entity_id AND c.snapshot_date = (SELECT MAX(snapshot_date) FROM coverage_history)
            LEFT JOIN hotspot_history h ON h.entity_id = e.entity_id AND h.snapshot_date = (SELECT MAX(snapshot_date) FROM hotspot_history)
            LEFT JOIN architectural_health_history ah ON ah.entity_id = e.entity_id AND ah.snapshot_date = (SELECT MAX(snapshot_date) FROM architectural_health_history)
            LEFT JOIN decision_outcomes o ON o.adr_id = e.entity_id
            LEFT JOIN validity_history v ON v.entity_id = e.entity_id AND v.snapshot_date = (SELECT MAX(snapshot_date) FROM validity_history)
        `).all() as any[];

        let runtimeHealthMap = new Map<string, number>();
        if (runtimeExists) {
            const rtRows = this.db.prepare(`
                SELECT m.entity_id, rh.health_score
                FROM runtime_repository_mappings m
                JOIN runtime_health_history rh ON rh.component_id = m.component_id
                WHERE rh.computed_at = (SELECT MAX(computed_at) FROM runtime_health_history WHERE component_id = m.component_id)
            `).all() as any[];
            for (const r of rtRows) {
                runtimeHealthMap.set(r.entity_id, r.health_score);
            }
        }

        const stmt = this.db.prepare(`
            INSERT INTO incident_predictions (entity_id, entity_type, risk_score, severity, confidence, primary_risk_driver)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        for (const row of rows) {
            let covR = 0.0;
            if (row.cov < 30) covR = 1.0;
            else if (row.cov < 80) covR = (80 - row.cov) / 50.0;

            let hotR = 0.0;
            if (row.bf === 1) {
                const crit = (row.blast * 0.6) + (row.coupling * 0.4);
                hotR = Math.min(1.0, crit / 100.0);
            } else {
                hotR = Math.min(1.0, row.hs / 100.0);
            }

            let healthR = 0.0;
            if (row.health < 40) healthR = 1.0;
            else if (row.health < 90) healthR = (90 - row.health) / 50.0;

            let outR = 0.0;
            if (row.outcome === 'FAILED') outR = 1.0;
            else if (row.outcome === 'DEGRADED') outR = 0.5;

            let valR = 0.0;
            if (row.validity < 40) valR = 1.0;
            else if (row.validity < 80) valR = (80 - row.validity) / 40.0;

            let rtR = 0.0;
            if (runtimeExists && runtimeHealthMap.has(row.entity_id)) {
                const rhScore = runtimeHealthMap.get(row.entity_id)!;
                rtR = (100.0 - rhScore) / 100.0;
            }

            const totalRisk = 1.0 - ((1.0 - covR) * (1.0 - hotR) * (1.0 - healthR) * (1.0 - outR) * (1.0 - valR) * (1.0 - rtR));
            const riskScore = totalRisk * 100.0;

            if (riskScore > 0) {
                let severity = 'LOW';
                if (riskScore >= 90) severity = 'CRITICAL';
                else if (riskScore >= 70) severity = 'HIGH';
                else if (riskScore >= 40) severity = 'MEDIUM';

                let primary = 'COVERAGE';
                let maxR = covR;
                if (hotR > maxR) { maxR = hotR; primary = 'HOTSPOT'; }
                if (healthR > maxR) { maxR = healthR; primary = 'HEALTH'; }
                if (outR > maxR) { maxR = outR; primary = 'OUTCOME'; }
                if (valR > maxR) { maxR = valR; primary = 'VALIDITY'; }
                if (rtR > maxR) { maxR = rtR; primary = 'RUNTIME'; }

                const confidence = Math.min(100, Math.floor((maxR + (totalRisk / 2)) * 50) + 30);

                stmt.run(row.entity_id, row.entity_type, riskScore, severity, confidence, primary);
            }
        }
    }
}
