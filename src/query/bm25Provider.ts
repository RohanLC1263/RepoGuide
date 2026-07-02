import { Bm25Store } from '../store/bm25Store';
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
 * First-class EvidenceProvider wrapping the chunk-level Bm25Store directly (previously
 * only reachable indirectly through HybridRetrievalFusion.searchBm25Evidence() —
 * ARCHITECTURE_CONFORMANCE_REPORT check 3). This is the chunk-level BM25 index used by
 * HybridRetrievalFusion, distinct from LogicalUnitBm25Store (already wrapped as part of
 * the symbol/unit-level retrieval EvidencePacketBuilder does directly).
 */
export class BM25Provider implements EvidenceProvider {
    readonly id = 'bm25_store';
    readonly kind = 'bm25' as const;
    readonly capabilities: EvidenceProviderCapabilities = {
        evidenceTypes: ['bm25_chunk'],
        queryCategories: [
            'factual_lookup',
            'symbol_lookup',
            'repository_exploration',
            'investigation',
            'multi_step_reasoning'
        ],
        supportsFreshness: false,
        supportsProvenance: true
    };

    private initialized = false;

    constructor(private readonly store: Bm25Store) {}

    async initialize(_context: ProviderContext): Promise<ProviderInitResult> {
        this.initialized = true;
        return { ready: true, diagnostics: [] };
    }

    async health(): Promise<ProviderHealth> {
        return {
            status: this.initialized ? 'ready' : 'degraded',
            diagnostics: this.initialized ? [] : [{ level: 'warn', providerId: this.id, message: 'BM25Provider has not been initialized.' }]
        };
    }

    async readiness(): Promise<ProviderReadinessStatus> {
        if (!this.initialized) {
            return { status: 'FAILED', diagnostics: [{ level: 'warn', providerId: this.id, message: 'BM25Provider has not been initialized.' }], backingArtifacts: ['bm25_index'] };
        }
        const count = await this.store.getChunkCount();
        return {
            status: count > 0 ? 'READY' : 'EMPTY',
            diagnostics: count > 0 ? [] : [{ level: 'warn', providerId: this.id, message: 'BM25 index is empty.' }],
            backingArtifacts: ['bm25_index'],
            recordCount: count
        };
    }

    canHandle(request: EvidenceProviderRequest): ProviderDecision {
        if (!request.retrievalPlan.providerIds.includes(this.id)) {
            return { canHandle: false, reason: 'Provider was not selected by the execution plan.' };
        }
        return { canHandle: true };
    }

    async retrieve(request: EvidenceProviderRequest): Promise<EvidenceProviderResponse> {
        const startedAt = performance.now();
        try {
            const results = await this.store.search(request.query, request.limits.maxItems || 10);
            const items = results.map(result => withNormalizedEvidenceFields({
                id: `bm25_${result.id}`,
                file: result.filePath,
                startLine: 0,
                endLine: 0,
                role: inferRole(result.filePath),
                type: 'bm25_chunk',
                content: result.text,
                retrieval_signal: 'bm25',
                semanticCategory: SemanticCategory.GENERAL,
                score: result.score > 10 ? 0.9 : result.score > 0 ? 0.7 : 0.5,
                confidence: 0.7,
                extractionMethod: 'bm25_store'
            }, {
                providerId: this.id,
                evidenceType: 'bm25_chunk',
                freshness: 'unknown',
                provenance: {
                    providerId: this.id,
                    source: 'Bm25Store',
                    sourceId: result.id,
                    sourceType: 'code_chunk',
                    confidence: 0.7,
                    metadata: { bm25Score: result.score }
                },
                canonicalSource: {
                    providerId: this.id,
                    file: result.filePath,
                    startLine: 0,
                    endLine: 0,
                    sourceId: result.id,
                    sourceType: 'code_chunk'
                }
            }));
            return {
                providerId: this.id,
                status: items.length > 0 ? 'success' : 'empty',
                items,
                diagnostics: [{ level: 'info', providerId: this.id, message: `BM25Provider returned ${items.length} chunks.` }],
                metadata: { latencyMs: performance.now() - startedAt, sourceCount: items.length }
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

function inferRole(filePath: string): EvidenceItem['role'] {
    if (/test|spec|mock|fixture/i.test(filePath)) return 'test';
    if (/dist|out|build|generated|node_modules/i.test(filePath)) return 'generated';
    return 'implementation';
}
