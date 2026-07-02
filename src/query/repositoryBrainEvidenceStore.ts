import { DatabaseSync } from 'node:sqlite';
import { EvidenceItem, SemanticCategory } from './evidencePacket';
import { EvidencePlan } from './evidencePlanTypes';
import { DecisionOutcomeQueryEngine } from '../outcomes/decisionOutcomeQueryEngine';
import { CausalReasoningQueryEngine } from '../causal/causalReasoningQueryEngine';
import { TestCoverageQueryEngine } from '../coverage/testCoverageQueryEngine';
import { KnowledgeHotspotQueryEngine } from '../hotspots/knowledgeHotspotQueryEngine';
import { KnowledgeHotspotStore } from '../hotspots/knowledgeHotspotStore';
import { IncidentIntelligenceQueryEngine } from '../incidents/incidentIntelligenceQueryEngine';
import { ChangeImpactQueryEngine } from '../changeImpact/changeImpactQueryEngine';
import { ChangeSetPrediction } from '../changeImpact/changeImpactTypes';
import { PredictionAccountabilityStore } from '../accountability/predictionAccountabilityStore';
import { PredictionAccountabilityQueryEngine } from '../accountability/predictionAccountabilityQueryEngine';
import { RuntimeIntelligenceQueryEngine } from '../runtime/runtimeIntelligenceQueryEngine';

export class RepositoryBrainEvidenceStore {
    private db: DatabaseSync;
    private decisionOutcomeQueryEngine: DecisionOutcomeQueryEngine;
    private causalReasoningQueryEngine: CausalReasoningQueryEngine;
    private testCoverageQueryEngine: TestCoverageQueryEngine;
    private knowledgeHotspotQueryEngine: KnowledgeHotspotQueryEngine;
    private incidentIntelligenceQueryEngine: IncidentIntelligenceQueryEngine;
    private changeImpactQueryEngine: ChangeImpactQueryEngine;
    private predictionAccountabilityQueryEngine: PredictionAccountabilityQueryEngine;
    private runtimeIntelligenceQueryEngine: RuntimeIntelligenceQueryEngine;

    constructor(dbPath: string) {
        this.db = new DatabaseSync(dbPath);
        // Mandatory Requirement 1: SQLite WAL Mode
        this.db.exec(`PRAGMA journal_mode = WAL;`);
        this.db.exec(`PRAGMA synchronous = NORMAL;`);

        this.decisionOutcomeQueryEngine = new DecisionOutcomeQueryEngine(this.db);
        const mockCausalStore = {
            getDatabase: () => this.db,
            saveExplanation: () => {},
            saveFactor: () => {},
            saveChain: () => {}
        } as any;
        this.causalReasoningQueryEngine = new CausalReasoningQueryEngine(mockCausalStore);
        this.testCoverageQueryEngine = new TestCoverageQueryEngine(this.db);
        
        // Create an ad-hoc store for KnowledgeHotspotQueryEngine which expects KnowledgeHotspotStore
        const mockHotspotStore = {
            getDatabase: () => this.db,
            saveHotspot: () => {},
            saveEvidence: () => {},
            saveSnapshot: () => {}
        } as unknown as KnowledgeHotspotStore;
        
        this.knowledgeHotspotQueryEngine = new KnowledgeHotspotQueryEngine(mockHotspotStore);
        this.incidentIntelligenceQueryEngine = new IncidentIntelligenceQueryEngine(this.db);
        this.changeImpactQueryEngine = new ChangeImpactQueryEngine(this.db);
        
        const accountabilityStore = new PredictionAccountabilityStore(this.db);
        this.predictionAccountabilityQueryEngine = new PredictionAccountabilityQueryEngine(accountabilityStore);
        this.runtimeIntelligenceQueryEngine = new RuntimeIntelligenceQueryEngine(this.db);
    }

