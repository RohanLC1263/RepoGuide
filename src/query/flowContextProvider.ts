import { ComprehensionEngine } from '../comprehension/comprehensionEngine';
import { BehavioralPathSearcher } from '../comprehension/behavioralPathSearcher';
import { UnderstandingHealthService } from '../comprehension/understandingHealthService';
import { FlowContextBuilder } from './flowContextBuilder';
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

/**
 * Surfaces CallGraphBuilderV2's traced execution flow (via FlowContextBuilder)
 * as evidence items. The FlowExtractor is fetched fresh from
 * ComprehensionEngine on every retrieve() call rather than captured once at
 * construction, so this provider automatically starts returning real data
 * once the deferred comprehension job finishes -- no restart needed.
 */
export class FlowContextProvider implements EvidenceProvider {
    readonly id = 'flow_context';
    readonly kind = 'flow_context' as const;
    readonly capabilities: EvidenceProviderCapabilities = {
        evidenceTypes: ['flow_trace'],
        // 'repository_exploration' included alongside the three named categories:
        // measured against real questions ("Trace the execution flow when...",
        // "How does the cache logic work...") rather than assumed -- the live
        // regex planner (evidencePlanner.ts) classifies this exact shape of
        // question as queryType 'behavior_explanation' (or 'unknown'), and
        // mapQueryTypeToCategory() has no dedicated case for either, so both
        // fall through to 'repository_exploration'. Without this, the provider
        // would work correctly in isolation but never actually fire for the
        // real-world questions this wiring exists to serve.
        queryCategories: ['dependency_analysis', 'architectural_reasoning', 'debugging', 'repository_exploration'],
        supportsFreshness: false,
        supportsProvenance: true
    };

    private initialized = false;

    constructor(
        private readonly comprehensionEngine: ComprehensionEngine,
        private readonly behavioralPathSearcher: BehavioralPathSearcher | undefined,
        private readonly healthService: UnderstandingHealthService | undefined
    ) {}

    async initialize(_context: ProviderContext): Promise<ProviderInitResult> {
        this.initialized = true;
        const ready = this.comprehensionEngine.getFlowExtractor() !== null;
        return { ready, diagnostics: ready ? [] : [{ level: 'warn', providerId: this.id, message: 'Call graph not yet built; flow context unavailable until the next comprehension pass.' }] };
    }

    async health(): Promise<ProviderHealth> {
        if (!this.initialized) {
            return { status: 'degraded', diagnostics: [{ level: 'warn', providerId: this.id, message: 'FlowContextProvider has not been initialized.' }] };
        }
        const ready = this.comprehensionEngine.getFlowExtractor() !== null;
        return {
            status: ready ? 'ready' : 'degraded',
            diagnostics: ready ? [] : [{ level: 'warn', providerId: this.id, message: 'Call graph not yet built.' }]
        };
    }

    async readiness(): Promise<ProviderReadinessStatus> {
        if (!this.initialized) {
            return { status: 'FAILED', diagnostics: [{ level: 'warn', providerId: this.id, message: 'FlowContextProvider has not been initialized.' }], backingArtifacts: ['call_graph_v1'] };
        }
        const ready = this.comprehensionEngine.getFlowExtractor() !== null;
        return {
            status: ready ? 'READY' : 'EMPTY',
            diagnostics: ready ? [] : [{ level: 'warn', providerId: this.id, message: 'Call graph is empty or not yet built.' }],
            backingArtifacts: ['call_graph_v1']
        };
    }

    canHandle(request: EvidenceProviderRequest): ProviderDecision {
        if (!request.retrievalPlan.providerIds.includes(this.id)) {
            return { canHandle: false, reason: 'Provider was not selected by the execution plan.' };
        }
        if (!this.capabilities.queryCategories.includes(request.category)) {
            return { canHandle: false, reason: `FlowContextProvider does not handle ${request.category}.` };
        }
        if (this.comprehensionEngine.getFlowExtractor() === null) {
            return { canHandle: false, reason: 'Call graph not yet built; flow context unavailable.' };
        }
        return { canHandle: true };
    }

    async retrieve(request: EvidenceProviderRequest): Promise<EvidenceProviderResponse> {
        const startedAt = performance.now();
        try {
            const builder = new FlowContextBuilder(
                this.comprehensionEngine.getFlowExtractor(),
                this.behavioralPathSearcher,
                this.healthService
            );
            const enriched = builder.build(request.query, true);
            const items = enriched.flowContext
                ? enriched.flowContext.contextBlocks.slice(0, request.limits.maxItems).map(block => flowBlockToEvidenceItem(block, this.id, enriched.reliability.source))
                : [];

            return {
                providerId: this.id,
                status: items.length > 0 ? 'success' : 'empty',
                items,
                diagnostics: [{
                    level: 'info',
                    providerId: this.id,
                    message: `FlowContextProvider returned ${items.length} flow-trace items (source: ${enriched.reliability.source}, completeness: ${enriched.reliability.completeness}).`
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
                diagnostics: [{ level: 'error', providerId: this.id, message: error instanceof Error ? error.message : String(error) }],
                metadata: { latencyMs: performance.now() - startedAt, sourceCount: 0 }
            };
        }
    }

    async shutdown(): Promise<void> {
        this.initialized = false;
    }
}

function flowBlockToEvidenceItem(
    block: { filePath: string; functionName: string; startLine: number; endLine: number; bodyPreview: string; callsNext: string; depth: number },
    providerId: string,
    source: string
): EvidenceItem {
    const confidence = source === 'call_graph' ? 0.9 : source === 'merged' ? 0.75 : 0.6;
    return withNormalizedEvidenceFields({
        id: `${providerId}_${block.filePath}_${block.functionName}_${block.depth}`,
        file: block.filePath,
        startLine: block.startLine,
        endLine: block.endLine,
        role: 'implementation',
        symbol: block.functionName,
        type: 'flow_trace',
        content: `Traced execution step (depth ${block.depth}): ${block.functionName}()\nFile: ${block.filePath}\n${block.bodyPreview}\nNext: ${block.callsNext}`,
        retrieval_signal: 'flow_trace',
        semanticCategory: SemanticCategory.BEHAVIOR,
        score: confidence,
        confidence,
        extractionMethod: 'flow_context'
    }, {
        providerId,
        evidenceType: 'flow_trace',
        freshness: 'unknown',
        provenance: {
            providerId,
            source: 'FlowContextBuilder',
            sourceId: `${block.filePath}:${block.functionName}`,
            sourceType: 'flow_trace',
            confidence,
            metadata: { depth: block.depth, flowSource: source }
        },
        canonicalSource: {
            providerId,
            file: block.filePath,
            startLine: block.startLine,
            endLine: block.endLine,
            symbol: block.functionName,
            sourceType: 'flow_trace'
        }
    });
}
