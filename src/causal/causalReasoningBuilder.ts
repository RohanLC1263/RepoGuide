import { DatabaseSync } from 'node:sqlite';
import { CausalReasoningStore } from './causalReasoningStore';
import { CausalExplanation, CausalFactor, CausalChain, CausalEvidence } from './causalReasoningTypes';
import { RepositoryBrain } from '../query/repositoryBrain';
import { mapEntityToSubject } from '../query/repositoryKnowledgeSubject';

export class CausalReasoningBuilder {
    constructor(private db: DatabaseSync, private store: CausalReasoningStore, private repositoryBrain?: RepositoryBrain) {}

    public async build(): Promise<void> {
        this.store.clearAll();
        const now = new Date().toISOString();

        // 1. Extract outcomes
        const outcomes = this.db.prepare(`SELECT * FROM decision_outcomes`).all() as any[];

        // 2. Extract transitions using Window Functions
        // Health drops
        const healthDrops = this.db.prepare(`
            WITH Transitions AS (
                SELECT entity_type, entity_id, snapshot_date, health_score,
                       LAG(health_score) OVER (PARTITION BY entity_type, entity_id ORDER BY snapshot_date) as prev_score
                FROM architectural_health_history
            )
            SELECT entity_type, entity_id, snapshot_date, prev_score - health_score as change_amount
            FROM Transitions
            WHERE prev_score - health_score >= 5
        `).all() as any[];

        // Validity drops
        const validityDrops = this.db.prepare(`
            WITH Transitions AS (
                SELECT v.entity_type, v.entity_id, h.snapshot_date, h.validity_score,
                       LAG(h.validity_score) OVER (PARTITION BY v.entity_type, v.entity_id ORDER BY h.snapshot_date) as prev_score
                FROM validity_history h
                JOIN knowledge_validity v ON h.validity_id = v.id
            )
            SELECT entity_type, entity_id, snapshot_date, prev_score - validity_score as change_amount
            FROM Transitions
            WHERE prev_score - validity_score >= 5
        `).all() as any[];

        // Hotspot escalations
        const hotspotEscalations = this.db.prepare(`
            WITH Transitions AS (
                SELECT h.entity_type, h.entity_id, hh.snapshot_date, hh.hotspot_score,
                       LAG(hh.hotspot_score) OVER (PARTITION BY h.entity_type, h.entity_id ORDER BY hh.snapshot_date) as prev_score
                FROM hotspot_history hh
                JOIN knowledge_hotspots h ON hh.hotspot_id = h.id
            )
            SELECT entity_type, entity_id, snapshot_date, hotspot_score - prev_score as change_amount
            FROM Transitions
            WHERE hotspot_score - prev_score >= 5
        `).all() as any[];

        // Reviews
        const reviews = this.db.prepare(`
            SELECT entity_type, entity_id, created_at as snapshot_date, (defects_found + security_issues) as change_amount
            FROM review_outcomes
            WHERE is_approved = 0 OR defects_found > 0
        `).all() as any[];

        // Incidents
        const incidents = this.db.prepare(`
            SELECT entity_type, entity_id, timestamp as snapshot_date, 10 as change_amount
            FROM incident_events
        `).all() as any[];

        // Coverage drops
        const coverageDrops = this.db.prepare(`
            WITH Transitions AS (
                SELECT entity_type, entity_id, snapshot_date, coverage_percent,
                       LAG(coverage_percent) OVER (PARTITION BY entity_type, entity_id ORDER BY snapshot_date) as prev_score
                FROM coverage_history
            )
            SELECT entity_type, entity_id, snapshot_date, prev_score - coverage_percent as change_amount
            FROM Transitions
            WHERE prev_score - coverage_percent >= 10 AND prev_score IS NOT NULL
        `).all() as any[];

        // Coverage recoveries
        const coverageRecoveries = this.db.prepare(`
            WITH Transitions AS (
                SELECT entity_type, entity_id, snapshot_date, coverage_percent,
                       LAG(coverage_percent) OVER (PARTITION BY entity_type, entity_id ORDER BY snapshot_date) as prev_score
                FROM coverage_history
            )
            SELECT entity_type, entity_id, snapshot_date, coverage_percent - prev_score as change_amount
            FROM Transitions
            WHERE coverage_percent - prev_score >= 10 AND prev_score IS NOT NULL
        `).all() as any[];

        // Map events by entity key
        const eventMap = new Map<string, any[]>();
        const addEvent = (type: string, row: any) => {
            const key = `${row.entity_type}|${row.entity_id}`;
            if (!eventMap.has(key)) eventMap.set(key, []);
            eventMap.get(key)!.push({
                factorType: type,
                date: row.snapshot_date.substring(0, 10), // normalize to YYYY-MM-DD
                amount: row.change_amount
            });
        };

        healthDrops.forEach(r => addEvent('HEALTH', r));
        validityDrops.forEach(r => addEvent('VALIDITY', r));
        hotspotEscalations.forEach(r => addEvent('HOTSPOT', r));
        reviews.forEach(r => addEvent('REVIEW', r));
        incidents.forEach(r => addEvent('INCIDENT', r));
        coverageDrops.forEach(r => addEvent('COVERAGE_DEGRADATION', r));
        coverageRecoveries.forEach(r => addEvent('COVERAGE_RECOVERY', r));

        const insertExp = this.db.prepare(`INSERT INTO causal_explanations VALUES (?, ?, ?, ?, ?, ?, ?)`);
        const insertFactor = this.db.prepare(`INSERT INTO causal_factors VALUES (?, ?, ?, ?, ?)`);
        const insertChain = this.db.prepare(`INSERT INTO causal_chains VALUES (?, ?, ?, ?, ?)`);
        const insertEv = this.db.prepare(`INSERT INTO causal_evidence VALUES (?, ?, ?, ?)`);

        for (const outcome of outcomes) {
            const key = `${outcome.entity_type}|${outcome.entity_id}`;
            const events = eventMap.get(key) || [];
            
            // Sort events chronologically
            events.sort((a, b) => a.date.localeCompare(b.date));

            let expType = 'SUCCESS';
            if (outcome.outcome_type === 'FAILED') expType = 'FAILURE';
            if (outcome.outcome_type === 'DEGRADING') expType = 'DEGRADATION';
            // Simple recovery detection if score > 80 but events exist... just map for now.
            if (outcome.outcome_type === 'SUCCESSFUL' && outcome.health_trend === 'IMPROVING') expType = 'RECOVERY';

            const expId = `EXP|${key}`;
            
            // Confidence calculation based on Signal Agreement + Chain Depth
            const uniqueSignals = new Set(events.map(e => e.factorType)).size;
            const chainDepth = events.length;
            const signalScore = uniqueSignals * 20; // up to 100
            const depthScore = Math.min(50, chainDepth * 10);
            const rawConfidence = signalScore + depthScore;
            // Temporal Consistency: if sorted, we give a bonus. Since we sort, we just assume +10 if chainDepth > 1
            const confidence = Math.min(100, rawConfidence + (chainDepth > 1 ? 10 : 0));

            // decision_outcomes has no dedicated `id` column (PRIMARY KEY is entity_type+entity_id) —
            // outcome.id is undefined against the real DecisionOutcomeStore schema. Use the
            // composite key as the outcome reference instead (pre-existing bug, fixed here since
            // it made this INSERT throw on any real decision_outcomes data, not synthetic fixtures).
            const outcomeRef = outcome.id ?? key;
            insertExp.run(
                expId, outcome.entity_type, outcome.entity_id, outcomeRef, expType, confidence, now
            );

            if (this.repositoryBrain) {
                const factorsText = events.length > 0
                    ? events.map(e => `- ${e.factorType} on ${e.date} (impact ${e.amount})`).join('\n')
                    : 'No contributing factors detected.';
                await this.repositoryBrain.observe({
                    type: 'causal_explanation',
                    subject: mapEntityToSubject(outcome.entity_type, outcome.entity_id),
                    claim: {
                        text: `${expType} explanation for ${outcome.entity_type} ${outcome.entity_id}:\n${factorsText}`,
                        data: { explanationType: expType, outcomeId: outcomeRef, factorCount: events.length, factorTypes: Array.from(new Set(events.map(e => e.factorType))) }
                    },
                    confidence: { score: confidence, breakdown: { signalAgreement: signalScore, chainDepth: depthScore } },
                    provenance: {
                        sourceArtifacts: [`decision_outcomes:${outcomeRef}`, ...events.map(e => `${e.factorType}:${e.date}`)],
                        producedBy: 'causalReasoningBuilder'
                    },
                    supportingEvidence: events.map((e, idx) => ({ sourceTable: 'causal_evidence', sourceId: `F|${e.factorType}|${idx + 1}`, description: `${e.factorType} on ${e.date}` })),
                    createdBy: 'causalReasoningBuilder'
                });
            }

            if (events.length === 0) continue;

            let seq = 1;
            let prevEventId: string | null = null;
            let prevDate: string | null = null;

            // Calculate total impact for contribution normalization
            const totalImpact = events.reduce((sum, e) => sum + e.amount, 0);

            for (const ev of events) {
                const factorId = `F|${ev.factorType}|${seq}`;
                const contribution = totalImpact > 0 ? (ev.amount / totalImpact) * 100 : 0;

                insertFactor.run(
                    expId, ev.factorType, factorId, contribution, `${ev.factorType} transition detected`
                );

                insertEv.run(
                    expId, ev.factorType, factorId, `Date: ${ev.date}, Impact: ${ev.amount}`
                );

                if (prevEventId) {
                    let rel = 'PRECEDED';
                    if (ev.date === prevDate) {
                        rel = 'CORRELATED_WITH';
                    } else if (ev.factorType === 'INCIDENT' || ev.factorType === 'REVIEW') {
                        rel = 'AMPLIFIED';
                    } else if (contribution > 30) {
                        rel = 'CONTRIBUTED_TO';
                    }

                    insertChain.run(
                        expId, seq, prevEventId, factorId, rel
                    );
                }

                prevEventId = factorId;
                prevDate = ev.date;
                seq++;
            }
        }
    }
}
