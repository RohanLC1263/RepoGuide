import { DatabaseSync } from 'node:sqlite';
import { executeTransaction } from '../store/sqliteLoader';
import { DecisionOutcomeStore } from './decisionOutcomeStore';
import { RepositoryBuilder } from '../orchestrator/orchestratorTypes';
import { randomUUID } from 'crypto';
import { RepositoryBrain } from '../query/repositoryBrain';
import { mapEntityToSubject } from '../query/repositoryKnowledgeSubject';

interface EntitySignals {
    entityType: string;
    entityId: string;
    healthSnapshots: number;
    latestHealth: number;
    healthTrend: 'IMPROVING' | 'STABLE' | 'DEGRADING';
    
    validitySnapshots: number;
    latestValidity: number;
    validityTrend: 'IMPROVING' | 'STABLE' | 'DEGRADING';
    
    evolutionEventCount: number;
    
    reviewCount: number;
    reviewFailureCount: number;
    
    incidentCount: number;
}

interface PendingObservation {
    entityType: string;
    entityId: string;
    outcomeType: 'SUCCESSFUL' | 'STABLE' | 'DEGRADING' | 'FAILED';
    outcomeScore: number;
    confidenceScore: number;
    evidenceCount: number;
    healthTrend: string;
    validityTrend: string;
    evidenceRefs: { sourceTable: string; sourceId: string; description: string }[];
}

export class DecisionOutcomeBuilder implements RepositoryBuilder {
    constructor(private db: DatabaseSync, private store: DecisionOutcomeStore, private repositoryBrain?: RepositoryBrain) {}

