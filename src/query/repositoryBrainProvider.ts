import { RepositoryBrainEvidenceStore } from './repositoryBrainEvidenceStore';
import { EvidencePlan } from './evidencePlanTypes';
import { EvidenceItem } from './evidencePacket';
import { confidenceToNumber, withNormalizedEvidenceFields } from './normalizedEvidence';
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

    constructor(private readonly brainStore: RepositoryBrainEvidenceStore) {}

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
            diagnostics: this.initialized ? [{ level: 'info', providerId: this.id, message: 'RepositoryBrain compatibility adapter is initialized; store population is reported by repository readiness.' }] : [{ level: 'warn', providerId: this.id, message: 'RepositoryBrainProvider has not been initialized.' }],
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
        const evidencePlan = request.diagnosticsContext?.evidencePlan as EvidencePlan | undefined;
        if (!evidencePlan) {
            return {
                providerId: this.id,
                status: 'failed',
                items: [],
                diagnostics: [{
                    level: 'error',
                    providerId: this.id,
                    message: 'RepositoryBrainProvider requires compatibility EvidencePlan until RepositoryBrain retrieval is fully contract-native.'
                }],
                metadata: {
                    latencyMs: performance.now() - startedAt,
                    sourceCount: 0
                }
            };
        }

        try {
            const items = this.brainStore.execute(evidencePlan).map(item => normalizeBrainItem(item, this.id));
            return {
                providerId: this.id,
                status: items.length > 0 ? 'success' : 'empty',
                items,
                diagnostics: [{
                    level: 'info',
                    providerId: this.id,
                    message: `RepositoryBrainProvider returned ${items.length} evidence items.`
                }],
                metadata: {
                    latencyMs: performance.now() - startedAt,
                    sourceCount: items.length
                }
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
                metadata: {
                    latencyMs: performance.now() - startedAt,
                    sourceCount: 0
                }
            };
        }
    }

    async shutdown(): Promise<void> {
        this.initialized = false;
    }
}
function normalizeBrainItem(item: EvidenceItem, providerId: string): EvidenceItem {
    const startLine = item.startLine ?? 0;
    const endLine = item.endLine ?? startLine;
    return withNormalizedEvidenceFields(item, {
        providerId,
        evidenceType: item.type,
        freshness: item.stale ? 'stale' : 'unknown',
        provenance: {
            providerId,
            source: 'RepositoryBrainEvidenceStore',
            sourceId: item.id,
            sourceType: item.type,
            confidence: item.confidence,
            metadata: {
                retrievalSignal: item.retrieval_signal,
                extractionMethod: item.extractionMethod,
                score: item.score
            }
        },
        canonicalSource: {
            providerId,
            file: item.file,
            startLine,
            endLine,
            symbol: item.symbol,
            sourceId: item.id,
            sourceType: item.type
        }
    });
}