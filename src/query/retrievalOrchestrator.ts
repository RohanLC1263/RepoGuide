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
        /** Per-provider wall time (ms), including canHandle + retrieve. Diagnostic. */
        providerTimings: Array<{ id: string; ms: number }>;
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
        const providerTimings: Array<{ id: string; ms: number }> = [];

        for (const provider of this.providers) {
            const providerStartedAt = performance.now();
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
                providerTimings.push({ id: provider.id, ms: performance.now() - providerStartedAt });
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
            providerTimings.push({ id: provider.id, ms: performance.now() - providerStartedAt });
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
                providersFailed,
                providerTimings
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

/**
 * Interleaves each provider's own already-ranked item list (round-robin,
 * one item per provider per pass) and truncates to `cap` -- built for
 * QueryDispatcher.retrieveRawEvidence(), whose only production callers are
 * the MCP raw-evidence/get_dependents/get_facts tools. Deliberately NOT
 * folded into execute() itself, which chat/investigationEngine/planAnalyzer/
 * doc-report generation also call for answer-synthesis packet building --
 * their token-budgeted selection logic must not be affected by a cap meant
 * only to bound MCP tool output size.
 *
 * Round-robin, not a global re-sort: each provider already returns its
 * items in its own relevance order (e.g. FactStoreProvider sorts by score
 * before slicing), and there is no shared score scale across providers to
 * sort by without inventing new cross-provider ranking -- explicitly out of
 * scope. A duplicate id (the same evidence surfaced by two providers) is
 * kept only on its first occurrence in interleave order; the list position
 * still advances past it either way, so one provider's duplicates can't
 * stall another provider's turn.
 */
export function interleaveAndCapEvidence(
    providerResults: EvidenceProviderResponse[],
    cap: number
): EvidenceItem[] {
    const lists = providerResults.map(result => result.items);
    const cursors = new Array(lists.length).fill(0);
    const seen = new Set<string>();
    const output: EvidenceItem[] = [];

    let anyRemaining = true;
    while (output.length < cap && anyRemaining) {
        anyRemaining = false;
        for (let i = 0; i < lists.length; i++) {
            if (output.length >= cap) {
                break;
            }
            const list = lists[i];
            if (cursors[i] >= list.length) {
                continue;
            }
            anyRemaining = true;
            const item = list[cursors[i]++];
            if (seen.has(item.id)) {
                continue;
            }
            seen.add(item.id);
            output.push(item);
        }
    }
    return output;
}
