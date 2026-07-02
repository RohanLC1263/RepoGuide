import { DatabaseSync } from 'node:sqlite';
import { ChangeSetPrediction, RecommendedReviewer, ExpectedIncident } from './changeImpactTypes';

export class ChangeImpactQueryEngine {
    constructor(private db: DatabaseSync) {}

    public predictChangeSet(entities: string[], author: string): ChangeSetPrediction {
        if (!entities || entities.length === 0) {
            throw new Error("ChangeSet must contain at least one entity.");
        }

        // 1. Base Lookup
        const placeholders = entities.map(() => '?').join(',');
        const baseRows = this.db.prepare(`
            SELECT entity_id, base_failure_probability, primary_risk_driver
            FROM change_risk_predictions
            WHERE entity_id IN (${placeholders})
        `).all(...entities) as any[];

        if (baseRows.length === 0) {
            // Default safe prediction if entities are unknown
            return this.createDefaultPrediction();
        }

        let totalRiskInverse = 1.0;
        const drivers: string[] = [];
        let maxCouplingPenalty = 0;
        const missingCouplings: string[] = [];

        // Try to check logical coupling penalties
        // Assuming table `logical_coupling` exists with source_entity, target_entity, coupling_score
        try {
            const couplingRows = this.db.prepare(`
                SELECT target_entity, coupling_score
                FROM logical_coupling
                WHERE source_entity IN (${placeholders})
                  AND target_entity NOT IN (${placeholders})
                  AND coupling_score > 50
            `).all(...entities, ...entities) as any[];

            for (const c of couplingRows) {
                const penalty = (c.coupling_score / 100.0) * 0.4;
                totalRiskInverse *= (1.0 - penalty);
                missingCouplings.push(c.target_entity);
                if (penalty > maxCouplingPenalty) maxCouplingPenalty = penalty;
            }
        } catch (e) {
            // Table might not exist in testing, ignore gracefully
        }

        if (missingCouplings.length > 0) {
            drivers.push(`Missing highly coupled dependencies: ${missingCouplings.slice(0, 3).join(', ')}`);
        }

        // 3. Process base risks and Author Expertise modifier
        let expertiseModifier = 1.0;
        try {
            const expRows = this.db.prepare(`
                SELECT expertise_score 
                FROM author_expertise 
                WHERE author = ? AND entity_id IN (${placeholders})
            `).all(author, ...entities) as any[];
            
            if (expRows.length > 0) {
                const avgExp = expRows.reduce((sum, r) => sum + r.expertise_score, 0) / expRows.length;
                expertiseModifier = 1.0 - ((avgExp / 100.0) * 0.5); // Up to 50% risk reduction
            }
        } catch (e) {
            // Ignore
        }

        for (const row of baseRows) {
            const modifiedRisk = row.base_failure_probability * expertiseModifier;
            totalRiskInverse *= (1.0 - modifiedRisk);
            if (row.base_failure_probability > 0.2) {
                drivers.push(`High base risk for ${row.entity_id}: ${row.primary_risk_driver}`);
            }
        }

        const failureProbability = 1.0 - totalRiskInverse;

        // Find reviewers
        const reviewers: RecommendedReviewer[] = [];
        try {
            const revRows = this.db.prepare(`
                SELECT author, AVG(expertise_score) as avg_score
                FROM author_expertise
                WHERE entity_id IN (${placeholders})
                  AND author != ?
                GROUP BY author
                ORDER BY avg_score DESC
                LIMIT 3
            `).all(author, ...entities) as any[];

            for (const r of revRows) {
                reviewers.push({
                    author: r.author,
                    expertise_score: r.avg_score,
                    reasoning: "High aggregated expertise (" + Math.round(r.avg_score) + ") across modified files."
                });
            }
        } catch(e) {}

        // 4. Expected Incident Types
        const incidents: ExpectedIncident[] = [];
        try {
            // Very simplified: query incident patterns if matching primary drivers
            const primaryDriver = baseRows[0]?.primary_risk_driver || 'UNKNOWN';
            const incRows = this.db.prepare(`
                SELECT incident_type, confidence
                FROM incident_patterns
                WHERE factor_pattern LIKE '%' || ? || '%'
                ORDER BY confidence DESC
                LIMIT 2
            `).all(primaryDriver) as any[];

            for (const ir of incRows) {
                incidents.push({
                    incident_type: ir.incident_type,
                    probability: ir.confidence / 100.0,
                    reasoning: "Based on presence of " + primaryDriver
                });
            }
        } catch (e) {}

        // Threshold classification
        let severity: 'LOW' | 'ELEVATED' | 'HIGH' | 'CRITICAL' = 'LOW';
        // Assuming P95=0.4, P85=0.2 (Mocking relative percentiles for now)
        const P95 = 0.4;
        const P85 = 0.2;
        const P70 = 0.1;

        if (failureProbability >= P95 && failureProbability >= 0.4) severity = 'CRITICAL';
        else if (failureProbability >= P85 && failureProbability >= 0.2) severity = 'HIGH';
        else if (failureProbability >= P70 && failureProbability >= 0.1) severity = 'ELEVATED';

        // Confidence calculation (Canonical Formula)
        // C = 0.4(Size) + 0.3(Agreement) + 0.2(Recency) + 0.1(Stability)
        const C_sample = 0.8; // default mock
        const C_agreement = 0.7; // default mock
        const C_recency = 0.9; // default mock
        const C_stability = 1.0 - maxCouplingPenalty;
        
        const confidence = (0.4 * C_sample) + (0.3 * C_agreement) + (0.2 * C_recency) + (0.1 * C_stability);

        if (drivers.length === 0) drivers.push('Standard evolutionary change.');

        return {
            severity,
            failure_probability: failureProbability,
            confidence,
            risk_drivers: drivers,
            recommended_reviewers: reviewers,
            expected_incident_types: incidents,
            missing_logical_couplings: missingCouplings
        };
    }

    private createDefaultPrediction(): ChangeSetPrediction {
        return {
            severity: 'LOW',
            failure_probability: 0.01,
            confidence: 0.5,
            risk_drivers: ['New or unindexed files.'],
            recommended_reviewers: [],
            expected_incident_types: [],
            missing_logical_couplings: []
        };
    }
}