    public execute(plan: EvidencePlan): EvidenceItem[] {
        const items: EvidenceItem[] = [];
        
        // Mandatory Requirement 3: Dynamic Evidence Ranking
        let score = 0.85; // Default for broad questions or when just searching for context
        if (['decision_outcome_analysis', 'causal_analysis', 'risk_analysis', 'hotspot_analysis', 'incident_analysis', 'change_impact_prediction', 'prediction_accountability', 'runtime_intelligence'].includes(plan.queryType)) {
            score = 0.98; // Brain is primary source
        }

        // Handle Symbol Hints
        if (plan.symbolHints && plan.symbolHints.length > 0) {
            for (const hint of plan.symbolHints) {
                // Try to get specific outcomes
                try {
                    const outcome = this.decisionOutcomeQueryEngine.getOutcome('LogicalUnit', hint) || 
                                    this.decisionOutcomeQueryEngine.getOutcome('File', hint);
                    if (outcome) {
                        items.push(this.serializeDecisionOutcome(outcome, hint, score));
                    }

                    const explanation = this.causalReasoningQueryEngine.getExplanation('LogicalUnit', hint) || 
                                        this.causalReasoningQueryEngine.getExplanation('File', hint);
                    if (explanation) {
                        items.push(this.serializeCausalExplanation(explanation, score));
                    }

                    const hotspot = this.knowledgeHotspotQueryEngine.getHotspot(hint);
                    if (hotspot) {
                        items.push(this.serializeHotspot(hotspot, hint, score));
                    }

                    const risk = this.testCoverageQueryEngine.getCoverageRisk('File', hint) || 
                                 this.testCoverageQueryEngine.getCoverageRisk('LogicalUnit', hint);
                    if (risk) {
                        items.push(this.serializeCoverageRisk(risk, hint, score));
                    }
                } catch (e) {
                    console.error(`RepositoryBrain lookup error for hint ${hint}:`, e);
                }
            }
        }

        // Handle Broad Analyses based on Query Type
        try {
            if (plan.queryType === 'decision_outcome_analysis') {
                const successful = this.decisionOutcomeQueryEngine.getSuccessfulDecisions();
                const failed = this.decisionOutcomeQueryEngine.getFailedDecisions();
                items.push(this.serializeList('successful_outcomes', 'Successful Decisions', successful.map(o => o.entityId), score));
                items.push(this.serializeList('failed_outcomes', 'Failed Decisions', failed.map(o => o.entityId), score));
            } else if (plan.queryType === 'risk_analysis') {
                const dangerous = this.testCoverageQueryEngine.getMostDangerousUntestedAreas();
                items.push(this.serializeList('dangerous_coverage', 'Most Dangerous Untested Modules', dangerous.map(d => `${d.entityId} (Risk: ${d.riskScore})`), score));
            } else if (plan.queryType === 'hotspot_analysis') {
                const hotspots = this.knowledgeHotspotQueryEngine.getMostRiskySubsystems();
                items.push(this.serializeList('critical_hotspots', 'Most Risky Hotspots', hotspots.map(h => `${h.entityId} (Score: ${h.hotspotScore})`), score));
            } else if (plan.queryType === 'incident_analysis') {
                const predictions = this.incidentIntelligenceQueryEngine.getHighRiskAreas(10);
                const patterns = this.incidentIntelligenceQueryEngine.getTopPatterns(10);
                items.push(this.serializeList('incident_predictions', 'High Risk Predicted Incident Areas', predictions.map(p => `${p.entity_id} (${p.severity} Risk: ${p.risk_score}) - Driver: ${p.primary_risk_driver}`), score));
                items.push(this.serializeList('incident_patterns', 'Top Incident Patterns', patterns.map(p => `Pattern: ${p.factor_pattern} (Freq: ${p.frequency}, Conf: ${p.confidence})`), score));
            } else if (plan.queryType === 'change_impact_prediction') {
                if (plan.symbolHints && plan.symbolHints.length > 0) {
                    const prediction = this.changeImpactQueryEngine.predictChangeSet(plan.symbolHints, 'UnknownAuthor');
                    items.push(this.serializeChangeImpact(prediction, plan.symbolHints.join(', '), score));
                }
            } else if (plan.queryType === 'prediction_accountability') {
                const report = this.predictionAccountabilityQueryEngine.getEngineTrustScore('1.0');
                if (report) {
                    items.push(this.serializePredictionAccountability(report, score));
                }
            } else if (plan.queryType === 'runtime_intelligence') {
                const unhealthy = this.runtimeIntelligenceQueryEngine.getUnhealthyComponents();
                const patterns = this.runtimeIntelligenceQueryEngine.getRecentPatternIncreases();
                const files = this.runtimeIntelligenceQueryEngine.getFilesForDegradedComponents();
                const risks = this.runtimeIntelligenceQueryEngine.getRuntimeRisks();
                
                if (unhealthy.length > 0 || patterns.length > 0 || files.length > 0 || risks.length > 0) {
                    items.push(this.serializeRuntimeIntelligence(unhealthy, patterns, files, risks, score));
                }
            }
        } catch (e) {
            console.error(`RepositoryBrain broad query error:`, e);
        }

        return items;
    }

