import { RepositoryBrain } from './repositoryBrain';
import { RepositoryKnowledge, RepositoryKnowledgeType } from './repositoryKnowledgeTypes';
import { EvidenceItem, SemanticCategory } from './evidencePacket';
import { withNormalizedEvidenceFields } from './normalizedEvidence';
import {
    EvidenceProvider,
    EvidenceProviderCapabilities,
    EvidenceProviderRequest,
    EvidenceProviderResponse,
    ProviderContext,
    ProviderDecision,
    ProviderHealth,
    ProviderInitResult,
    ProviderReadinessStatus
} from './retrievalProvider';

export class RepositoryBrainProvider implements EvidenceProvider {
    readonly id = 'repository_brain';
    readonly kind = 'repository_brain' as const;
    readonly capabilities: EvidenceProviderCapabilities = {
        evidenceTypes: [
            'decision_outcome',
            'causal_explanation',
            'change_impact',
            'runtime_mapping',
            'incident_pattern',
            'knowledge_hotspot',
            'coverage_risk',
            'prediction_accountability',
            'developer_note',
            'ownership_expertise',
            'dependency_insight',
            'module_summary',
            'repository_pattern'
        ],
        queryCategories: [
            'architectural_reasoning',
            'debugging',
            'investigation',
            'engineering_decision_support',
            'multi_step_reasoning'
        ],
        supportsFreshness: true,
        supportsProvenance: true
    };

    private initialized = false;

    constructor(private readonly brain: RepositoryBrain) {}

    async initialize(_context: ProviderContext): Promise<ProviderInitResult> {
        this.initialized = true;
        return { ready: true, diagnostics: [] };
    }

    async health(): Promise<ProviderHealth> {
        return {
            status: this.initialized ? 'ready' : 'degraded',
            diagnostics: this.initialized ? [] : [{
                level: 'warn',
                providerId: this.id,
                message: 'RepositoryBrainProvider has not been initialized.'
            }]
        };
    }

    async readiness(): Promise<ProviderReadinessStatus> {
        return {
            status: this.initialized ? 'PARTIAL' : 'FAILED',
            diagnostics: this.initialized
                ? [{ level: 'info', providerId: this.id, message: 'RepositoryBrain is initialized; record counts are reported by repository readiness.' }]
                : [{ level: 'warn', providerId: this.id, message: 'RepositoryBrainProvider has not been initialized.' }],
            backingArtifacts: ['repository_brain']
        };
    }

    canHandle(request: EvidenceProviderRequest): ProviderDecision {
        if (!request.retrievalPlan.providerIds.includes(this.id)) {
            return { canHandle: false, reason: 'Provider was not selected by the execution plan.' };
        }
        if (!this.capabilities.queryCategories.includes(request.category)) {
            return { canHandle: false, reason: `RepositoryBrainProvider does not handle ${request.category}.` };
        }
        return { canHandle: true };
    }

    async retrieve(request: EvidenceProviderRequest): Promise<EvidenceProviderResponse> {
        const startedAt = performance.now();
        const plan = request.intelligencePlan;
        if (!plan || !plan.enabled) {
            return {
                providerId: this.id,
                status: 'empty',
                items: [],
                diagnostics: [{
                    level: 'info',
                    providerId: this.id,
                    message: 'RepositoryIntelligencePlan was not enabled for this request.'
                }],
                metadata: { latencyMs: performance.now() - startedAt, sourceCount: 0 }
            };
        }

        try {
            const knowledgeTypes = (plan.knowledgeTypes.length > 0
                ? plan.knowledgeTypes
                : this.capabilities.evidenceTypes) as RepositoryKnowledgeType[];
            const result = await this.brain.query({
                knowledgeTypes,
                subjects: plan.subjects,
                query: request.query,
                requireValidated: plan.requireValidated,
                includeStale: plan.includeStale,
                maxItems: plan.maxItems > 0 ? plan.maxItems : request.limits.maxItems
            });

            const items = result.items.map(k => normalizeBrainKnowledge(k, this.id));
            return {
                providerId: this.id,
                status: items.length > 0 ? 'success' : 'empty',
                items,
                diagnostics: [
                    { level: 'info', providerId: this.id, message: `RepositoryBrainProvider returned ${items.length} evidence items.` },
                    ...result.diagnostics.map(message => ({ level: 'info' as const, providerId: this.id, message }))
                ],
                metadata: { latencyMs: performance.now() - startedAt, sourceCount: items.length }
            };
        } catch (error) {
            return {
                providerId: this.id,
                status: 'failed',
                items: [],
                diagnostics: [{
                    level: 'error',
                    providerId: this.id,
                    message: error instanceof Error ? error.message : String(error)
                }],
                metadata: { latencyMs: performance.now() - startedAt, sourceCount: 0 }
            };
        }
    }

    async shutdown(): Promise<void> {
        this.initialized = false;
    }
}

function normalizeBrainKnowledge(knowledge: RepositoryKnowledge, providerId: string): EvidenceItem {
    const confidence = knowledge.confidence.score / 100;
    const item: EvidenceItem = {
        id: knowledge.id,
        file: knowledge.subject.file ?? knowledge.subject.id,
        startLine: 0,
        endLine: 0,
        role: 'docs',
        symbol: knowledge.subject.symbol,
        type: knowledge.type,
        content: knowledge.claim.text,
        retrieval_signal: 'repository_brain',
        semanticCategory: SemanticCategory.ARCHITECTURE,
        score: confidence,
        confidence,
        extractionMethod: 'repository_brain',
        stale: knowledge.lifecycleState === 'stale'
    };
    return withNormalizedEvidenceFields(item, {
        providerId,
        evidenceType: knowledge.type,
        freshness: knowledge.freshness.state,
        provenance: {
            providerId,
            source: 'RepositoryBrain',
            sourceId: knowledge.id,
            sourceType: knowledge.type,
            confidence: knowledge.confidence.score,
            metadata: {
                repositoryKnowledgeIds: [knowledge.id],
                sourceArtifacts: knowledge.provenance.sourceArtifacts,
                producedBy: knowledge.provenance.producedBy,
                lifecycleState: knowledge.lifecycleState
            }
        },
        canonicalSource: {
            providerId,
            file: knowledge.subject.file ?? knowledge.subject.id,
            startLine: 0,
            endLine: 0,
            symbol: knowledge.subject.symbol,
            sourceId: knowledge.id,
            sourceType: knowledge.type
        }
    });
}
