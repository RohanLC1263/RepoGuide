import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { 
    ReviewRecommendation, 
    ReviewRecommendedReviewer, 
    ReviewScope, 
    ReviewEvidence, 
    RiskLevel, 
    ReviewDepth 
} from './reviewIntelligenceTypes';
import { ReviewIntelligenceStore } from './reviewIntelligenceStore';

export class ReviewIntelligenceEngine {
    constructor(private db: DatabaseSync, private store: ReviewIntelligenceStore) {}

    public generateRecommendation(changeId: string, changedFiles: string[]): ReviewRecommendation {
        if (!changedFiles || changedFiles.length === 0) {
            throw new Error("Cannot generate recommendation for empty change set.");
        }

        const placeholders = changedFiles.map(() => '?').join(',');

        // 1. Expand Scope
        // Impacted Files
        const impactedRows = this.db.prepare(`
            SELECT DISTINCT i.node_id 
            FROM intent_aware_impacts root
            JOIN impact_nodes i ON root.id = i.impact_id
            WHERE root.root_node_id IN (${placeholders})
        `).all(...changedFiles) as any[];
        
        // Coupled Files (Gated)
        const coupledRows = this.db.prepare(`
            SELECT DISTINCT target_path as node_id
            FROM logical_coupling_edges
            WHERE source_path IN (${placeholders}) AND confidence > 0.5 AND co_change_count > 5
            UNION
            SELECT DISTINCT source_path as node_id
            FROM logical_coupling_edges
            WHERE target_path IN (${placeholders}) AND confidence > 0.5 AND co_change_count > 5
        `).all(...changedFiles, ...changedFiles) as any[];

        const impactedFiles = impactedRows.map(r => r.node_id).filter(f => !changedFiles.includes(f));
        const coupledFiles = coupledRows.map(r => r.node_id).filter(f => !changedFiles.includes(f) && !impactedFiles.includes(f));
        
        const allScopeFiles = [...new Set([...changedFiles, ...impactedFiles, ...coupledFiles])];

        // 2. Identify Relevant ADRs
        const adrRows = this.db.prepare(`
            SELECT DISTINCT adr_id 
            FROM adr_code_links 
            WHERE node_id IN (${placeholders})
        `).all(...changedFiles) as any[];
        const relevantADRs = adrRows.map(r => r.adr_id);

        // 3. Assess Risks
        const adrPlaceholders = relevantADRs.length > 0 ? relevantADRs.map(() => '?').join(',') : "''";
        
        // Health Risk
        const healthRow = this.db.prepare(`
            SELECT MIN(health_score) as min_health 
            FROM architectural_health 
            WHERE entity_id IN (${adrPlaceholders})
        `).get(...relevantADRs) as any;
        const minHealth = healthRow?.min_health ?? 100;
        const healthRisk = Math.max(0, 100 - minHealth);

        // Hotspot Risk
        const hotspotRow = this.db.prepare(`
            SELECT MAX(hotspot_score) as max_hotspot, MIN(bus_factor) as min_bus_factor, MAX(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END) as has_critical
            FROM knowledge_hotspots 
            WHERE entity_id IN (${adrPlaceholders})
        `).get(...relevantADRs) as any;
        const hotspotRisk = hotspotRow?.max_hotspot ?? 0;
        const minBusFactor = hotspotRow?.min_bus_factor ?? 99;
        const hasCriticalHotspot = (hotspotRow?.has_critical ?? 0) === 1;

        // Blast Radius Risk
        const blastRow = this.db.prepare(`
            SELECT MAX(governance_score) as max_gov 
            FROM intent_aware_impacts 
            WHERE root_node_id IN (${placeholders})
        `).get(...changedFiles) as any;
        const blastRadiusRisk = Math.min(100, blastRow?.max_gov ?? 0);

        // Coupling Risk
        const couplingRisk = Math.min(100, (impactedFiles.length + coupledFiles.length) * 5);

        const riskScore = (healthRisk + hotspotRisk + blastRadiusRisk + couplingRisk) / 4;

        let riskLevel: RiskLevel = "LOW";
        if (riskScore >= 75) riskLevel = "CRITICAL";
        else if (riskScore >= 50) riskLevel = "HIGH";
        else if (riskScore >= 25) riskLevel = "MEDIUM";

        let reviewDepth: ReviewDepth = "LIGHT";
        if (hasCriticalHotspot || healthRisk > 80) reviewDepth = "ARCHITECTURAL";
        else if (relevantADRs.length > 2 || hotspotRisk > 60) reviewDepth = "DEEP";
        else if (blastRadiusRisk > 30) reviewDepth = "STANDARD";

        let reviewerCount = 1;
        if (reviewDepth === "ARCHITECTURAL" || reviewDepth === "DEEP") reviewerCount = 2;
        if (hasCriticalHotspot) reviewerCount = Math.max(reviewerCount, 2);

        // 4. Rank Reviewers
        const allScopePlaceholders = allScopeFiles.map(() => '?').join(',');
        const experts = this.db.prepare(`
            SELECT author_email, MAX(author_name) as author_name, 
                   SUM(expertise_score) as raw_score,
                   MIN(knowledge_age_days) as best_age
            FROM author_expertise
            WHERE entity_type = 'FILE' AND entity_id IN (${allScopePlaceholders})
            GROUP BY author_email
        `).all(...allScopeFiles) as any[];

        // Normalize max raw_score
        const maxRaw = Math.max(...experts.map(e => e.raw_score), 1);
        
        const reviewers: ReviewRecommendedReviewer[] = [];
        for (const e of experts) {
            let recency = 0.5;
            if (e.best_age < 90) recency = 1.0;
            else if (e.best_age < 365) recency = 0.8;

            let baseScore = (e.raw_score / maxRaw) * 100;
            
            // Backup Reviewer Boost
            if (hasCriticalHotspot && minBusFactor === 1) {
                // If they are not the primary expert (score < 80) but have some knowledge, boost them to spread knowledge
                if (baseScore < 80 && baseScore > 5) {
                    baseScore *= 2.0; 
                }
            }

            reviewers.push({
                recommendationId: '',
                authorEmail: e.author_email,
                reviewerScore: baseScore * recency
            });
        }

        reviewers.sort((a, b) => b.reviewerScore - a.reviewerScore);
        const selectedReviewers = reviewers.slice(0, reviewerCount * 2); // suggest top candidates

        // 5. Assemble Recommendation
        const recId = randomUUID();
        const recommendation: ReviewRecommendation = {
            id: recId,
            changeId,
            riskLevel,
            reviewDepth,
            reviewerCount,
            createdAt: new Date()
        };

        selectedReviewers.forEach(r => r.recommendationId = recId);

        const scopes: ReviewScope[] = [];
        changedFiles.forEach(f => scopes.push({ recommendationId: recId, filePath: f, scopeType: "CHANGED" }));
        impactedFiles.forEach(f => scopes.push({ recommendationId: recId, filePath: f, scopeType: "IMPACTED" }));
        coupledFiles.forEach(f => scopes.push({ recommendationId: recId, filePath: f, scopeType: "COUPLED" }));

        const evidences: ReviewEvidence[] = [];
        relevantADRs.forEach(adr => {
            evidences.push({
                recommendationId: recId,
                evidenceType: "ADR",
                evidenceId: adr,
                evidenceText: `Governed by ${adr}`
            });
        });
        if (hasCriticalHotspot) {
            evidences.push({
                recommendationId: recId,
                evidenceType: "HOTSPOT",
                evidenceId: "CRITICAL",
                evidenceText: "Change touches a critical knowledge hotspot"
            });
        }
        if (impactedFiles.length > 0) {
            evidences.push({
                recommendationId: recId,
                evidenceType: "BLAST_RADIUS",
                evidenceId: "IMPACTED_FILES",
                evidenceText: `Expanded scope by ${impactedFiles.length} impacted files`
            });
        }
        if (coupledFiles.length > 0) {
            evidences.push({
                recommendationId: recId,
                evidenceType: "COUPLING",
                evidenceId: "COUPLED_FILES",
                evidenceText: `Expanded scope by ${coupledFiles.length} highly coupled files`
            });
        }

        this.store.saveRecommendation(recommendation, selectedReviewers, scopes, evidences);

        return recommendation;
    }
}