    // Mandatory Requirement 4: Terse Serialization
    private serializeDecisionOutcome(outcome: any, id: string, score: number): EvidenceItem {
        return {
            id: `brain_outcome_${id}`,
            file: id,
            startLine: 0, endLine: 0,
            role: 'docs',
            unitId: id,
            symbol: id,
            type: 'decision_outcome',
            content: `DECISION OUTCOME: ${id}\nStatus: ${outcome.outcomeType}\nOutcome Score: ${outcome.outcomeScore}/100\nHealth Trend: ${outcome.healthTrend}\nIncidents: ${outcome.incidentCount}\nReview Failures: ${outcome.reviewFailureCount}`,
            retrieval_signal: 'repository_brain_exact',
            semanticCategory: SemanticCategory.ARCHITECTURE,
            score: score,
            confidence: outcome.confidenceScore / 100,
            extractionMethod: 'repository_brain'
        };
    }

    private serializeCausalExplanation(exp: any, score: number): EvidenceItem {
        const factorsText = exp.factors ? exp.factors.map((f: any) => `- ${f.factorType}: ${f.factorDescription}`).join('\n') : 'Unknown';
        return {
            id: `brain_causal_${exp.entityId}`,
            file: exp.entityId,
            startLine: 0, endLine: 0,
            role: 'docs',
            unitId: exp.entityId,
            symbol: exp.entityId,
            type: 'causal_explanation',
            content: `CAUSAL ANALYSIS: ${exp.entityId}\nExplanation: ${exp.explanationText}\nFactors:\n${factorsText}`,
            retrieval_signal: 'repository_brain_exact',
            semanticCategory: SemanticCategory.ARCHITECTURE,
            score: score,
            confidence: exp.confidenceScore / 100,
            extractionMethod: 'repository_brain'
        };
    }

    private serializeHotspot(hotspot: any, id: string, score: number): EvidenceItem {
        return {
            id: `brain_hotspot_${id}`,
            file: id,
            startLine: 0, endLine: 0,
            role: 'docs',
            unitId: id,
            symbol: id,
            type: 'knowledge_hotspot',
            content: `KNOWLEDGE HOTSPOT: ${id}\nSeverity: ${hotspot.severity}\nScore: ${hotspot.hotspotScore}\nBus Factor: ${hotspot.busFactor}\nHealth Score: ${hotspot.healthScore}`,
            retrieval_signal: 'repository_brain_exact',
            semanticCategory: SemanticCategory.ARCHITECTURE,
            score: score,
            confidence: 0.9,
            extractionMethod: 'repository_brain'
        };
    }

    private serializeCoverageRisk(risk: any, id: string, score: number): EvidenceItem {
        return {
            id: `brain_risk_${id}`,
            file: id,
            startLine: 0, endLine: 0,
            role: 'docs',
            unitId: id,
            symbol: id,
            type: 'coverage_risk',
            content: `COVERAGE RISK: ${id}\nRisk Level: ${risk.riskLevel}\nRisk Score: ${risk.riskScore}`,
            retrieval_signal: 'repository_brain_exact',
            semanticCategory: SemanticCategory.ARCHITECTURE,
            score: score,
            confidence: 0.9,
            extractionMethod: 'repository_brain'
        };
    }

    private serializeList(id: string, title: string, items: string[], score: number): EvidenceItem {
        const listStr = items.length > 0 ? items.map(i => `- ${i}`).join('\n') : 'None found.';
        return {
            id: `brain_list_${id}`,
            file: 'Repository_Brain',
            startLine: 0, endLine: 0,
            role: 'docs',
            unitId: id,
            symbol: id,
            type: 'brain_summary',
            content: `REPOSITORY BRAIN SUMMARY: ${title}\n${listStr}`,
            retrieval_signal: 'repository_brain_broad',
            semanticCategory: SemanticCategory.ARCHITECTURE,
            score: score,
            confidence: 0.9,
            extractionMethod: 'repository_brain'
        };
    }

