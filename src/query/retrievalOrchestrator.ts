import { EvidenceItem } from './evidencePacket';
import { ExecutionPlan } from './executionPlanner';
import {
    EvidenceGap,
    EvidenceProvider,
    EvidenceProviderRequest,
    EvidenceProviderResponse,
    ProviderDiagnostic
} from './retrievalProvider';

export { EvidenceGap };

export interface EvidenceCoverage {
    required: number;
    matched: number;
}

export interface RetrievalDiagnostic {
    level: 'info' | 'warn' | 'error';
    message: string;
    providerId?: string;
}

export interface RetrievalOrchestrationResult {
    planId: string;
    items: EvidenceItem[];
    providerResults: EvidenceProviderResponse[];
    gaps: EvidenceGap[];
    coverage: EvidenceCoverage;
    diagnostics: RetrievalDiagnostic[];
    metadata: {
        latencyMs: number;
        providersInvoked: string[];
        providersSkipped: string[];
        providersFailed: string[];
    };
}

export class RetrievalOrchestrator {
    constructor(private readonly providers: EvidenceProvider[]) {}

    async execute(plan: ExecutionPlan): Promise<RetrievalOrchestrationResult> {
        const startedAt = performance.now();
        const providerResults: EvidenceProviderResponse[] = [];
        const diagnostics: RetrievalDiagnostic[] = [];
        const providersInvoked: string[] = [];
        const providersSkipped: string[] = [];
        const providersFailed: string[] = [];

        for (const provider of this.providers) {
            const request: EvidenceProviderRequest = {
                requestId: plan.requestId,
                planId: plan.planId,
                query: plan.query,
                category: plan.category,
                retrievalPlan: plan.retrievalPlan,
                intelligencePlan: plan.intelligencePlan,
                targets: {
                    symbols: plan.retrievalPlan.targetSymbols,
                    files: plan.retrievalPlan.targetFiles,
                    concepts: plan.retrievalPlan.targetConcepts
                },
                limits: {
                    maxItems: plan.retrievalPlan.maxItems,
                    maxLatencyMs: plan.retrievalPlan.maxLatencyMs
                },
                freshnessPolicy: plan.freshnessPolicy,
                diagnosticsContext: {
                    evidencePlan: plan.evidencePlan
                }
            };

            const decision = provider.canHandle(request);
            if (!decision.canHandle) {
                providersSkipped.push(provider.id);
                diagnostics.push({
                    level: 'info',
                    providerId: provider.id,
                    message: decision.reason ?? 'Provider skipped.'
                });
                continue;
            }

            providersInvoked.push(provider.id);
            try {
                const result = await provider.retrieve(request);
                providerResults.push(result);
                diagnostics.push(...result.diagnostics.map(toRetrievalDiagnostic));
                if (result.status === 'failed' || result.status === 'timeout') {
                    providersFailed.push(provider.id);
                }
            } catch (error) {
                providersFailed.push(provider.id);
                diagnostics.push({
                    level: 'error',
                    providerId: provider.id,
                    message: error instanceof Error ? error.message : String(error)
                });
            }
        }

        const items = dedupeEvidence(providerResults.flatMap(result => result.items));
        const matched = plan.evidenceRequirements.filter(req =>
            items.some(item => item.type === req.type || item.retrieval_signal === req.type)
        ).length;
        const gaps = providerResults.flatMap(result => result.gaps ?? []);

        return {
            planId: plan.planId,
            items,
            providerResults,
            gaps,
            coverage: {
                required: plan.evidenceRequirements.length,
                matched
            },
            diagnostics,
            metadata: {
                latencyMs: performance.now() - startedAt,
                providersInvoked,
                providersSkipped,
                providersFailed
            }
        };
    }
}

function toRetrievalDiagnostic(diagnostic: ProviderDiagnostic): RetrievalDiagnostic {
    return {
        level: diagnostic.level,
        providerId: diagnostic.providerId,
        message: diagnostic.message
    };
}

function dedupeEvidence(items: EvidenceItem[]): EvidenceItem[] {
    const byId = new Map<string, EvidenceItem>();
    for (const item of items) {
        const existing = byId.get(item.id);
        if (!existing || item.score > existing.score) {
            byId.set(item.id, item);
        }
    }
    return Array.from(byId.values());
}
