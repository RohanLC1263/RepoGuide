import { LanceStore } from '../store/lanceStore';
import { CodeChunk } from '../store/storeTypes';
import { EvidenceItem, SemanticCategory } from './evidencePacket';
import { withNormalizedEvidenceFields } from './normalizedEvidence';
import { embedText } from '../ollama/embedder';
import { RepositoryContext } from '../context/repositoryContext';
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
 * First-class EvidenceProvider wrapping LanceStore directly (previously only reachable
 * indirectly through HybridRetrievalFusion's ad hoc API — ARCHITECTURE_CONFORMANCE_REPORT
 * check 3). Serves two request shapes:
 *  - category === 'documentation': whole-repo, folder-bucketed sampling (moved from
 *    docReportPanel.ts's inline logic) — this is a normalized-field branch (category), not
 *    a provider-identity branch, so it doesn't violate the "no provider-specific
 *    branching" rule.
 *  - everything else: standard embed-and-search vector retrieval.
 */
export class LanceStoreProvider implements EvidenceProvider {
    readonly id = 'lance_store';
    readonly kind = 'vector_store' as const;
    readonly capabilities: EvidenceProviderCapabilities = {
        evidenceTypes: ['vector_chunk', 'documentation_sample'],
        queryCategories: [
            'factual_lookup',
            'symbol_lookup',
            'repository_exploration',
            'documentation',
            'multi_step_reasoning'
        ],
        supportsFreshness: false,
        supportsProvenance: true
    };

    private initialized = false;

    constructor(private readonly store: LanceStore, private context?: RepositoryContext) {}

    async initialize(context: ProviderContext): Promise<ProviderInitResult> {
        this.context = context.repositoryContext;
        this.initialized = true;
        return { ready: true, diagnostics: [] };
    }

    async health(): Promise<ProviderHealth> {
        return {
            status: this.initialized ? 'ready' : 'degraded',
            diagnostics: this.initialized ? [] : [{ level: 'warn', providerId: this.id, message: 'LanceStoreProvider has not been initialized.' }]
        };
    }

    async readiness(): Promise<ProviderReadinessStatus> {
        if (!this.initialized) {
            return { status: 'FAILED', diagnostics: [{ level: 'warn', providerId: this.id, message: 'LanceStoreProvider has not been initialized.' }], backingArtifacts: ['lance_chunks'] };
        }
        const count = await this.store.getChunkCount();
        return {
            status: count > 0 ? 'READY' : 'EMPTY',
            diagnostics: count > 0 ? [] : [{ level: 'warn', providerId: this.id, message: 'LanceStore is empty.' }],
            backingArtifacts: ['lance_chunks'],
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
            const items = request.category === 'documentation'
                ? await this.retrieveDocumentationSample(request)
                : await this.retrieveByVector(request);
            return {
                providerId: this.id,
                status: items.length > 0 ? 'success' : 'empty',
                items,
                diagnostics: [{ level: 'info', providerId: this.id, message: `LanceStoreProvider returned ${items.length} items.` }],
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

    /** Folder-bucketed whole-repo sample, moved verbatim (in spirit) from docReportPanel.ts. */
    private async retrieveDocumentationSample(request: EvidenceProviderRequest): Promise<EvidenceItem[]> {
        const allPaths = await this.store.getAllFilePaths();
        const chunksByFolder = new Map<string, CodeChunk[]>();

        for (const filePath of allPaths) {
            const normalized = filePath.replace(/\\/g, '/');
            const folder = normalized.split('/')[0] || normalized;
            let chunks: CodeChunk[] = [];
            try {
                chunks = await this.store.getChunksByFile(filePath);
            } catch {
                continue;
            }
            if (chunks.length === 0) continue;
            const existing = chunksByFolder.get(folder) ?? [];
            existing.push(...chunks.slice(0, 3));
            chunksByFolder.set(folder, existing.slice(0, 5));
        }

        const items: EvidenceItem[] = [];
        for (const [, chunks] of chunksByFolder.entries()) {
            for (const chunk of chunks.slice(0, request.limits.maxItems)) {
                items.push(chunkToEvidenceItem(chunk, this.id, 'documentation_sample'));
            }
        }
        return items;
    }

    private async retrieveByVector(request: EvidenceProviderRequest): Promise<EvidenceItem[]> {
        if (!this.context) return [];
        const vector = await embedText(this.context, request.query);
        const chunks = await this.store.queryByVector(vector, request.limits.maxItems || 10);
        return chunks.map(chunk => chunkToEvidenceItem(chunk, this.id, 'vector_chunk'));
    }
}

function chunkToEvidenceItem(chunk: CodeChunk, providerId: string, type: string): EvidenceItem {
    return withNormalizedEvidenceFields({
        id: `lance_${chunk.id}`,
        file: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        role: inferRole(chunk.filePath),
        type,
        content: chunk.text,
        retrieval_signal: type,
        semanticCategory: SemanticCategory.GENERAL,
        score: 0.75,
        confidence: 0.75,
        extractionMethod: 'lance_store'
    }, {
        providerId,
        evidenceType: type,
        freshness: 'unknown',
        provenance: {
            providerId,
            source: 'LanceStore',
            sourceId: chunk.id,
            sourceType: 'code_chunk',
            confidence: 0.75,
            metadata: { language: chunk.language, hash: chunk.hash }
        },
        canonicalSource: {
            providerId,
            file: chunk.filePath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            sourceId: chunk.id,
            sourceType: 'code_chunk'
        }
    });
}

function inferRole(filePath: string): EvidenceItem['role'] {
    if (/test|spec|mock|fixture/i.test(filePath)) return 'test';
    if (/dist|out|build|generated|node_modules/i.test(filePath)) return 'generated';
    return 'implementation';
}