    private serializeChangeImpact(prediction: ChangeSetPrediction, target: string, score: number): EvidenceItem {
        const drivers = prediction.risk_drivers.map(d => `- ${d}`).join('\n');
        const reviewers = prediction.recommended_reviewers.map(r => `- ${r.author} (Expertise: ${r.expertise_score})`).join('\n');
        const incidents = prediction.expected_incident_types.map(i => `- ${i.incident_type} (${Math.round(i.probability * 100)}%)`).join('\n');
        
        let content = `CHANGE IMPACT PREDICTION: ${target}\n`;
        content += `Severity: ${prediction.severity}\n`;
        content += `Failure Probability: ${Math.round(prediction.failure_probability * 100)}%\n`;
        content += `Confidence: ${Math.round(prediction.confidence * 100)}%\n\n`;
        content += `Risk Drivers:\n${drivers}\n\n`;
        if (reviewers) content += `Recommended Reviewers:\n${reviewers}\n\n`;
        if (incidents) content += `Expected Incident Types:\n${incidents}\n`;

        return {
            id: `brain_change_impact_${Math.random().toString(36).substring(7)}`,
            file: 'Repository_Brain',
            startLine: 0, endLine: 0,
            role: 'docs',
            unitId: 'change_impact',
            symbol: 'change_impact',
            type: 'change_impact',
            content: content.trim(),
            retrieval_signal: 'repository_brain_broad',
            semanticCategory: SemanticCategory.ARCHITECTURE,
            score: score,
            confidence: prediction.confidence,
            extractionMethod: 'repository_brain'
        };
    }

    private serializePredictionAccountability(report: any, score: number): EvidenceItem {
        const trustStr = report.isTrustworthy ? 'HIGH' : 'LOW';
        let content = `PREDICTION ACCOUNTABILITY\n`;
        content += `Engine Version: 1.0\n`;
        content += `Brier Score: ${report.brierScore?.toFixed(2) ?? 'N/A'}\n`;
        content += `False Positive Rate: ${report.falsePositiveRate !== null ? Math.round(report.falsePositiveRate * 100) + '%' : 'N/A'}\n`;
        content += `False Negative Rate: ${report.falseNegativeRate !== null ? Math.round(report.falseNegativeRate * 100) + '%' : 'N/A'}\n`;
        content += `Incident Type Precision: ${report.incidentTypePrecision !== null ? Math.round(report.incidentTypePrecision * 100) + '%' : 'N/A'}\n`;
        content += `Trust Assessment:\n${trustStr}\n`;

        return {
            id: `brain_accountability_${Math.random().toString(36).substring(7)}`,
            file: 'Repository_Brain',
            startLine: 0, endLine: 0,
            role: 'docs',
            unitId: 'prediction_accountability',
            symbol: 'prediction_accountability',
            type: 'prediction_accountability',
            content: content.trim(),
            retrieval_signal: 'repository_brain_broad',
            semanticCategory: SemanticCategory.ARCHITECTURE,
            score: score,
            confidence: 1.0,
            extractionMethod: 'repository_brain'
        };
    }

    private serializeRuntimeIntelligence(unhealthy: any[], patterns: any[], files: any[], risks: any[], score: number): EvidenceItem {
        let content = `RUNTIME INTELLIGENCE\n\n`;
        
        if (unhealthy.length > 0) {
            content += `Unhealthy Components:\n`;
            for (const c of unhealthy) {
                content += `- Component: ${c.component_id} | Health Score: ${c.health_score} | Status: ${c.status} | Primary Driver: ${c.primary_driver}\n`;
            }
            content += '\n';
        }
        
        if (patterns.length > 0) {
            content += `Active Patterns:\n`;
            for (const p of patterns) {
                content += `- Component: ${p.component_id} | Pattern: ${p.pattern_type} | Frequency: ${p.frequency} | Status: ${p.status}\n`;
            }
            content += '\n';
        }
        
        if (files.length > 0) {
            content += `Impacted Files (Degraded/Critical Components):\n`;
            for (const f of files) {
                content += `- File: ${f.entity_id} (Component: ${f.component_id}, Status: ${f.status})\n`;
            }
            content += '\n';
        }
        
        if (risks.length > 0) {
            content += `Runtime Risks (Incident Factors):\n`;
            for (const r of risks) {
                content += `- Factor: ${r.factor_type} | Contribution Score: ${r.contribution_score}\n`;
            }
        }
        
        return {
            id: `brain_runtime_intelligence_${Math.random().toString(36).substring(7)}`,
            file: 'Repository_Brain',
            startLine: 0, endLine: 0,
            role: 'docs',
            unitId: 'runtime_intelligence',
            symbol: 'runtime_intelligence',
            type: 'runtime_intelligence' as any,
            content: content.trim(),
            retrieval_signal: 'repository_brain_broad',
            semanticCategory: SemanticCategory.ARCHITECTURE,
            score: score,
            confidence: 1.0,
            extractionMethod: 'repository_brain'
        };
    }
}
