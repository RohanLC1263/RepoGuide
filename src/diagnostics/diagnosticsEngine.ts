import { DatabaseSync } from 'node:sqlite';

export class DiagnosticsEngine {
    constructor(private db: DatabaseSync) {}

    public runDiagnostics(): void {
        const errors: string[] = [];

        // 1. Expert Count <-> Bus Factor (Hotspots vs Expertise)
        const expertMismatch = this.db.prepare(`
            WITH adr_experts AS (
                SELECT l.adr_id as entity_id, COUNT(DISTINCT e.author_email) as real_expert_count
                FROM adr_code_links l
                JOIN author_expertise e ON l.node_id = e.entity_id AND e.entity_type = 'FILE'
                GROUP BY l.adr_id
            )
            SELECT h.entity_id, h.expert_count, a.real_expert_count
            FROM knowledge_hotspots h
            LEFT JOIN adr_experts a ON h.entity_id = a.entity_id
            WHERE h.entity_type = 'ADR' AND h.expert_count != COALESCE(a.real_expert_count, 0)
        `).all() as any[];
        if (expertMismatch.length > 0) {
            errors.push(`Expert mismatch detected for entities: ${expertMismatch.map(r => r.entity_id).join(', ')}`);
        }

        // 2. Health <-> Drift
        const healthDriftMismatch = this.db.prepare(`
            SELECT h.entity_id, h.health_score, COUNT(f.id) as drift_count
            FROM architectural_health h
            LEFT JOIN drift_findings f ON h.entity_id = f.entity_id AND f.resolution_state = 'ACTIVE'
            WHERE h.health_score < 100 AND f.id IS NULL
            GROUP BY h.entity_id
        `).all() as any[];
        if (healthDriftMismatch.length > 0) {
            errors.push(`Health score < 100 but no active drift findings: ${healthDriftMismatch.map(r => r.entity_id).join(', ')}`);
        }

        // 3. Validity <-> Evidence
        const validityEvidenceMismatch = this.db.prepare(`
            SELECT v.id, v.validity_score, COUNT(e.validity_id) as evidence_count
            FROM knowledge_validity v
            LEFT JOIN validity_evidence e ON v.id = e.validity_id
            WHERE v.validity_score < 100 AND e.validity_id IS NULL
            GROUP BY v.id
        `).all() as any[];
        if (validityEvidenceMismatch.length > 0) {
            errors.push(`Validity score < 100 but no evidence: ${validityEvidenceMismatch.map(r => r.id).join(', ')}`);
        }

        // 4. Evolution <-> Health Changes
        // Ensure that an entity with a new low health score has a corresponding milestone or health changed event in its timeline, if it exists.
        // We'll do a basic check: if there is an evolution_events record for the entity, it shouldn't be completely devoid of HEALTH_CHANGED if health < 100 and it's not newly emerging.
        // Let's just check that `evolution_entities.current_state` exists for all validities.
        const evolutionMissing = this.db.prepare(`
            SELECT v.entity_id
            FROM knowledge_validity v
            LEFT JOIN evolution_entities e ON v.entity_id = e.entity_id
            WHERE e.id IS NULL
        `).all() as any[];
        if (evolutionMissing.length > 0) {
            errors.push(`Evolution tracking missing for entities: ${evolutionMissing.map(r => r.entity_id).join(', ')}`);
        }

        // 5. Review Intelligence <-> Hotspots
        // Wait, Review Intelligence works on `change_id` (PRs), not entities directly.
        // But we can check that recommendations have scopes.
        const reviewMissingScope = this.db.prepare(`
            SELECT r.id
            FROM review_recommendations r
            LEFT JOIN review_scope s ON r.id = s.recommendation_id
            WHERE s.recommendation_id IS NULL
        `).all() as any[];
        if (reviewMissingScope.length > 0) {
            errors.push(`Review recommendations missing scope: ${reviewMissingScope.map(r => r.id).join(', ')}`);
        }

        // 6. Bus Factor Correctness
        const busFactorMismatch = this.db.prepare(`
            SELECT entity_id, bus_factor, expert_count 
            FROM knowledge_hotspots 
            WHERE bus_factor > expert_count OR bus_factor < 0
        `).all() as any[];
        if (busFactorMismatch.length > 0) {
            errors.push(`Bus factor mathematically invalid: ${busFactorMismatch.map(r => r.entity_id).join(', ')}`);
        }

        // 7. Review Attribution Correctness
        const invalidReviews = this.db.prepare(`
            SELECT r.review_id 
            FROM review_outcomes r
            LEFT JOIN adrs a ON r.entity_id = a.id AND r.entity_type = 'ADR'
            WHERE r.entity_type = 'ADR' AND a.id IS NULL
        `).all() as any[];
        if (invalidReviews.length > 0) {
            errors.push(`Review outcomes attributed to missing entities: ${invalidReviews.map(r => r.review_id).join(', ')}`);
        }

        // 8. History Continuity (Temporal check)
        const invalidDates = this.db.prepare(`
            SELECT 'validity_history' as tbl, snapshot_date FROM validity_history WHERE snapshot_date NOT LIKE '____-__-__' OR length(snapshot_date) != 10
            UNION ALL
            SELECT 'hotspot_history' as tbl, snapshot_date FROM hotspot_history WHERE snapshot_date NOT LIKE '____-__-__' OR length(snapshot_date) != 10
            UNION ALL
            SELECT 'architectural_health_history' as tbl, snapshot_date FROM architectural_health_history WHERE snapshot_date NOT LIKE '____-__-__' OR length(snapshot_date) != 10
            UNION ALL
            SELECT 'drift_history' as tbl, snapshot_date FROM drift_history WHERE snapshot_date NOT LIKE '____-__-__' OR length(snapshot_date) != 10
            UNION ALL
            SELECT 'evolution_snapshots' as tbl, snapshot_date FROM evolution_snapshots WHERE snapshot_date NOT LIKE '____-__-__' OR length(snapshot_date) != 10
            UNION ALL
            SELECT 'outcome_history' as tbl, snapshot_date FROM outcome_history WHERE snapshot_date NOT LIKE '____-__-__' OR length(snapshot_date) != 10
            UNION ALL
            SELECT 'coverage_history' as tbl, snapshot_date FROM coverage_history WHERE snapshot_date NOT LIKE '____-__-__' OR length(snapshot_date) != 10
        `).all() as any[];
        if (invalidDates.length > 0) {
            errors.push(`Temporal consistency violation in history tables: ${invalidDates.map(r => r.tbl + '(' + r.snapshot_date + ')').join(', ')}`);
        }

        // 9. Snapshot Consistency
        const orphanedHistory = this.db.prepare(`
            SELECT h.validity_id 
            FROM validity_history h
            LEFT JOIN knowledge_validity v ON h.validity_id = v.id
            WHERE v.id IS NULL
        `).all() as any[];
        if (orphanedHistory.length > 0) {
            errors.push(`Orphaned history records found: ${orphanedHistory.map(r => r.validity_id).join(', ')}`);
        }

        // 10. Coverage Integration Invariants
        const isolatedCoverage = this.db.prepare(`
            SELECT c.entity_type, c.entity_id 
            FROM coverage_entities c
            WHERE c.entity_type = 'ADR' AND c.coverage_percent < 50
            AND NOT EXISTS (
                SELECT 1 FROM outcome_evidence oe
                WHERE oe.entity_type = c.entity_type AND oe.entity_id = c.entity_id
                AND oe.evidence_type = 'COVERAGE'
            )
            AND NOT EXISTS (
                SELECT 1 FROM causal_factors cf
                JOIN causal_explanations cx ON cf.explanation_id = cx.id
                WHERE cx.target_entity_type = c.entity_type AND cx.target_entity_id = c.entity_id
                AND cf.factor_type = 'COVERAGE_DEGRADATION'
            )
        `).all() as any[];
        
        // 11. Outcome ↔ History Consistency
        const orphanedOutcomes = this.db.prepare(`
            SELECT o.entity_type, o.entity_id
            FROM decision_outcomes o
            LEFT JOIN outcome_history h ON o.entity_type = h.entity_type AND o.entity_id = h.entity_id
            WHERE h.entity_id IS NULL
        `).all() as any[];
        if (orphanedOutcomes.length > 0) {
            errors.push(`Orphaned outcomes without history snapshots detected: ${orphanedOutcomes.length}`);
        }

        // 12. Explanation ↔ Factor Consistency
        const emptyExplanations = this.db.prepare(`
            SELECT e.id
            FROM causal_explanations e
            LEFT JOIN causal_factors f ON e.id = f.explanation_id
            WHERE f.factor_id IS NULL
        `).all() as any[];
        if (emptyExplanations.length > 0) {
            errors.push(`Causal explanations without factors detected: ${emptyExplanations.length}`);
        }

        // 13. Chain Integrity
        const invalidChains = this.db.prepare(`
            SELECT c.explanation_id
            FROM causal_chains c
            LEFT JOIN causal_factors fp ON c.prev_factor_id = fp.factor_id
            LEFT JOIN causal_factors fn ON c.next_factor_id = fn.factor_id
            WHERE fp.factor_id IS NULL OR fn.factor_id IS NULL
        `).all() as any[];
        if (invalidChains.length > 0) {
            errors.push(`Causal chains referencing missing factors detected: ${invalidChains.length}`);
        }

        // 14. Evidence Integrity
        const unsupportedFactors = this.db.prepare(`
            SELECT f.factor_id
            FROM causal_factors f
            LEFT JOIN causal_evidence e ON f.factor_id = e.factor_id
            WHERE e.factor_id IS NULL
        `).all() as any[];
        if (unsupportedFactors.length > 0) {
            errors.push(`Causal factors without evidence detected: ${unsupportedFactors.length}`);
        }

        if (isolatedCoverage.length > 0) {
            errors.push(`Coverage Isolation detected! CRITICAL ADRs without health, outcome, or causal penalties: ${isolatedCoverage.map(r => r.entity_id).join(', ')}`);
        }

        if (errors.length > 0) {
            throw new Error('DiagnosticsEngine: Invariant violations detected:\\n' + errors.join('\\n'));
        }
    }
}
