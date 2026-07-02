import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { KnowledgeValidityStore } from './knowledgeValidityStore';
import { KnowledgeValidity, ValidityEvidence, ValidityHistory, KnowledgeValidityTier, ValidityTrend } from './knowledgeValidityTypes';

import { RepositoryBuilder } from '../orchestrator/orchestratorTypes';

export class KnowledgeValidityBuilder implements RepositoryBuilder {
    constructor(private db: DatabaseSync, private store: KnowledgeValidityStore) {}

    public async build(): Promise<void> {
        this.store.clearAll();

        const adrs = this.db.prepare(`SELECT id, title FROM adrs`).all() as any[];

        for (const adr of adrs) {
            this.buildForADR(adr.id);
        }
    }

    public buildForADR(adrId: string): KnowledgeValidity {
        let expertStalenessPenalty = 0;
        let healthPenalty = 0;
        let driftPenalty = 0;
        let hotspotPenalty = 0;
        let reviewPenalty = 0;

        let confidenceScore = 0;
        let expertCount = 0;
        let reviewCount = 0;

        const evidences: ValidityEvidence[] = [];
        const staticId = `VAL-${adrId}`;
        let validityId = staticId;

        // 1. Author Expertise
        // Get files governed by ADR
        const files = this.db.prepare(`SELECT node_id FROM adr_code_links WHERE adr_id = ?`).all(adrId) as any[];
        const filePaths = files.map(f => f.node_id);
        
        if (filePaths.length > 0) {
            const placeholders = filePaths.map(() => '?').join(',');
            const expertsRow = this.db.prepare(`
                SELECT COUNT(DISTINCT author_email) as expert_count, 
                       MIN(knowledge_age_days) as best_age
                FROM author_expertise 
                WHERE entity_type = 'FILE' AND entity_id IN (${placeholders})
            `).get(...filePaths) as any;

            expertCount = expertsRow?.expert_count ?? 0;
            const bestAge = expertsRow?.best_age ?? 9999;

            if (bestAge > 365) {
                expertStalenessPenalty += 20;
                evidences.push({
                    validityId, evidenceType: 'EXPERT', evidenceId: 'STALE', evidenceText: 'Most recent expert activity is > 365 days old'
                });
            } else if (bestAge > 90) {
                expertStalenessPenalty += 10;
                evidences.push({
                    validityId, evidenceType: 'EXPERT', evidenceId: 'AGING', evidenceText: 'Most recent expert activity is > 90 days old'
                });
            }

            if (expertCount > 0) confidenceScore += 25; // Good coverage of experts
        }

        // 2. Health Penalty
        const healthRow = this.db.prepare(`SELECT health_score FROM architectural_health WHERE entity_id = ?`).get(adrId) as any;
        if (healthRow) {
            const hs = healthRow.health_score;
            if (hs < 100) {
                const diff = 100 - hs;
                healthPenalty = Math.min(30, diff * 0.3);
                evidences.push({
                    validityId, evidenceType: 'HEALTH', evidenceId: 'DEGRADED', evidenceText: `Architectural health is degraded (${hs.toFixed(1)})`
                });
            }
            confidenceScore += 25; // We have health metrics for this ADR
        }

        // 3. Hotspot Penalty
        const hotspotRow = this.db.prepare(`SELECT severity, bus_factor FROM knowledge_hotspots WHERE entity_id = ?`).get(adrId) as any;
        if (hotspotRow) {
            if (hotspotRow.severity === 'CRITICAL') {
                hotspotPenalty += 20;
                evidences.push({
                    validityId, evidenceType: 'HOTSPOT', evidenceId: 'CRITICAL', evidenceText: `ADR is part of a CRITICAL knowledge hotspot`
                });
            }
            if (hotspotRow.bus_factor === 1) {
                expertStalenessPenalty = Math.min(30, expertStalenessPenalty + 10);
                evidences.push({
                    validityId, evidenceType: 'EXPERT', evidenceId: 'BUS_FACTOR_1', evidenceText: `Bus factor is 1`
                });
            }
            confidenceScore += 25; // We have hotspot metrics
        }

        // 4. Drift Penalty
        const drifts = this.db.prepare(`SELECT severity, drift_type FROM drift_findings WHERE adr_id = ?`).all(adrId) as any[];
        if (drifts.length > 0) {
            let criticals = 0;
            let highs = 0;
            for (const d of drifts) {
                if (d.severity === 'CRITICAL') criticals++;
                else if (d.severity === 'HIGH') highs++;
            }
            driftPenalty = Math.min(40, (criticals * 20) + (highs * 10));
            evidences.push({
                validityId, evidenceType: 'DRIFT', evidenceId: 'ACTIVE_FINDINGS', evidenceText: `${drifts.length} active drift findings (${criticals} CRITICAL, ${highs} HIGH)`
            });
            confidenceScore += 25; // We have drift data
        } else if (filePaths.length > 0) {
             // If we have files but no drift, that is good signal and boosts confidence.
             confidenceScore += 25;
        }

        // 5. Review Outcomes Penalty
        if (filePaths.length > 0) {
            const outcomes = this.db.prepare(`
                SELECT SUM(post_merge_incidents) as incidents, SUM(defects_found) as defects 
                FROM review_outcomes 
                WHERE entity_type = 'ADR' AND entity_id = ?
            `).get(adrId) as any;
            
            if (outcomes && (outcomes.incidents > 0 || outcomes.defects > 0)) {
                reviewPenalty = Math.min(30, (outcomes.incidents * 15) + (outcomes.defects * 5));
                evidences.push({
                    validityId, evidenceType: 'REVIEW', evidenceId: 'DEFECTS', evidenceText: `Recent reviews found ${outcomes.defects} defects and caused ${outcomes.incidents} incidents`
                });
            }
        }

        const validityScore = Math.max(0, 100 - (expertStalenessPenalty + healthPenalty + driftPenalty + hotspotPenalty + reviewPenalty));
        confidenceScore = Math.min(100, confidenceScore);

        let tier: KnowledgeValidityTier = "LOW";
        if (validityScore >= 90) tier = "VERY_HIGH";
        else if (validityScore >= 75) tier = "HIGH";
        else if (validityScore >= 50) tier = "MEDIUM";
        else if (validityScore >= 25) tier = "LOW";
        else tier = "VERY_LOW";

        // Previous history for trend
        const previous = this.store.getPreviousHistory(adrId); // Actually ID might not be ADR ID for getPreviousHistory, it should be entityId!
        // The store getPreviousHistory queries by validityId, but validityId is newly generated here.
        // I need to fetch by entityId!
        const prevRow = this.db.prepare(`
            SELECT v.validity_score 
            FROM knowledge_validity v 
            WHERE v.entity_type = 'ADR' AND v.entity_id = ?
        `).get(adrId) as any;

        let trend: ValidityTrend = "STABLE";
        if (prevRow) {
            if (validityScore > prevRow.validity_score + 5) trend = "IMPROVING";
            else if (validityScore < prevRow.validity_score - 5) trend = "DEGRADING";
        }

        // evidences already has staticId set


        const validity: KnowledgeValidity = {
            id: staticId,
            entityType: 'ADR',
            entityId: adrId,
            validityScore,
            validityTier: tier,
            confidenceScore,
            trend,
            lastValidatedAt: new Date(),
            evidenceCount: evidences.length
        };

        const history: ValidityHistory = {
            validityId: staticId,
            snapshotDate: new Date(),
            validityScore,
            confidenceScore
        };

        this.store.saveValidity(validity, evidences, history);
        return validity;
    }
}