    public async build(): Promise<void> {
        this.store.clearAll();

        const tx = executeTransaction(this.db, (): PendingObservation[] => {
            const pending: PendingObservation[] = [];
            const now = new Date().toISOString();
            const dateStr = now.substring(0, 10);

            // Fetch bulk signals
            const healthMap = this.getHealthSignals();
            const validityMap = this.getValiditySignals();
            const evolutionMap = this.getEvolutionSignals();
            const reviewMap = this.getReviewSignals();
            const incidentMap = this.getIncidentSignals();
            const coverageMap = this.getCoverageSignals();

            // Collect all unique entities
            const allEntityKeys = new Set([
                ...healthMap.keys(),
                ...validityMap.keys(),
                ...evolutionMap.keys(),
                ...reviewMap.keys(),
                ...incidentMap.keys(),
                ...coverageMap.keys()
            ]);

            // Insert statements
            const insertOutcome = this.db.prepare(`
                INSERT INTO decision_outcomes (
                    entity_type, entity_id, outcome_type, outcome_score, confidence_score,
                    evidence_count, incident_count, review_failure_count, health_trend, validity_trend, calculated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const insertEvidence = this.db.prepare(`
                INSERT INTO outcome_evidence (entity_type, entity_id, evidence_type, evidence_id, evidence_text)
                VALUES (?, ?, ?, ?, ?)
            `);

            const insertSnapshot = this.db.prepare(`
                INSERT INTO outcome_history (
                    entity_type, entity_id, snapshot_date, outcome_type, outcome_score, confidence_score, evidence_count
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            for (const key of allEntityKeys) {
                const [entityType, entityId] = key.split('::');

                const hSig = healthMap.get(key) || { count: 0, latest: 100, earliest: 100 };
                const vSig = validityMap.get(key) || { count: 0, latest: 100, earliest: 100 };
                const eSig = evolutionMap.get(key) || { count: 0 };
                const rSig = reviewMap.get(key) || { count: 0, failures: 0 };
                const iSig = incidentMap.get(key) || { count: 0 };
                const cSig = coverageMap.get(key);

                // Determine Trends
                const healthTrend = this.calculateTrend(hSig.count, hSig.earliest, hSig.latest);
                const validityTrend = this.calculateTrend(vSig.count, vSig.earliest, vSig.latest);

                // Compute Penalties
                const healthPenalty = Math.max(0, 100 - hSig.latest);
                const validityPenalty = Math.max(0, 100 - vSig.latest);
                const reviewPenalty = rSig.failures * 10;
                const incidentPenalty = iSig.count * 20;
                const evolutionPenalty = eSig.count > 10 ? 5 : 0; // simple penalty for high churn
                
                let coveragePenalty = 0;
                if (cSig) {
                    if (cSig.latest < 50) coveragePenalty = 15;
                    else if (cSig.latest < 75) coveragePenalty = 10;
                    else if (cSig.latest < 90) coveragePenalty = 5;
                }

                let rawScore = 100 - healthPenalty - validityPenalty - reviewPenalty - incidentPenalty - evolutionPenalty - coveragePenalty;
                const outcomeScore = Math.max(0, Math.min(100, rawScore));

                // Compute Outcome Type using strict score bands
                let outcomeType: 'SUCCESSFUL' | 'STABLE' | 'DEGRADING' | 'FAILED' = 'STABLE';
                if (outcomeScore >= 85) outcomeType = 'SUCCESSFUL';
                else if (outcomeScore >= 70) outcomeType = 'STABLE';
                else if (outcomeScore >= 50) outcomeType = 'DEGRADING';
                else outcomeType = 'FAILED';

                // Compute Confidence
                const evidenceCount = hSig.count + vSig.count + eSig.count + rSig.count + iSig.count;
                const confidenceScore = Math.min(100, Math.log10(evidenceCount + 1) * 40);

                // Persist Outcome
                insertOutcome.run(
                    entityType, entityId, outcomeType, outcomeScore, confidenceScore,
                    evidenceCount, iSig.count, rSig.failures, healthTrend, validityTrend, now
                );

                // Persist Evidence
                const evidenceRefs: PendingObservation['evidenceRefs'] = [];
                const recordEvidence = (evidenceType: string, description: string) => {
                    const evidenceId = randomUUID();
                    insertEvidence.run(entityType, entityId, evidenceType, evidenceId, description);
                    evidenceRefs.push({ sourceTable: 'outcome_evidence', sourceId: evidenceId, description });
                };
                if (healthPenalty > 0) recordEvidence('HEALTH', `Health penalty: -${healthPenalty} (Score: ${hSig.latest})`);
                if (validityPenalty > 0) recordEvidence('VALIDITY', `Validity penalty: -${validityPenalty} (Score: ${vSig.latest})`);
                if (reviewPenalty > 0) recordEvidence('REVIEW', `Review penalty: -${reviewPenalty} (${rSig.failures} failures)`);
                if (incidentPenalty > 0) recordEvidence('INCIDENT', `Incident penalty: -${incidentPenalty} (${iSig.count} incidents)`);
                if (evolutionPenalty > 0) recordEvidence('EVOLUTION', `Evolution penalty: -${evolutionPenalty} (High churn)`);
                if (coveragePenalty > 0) recordEvidence('COVERAGE', `Coverage penalty: -${coveragePenalty} (Score: ${cSig?.latest}%)`);

                // Persist Snapshot
                insertSnapshot.run(
                    entityType, entityId, dateStr, outcomeType, outcomeScore, confidenceScore, evidenceCount
                );

                pending.push({ entityType, entityId, outcomeType, outcomeScore, confidenceScore, evidenceCount, healthTrend, validityTrend, evidenceRefs });
            }
            return pending;
        });

        const pendingObservations = tx();
        if (this.repositoryBrain) {
            for (const p of pendingObservations) {
                await this.repositoryBrain.observe({
                    type: 'decision_outcome',
                    subject: mapEntityToSubject(p.entityType, p.entityId),
                    claim: {
                        text: `${p.entityType} ${p.entityId} outcome: ${p.outcomeType} (score ${p.outcomeScore}/100, health ${p.healthTrend}, validity ${p.validityTrend})`,
                        data: { outcomeType: p.outcomeType, outcomeScore: p.outcomeScore, healthTrend: p.healthTrend, validityTrend: p.validityTrend }
                    },
                    confidence: { score: p.confidenceScore, breakdown: { evidenceVolume: p.evidenceCount } },
                    provenance: {
                        sourceArtifacts: [`decision_outcomes:${p.entityType}:${p.entityId}`, ...p.evidenceRefs.map(e => `${e.sourceTable}:${e.sourceId}`)],
                        producedBy: 'decisionOutcomeBuilder'
                    },
                    supportingEvidence: p.evidenceRefs,
                    createdBy: 'decisionOutcomeBuilder'
                });
            }
        }
    }

    private calculateTrend(count: number, earliest: number, latest: number): 'IMPROVING' | 'STABLE' | 'DEGRADING' {
        if (count < 2) return 'STABLE';
        const diff = latest - earliest;
        if (diff > 5) return 'IMPROVING';
        if (diff < -5) return 'DEGRADING';
        return 'STABLE';
    }

    // Bulk Query Methods

    private getHealthSignals(): Map<string, { count: number, latest: number, earliest: number }> {
        const rows = this.db.prepare(`
            WITH Ranked AS (
                SELECT entity_type, entity_id, health_score, snapshot_date,
                       ROW_NUMBER() OVER(PARTITION BY entity_type, entity_id ORDER BY snapshot_date ASC) as rn_asc,
                       ROW_NUMBER() OVER(PARTITION BY entity_type, entity_id ORDER BY snapshot_date DESC) as rn_desc,
                       COUNT(*) OVER(PARTITION BY entity_type, entity_id) as total_count
                FROM architectural_health_history
            )
            SELECT entity_type, entity_id,
                   MAX(CASE WHEN rn_desc = 1 THEN health_score END) as latest,
                   MAX(CASE WHEN rn_asc = 1 THEN health_score END) as earliest,
                   MAX(total_count) as cnt
            FROM Ranked
            GROUP BY entity_type, entity_id
        `).all() as any[];

        const map = new Map<string, any>();
        for (const r of rows) {
            map.set(`${r.entity_type}::${r.entity_id}`, { count: r.cnt, latest: r.latest, earliest: r.earliest });
        }
        return map;
    }

    private getValiditySignals(): Map<string, { count: number, latest: number, earliest: number }> {
        const rows = this.db.prepare(`
            WITH Ranked AS (
                SELECT kv.entity_type, kv.entity_id, vh.validity_score, vh.snapshot_date,
                       ROW_NUMBER() OVER(PARTITION BY kv.entity_type, kv.entity_id ORDER BY vh.snapshot_date ASC) as rn_asc,
                       ROW_NUMBER() OVER(PARTITION BY kv.entity_type, kv.entity_id ORDER BY vh.snapshot_date DESC) as rn_desc,
                       COUNT(*) OVER(PARTITION BY kv.entity_type, kv.entity_id) as total_count
                FROM validity_history vh
                JOIN knowledge_validity kv ON vh.validity_id = kv.id
            )
            SELECT entity_type, entity_id,
                   MAX(CASE WHEN rn_desc = 1 THEN validity_score END) as latest,
                   MAX(CASE WHEN rn_asc = 1 THEN validity_score END) as earliest,
                   MAX(total_count) as cnt
            FROM Ranked
            GROUP BY entity_type, entity_id
        `).all() as any[];

        const map = new Map<string, any>();
        for (const r of rows) {
            map.set(`${r.entity_type}::${r.entity_id}`, { count: r.cnt, latest: r.latest, earliest: r.earliest });
        }
        return map;
    }

    private getEvolutionSignals(): Map<string, { count: number }> {
        const rows = this.db.prepare(`
            SELECT ee.entity_type, ee.entity_id, COUNT(*) as cnt
            FROM evolution_events ev
            JOIN evolution_entities ee ON ev.entity_id = ee.entity_id
            GROUP BY ee.entity_type, ee.entity_id
        `).all() as any[];

        const map = new Map<string, any>();
        for (const r of rows) {
            map.set(`${r.entity_type}::${r.entity_id}`, { count: r.cnt });
        }
        return map;
    }

    private getReviewSignals(): Map<string, { count: number, failures: number }> {
        const rows = this.db.prepare(`
            SELECT entity_type, entity_id, COUNT(*) as cnt,
                   SUM(CASE WHEN reviewer_accepted = 0 OR defects_found > 0 THEN 1 ELSE 0 END) as failures
            FROM review_outcomes
            GROUP BY entity_type, entity_id
        `).all() as any[];

        const map = new Map<string, any>();
        for (const r of rows) {
            map.set(`${r.entity_type}::${r.entity_id}`, { count: r.cnt, failures: r.failures || 0 });
        }
        return map;
    }

    private getIncidentSignals(): Map<string, { count: number }> {
        const rows = this.db.prepare(`
            SELECT entity_type, entity_id, COUNT(*) as cnt
            FROM incident_events
            GROUP BY entity_type, entity_id
        `).all() as any[];

        const map = new Map<string, any>();
        for (const r of rows) {
            map.set(`${r.entity_type}::${r.entity_id}`, { count: r.cnt });
        }
        return map;
    }

    private getCoverageSignals(): Map<string, { latest: number }> {
        const rows = this.db.prepare(`
            SELECT entity_type, entity_id, coverage_percent
            FROM coverage_entities
        `).all() as any[];

        const map = new Map<string, { latest: number }>();
        for (const row of rows) {
            map.set(`${row.entity_type}::${row.entity_id}`, { latest: row.coverage_percent });
        }
        return map;
    }
}
