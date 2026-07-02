import { LogicalUnitRole } from '../indexing/logicalUnitTypes';
import { HybridContextAssembly, HybridRetrievalFusion } from './hybridRetrievalFusion';
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

export interface HybridRetrievalProviderOptions {
    emitEvidenceItems?: boolean;
}

export class HybridRetrievalProvider implements EvidenceProvider {
    readonly id = 'hybrid_retrieval';
    readonly kind = 'hybrid_retrieval' as const;
    readonly capabilities: EvidenceProviderCapabilities = {
        evidenceTypes: ['hybrid_chunk', 'annotation', 'community_summary'],
        queryCategories: [
            'factual_lookup',
            'symbol_lookup',
            'dependency_analysis',
            'architectural_reasoning',
            'debugging',
            'investigation',
            'explain_selection',
            'documentation',
            'repository_exploration',
            'engineering_decision_support',
            'multi_step_reasoning'
        ],
        supportsFreshness: false,
        supportsProvenance: true
    };

    private initialized = false;

    constructor(
        private readonly fusion: HybridRetrievalFusion,
        private readonly options: HybridRetrievalProviderOptions = {}
    ) {}

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
                message: 'HybridRetrievalProvider has not been initialized.'
            }]
        };
    }

    async readiness(): Promise<ProviderReadinessStatus> {
        return {
            status: this.initialized ? 'READY' : 'FAILED',
            diagnostics: this.initialized ? [] : [{ level: 'warn', providerId: this.id, message: 'HybridRetrievalProvider has not been initialized.' }],
            backingArtifacts: ['lance_chunks', 'bm25']
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
        const assembly = await this.fusion.retrieveContext(
            request.query,
            request.targets.files
        );

        const items = this.options.emitEvidenceItems
            ? assemblyToEvidenceItems(assembly)
            : [];

        return {
            providerId: this.id,
            status: items.length > 0 || assembly.chunks.length > 0 ? 'success' : 'empty',
            items,
            diagnostics: [{
                level: 'info',
                providerId: this.id,
                message: `Hybrid retrieval returned ${assembly.chunks.length} chunks, ${assembly.annotations.length} annotations, and ${assembly.communities.length} communities.`
            }],
            metadata: {
                latencyMs: performance.now() - startedAt,
                sourceCount: assembly.chunks.length + assembly.annotations.length + assembly.communities.length,
                raw: assembly
            }
        };
    }

    async retrieveRawContext(query: string, seedFiles: string[] = []): Promise<HybridContextAssembly> {
        return this.fusion.retrieveContext(query, seedFiles);
    }

    async shutdown(): Promise<void> {
        this.initialized = false;
    }
}

function assemblyToEvidenceItems(assembly: HybridContextAssembly): EvidenceItem[] {
    const items: EvidenceItem[] = [];
    for (const fused of assembly.chunks) {
        items.push(withNormalizedEvidenceFields({
            id: `hybrid_${fused.chunk.id}`,
            file: fused.chunk.filePath,
            startLine: fused.chunk.startLine,
            endLine: fused.chunk.endLine,
            role: inferRole(fused.chunk.filePath),
            type: 'hybrid_chunk',
            content: fused.chunk.text,
            retrieval_signal: 'hybrid_retrieval',
            semanticCategory: SemanticCategory.GENERAL,
            score: fused.score,
            confidence: 0.8,
            extractionMethod: 'hybrid_retrieval'
        }, {
            providerId: 'hybrid_retrieval',
            evidenceType: 'hybrid_chunk',
            freshness: 'unknown',
            provenance: {
                providerId: 'hybrid_retrieval',
                source: 'HybridRetrievalFusion',
                sourceId: fused.chunk.id,
                sourceType: 'code_chunk',
                confidence: 0.8,
                metadata: {
                    language: fused.chunk.language,
                    hash: fused.chunk.hash,
                    fusedScore: fused.score,
                    rank: fused.rank
                }
            },
            canonicalSource: {
                providerId: 'hybrid_retrieval',
                file: fused.chunk.filePath,
                startLine: fused.chunk.startLine,
                endLine: fused.chunk.endLine,
                sourceId: fused.chunk.id,
                sourceType: 'code_chunk'
            }
        }));
    }

    for (const annotation of assembly.annotations) {
        items.push(withNormalizedEvidenceFields({
            id: `hybrid_annotation_${annotation.file}`,
            file: annotation.file,
            startLine: 1,
            endLine: 1,
            role: inferRole(annotation.file),
            type: 'annotation',
            content: annotation.what,
            retrieval_signal: 'hybrid_annotation',
            semanticCategory: SemanticCategory.ARCHITECTURE,
            score: confidenceScore(annotation.confidence),
            confidence: annotation.confidence,
            extractionMethod: 'hybrid_retrieval'
        }, {
            providerId: 'hybrid_retrieval',
            evidenceType: 'annotation',
            freshness: 'unknown',
            provenance: {
                providerId: 'hybrid_retrieval',
                source: 'HybridRetrievalFusion',
                sourceId: annotation.file,
                sourceType: 'file_annotation',
                confidence: annotation.confidence,
                metadata: {
                    generatedAt: annotation.generated_at,
                    hash: annotation.hash,
                    role: annotation.role,
                    keySymbols: annotation.key_symbols,
                    dependsOn: annotation.depends_on,
                    signals: annotation.signals
                }
            },
            canonicalSource: {
                providerId: 'hybrid_retrieval',
                file: annotation.file,
                startLine: 1,
                endLine: 1,
                sourceId: annotation.file,
                sourceType: 'file_annotation'
            }
        }));
    }

    for (const community of assembly.communities) {
        items.push(withNormalizedEvidenceFields({
            id: `hybrid_community_${community.id}`,
            file: community.central_file,
            startLine: 1,
            endLine: 1,
            role: inferRole(community.central_file),
            type: 'community_summary',
            content: community.summary,
            retrieval_signal: 'hybrid_community',
            semanticCategory: SemanticCategory.COMMUNITY,
            score: 0.75,
            confidence: 0.75,
            extractionMethod: 'hybrid_retrieval'
        }, {
            providerId: 'hybrid_retrieval',
            evidenceType: 'community_summary',
            freshness: 'unknown',
            provenance: {
                providerId: 'hybrid_retrieval',
                source: 'HybridRetrievalFusion',
                sourceId: community.id,
                sourceType: 'community_summary',
                confidence: 0.75,
                metadata: {
                    name: community.name,
                    generatedAt: community.generated_at,
                    files: community.files
                }
            },
            canonicalSource: {
                providerId: 'hybrid_retrieval',
                file: community.central_file,
                startLine: 1,
                endLine: 1,
                sourceId: community.id,
                sourceType: 'community_summary'
            }
        }));
    }
    return items;
}

function confidenceScore(confidence: string): number {
    if (confidence === 'high') return 0.9;
    if (confidence === 'medium') return 0.7;
    if (confidence === 'low') return 0.45;
    return 0.5;
}
function inferRole(filePath: string): LogicalUnitRole {
    if (/test|spec|mock|fixture/i.test(filePath)) return 'test';
    if (/dist|out|build|generated|node_modules/i.test(filePath)) return 'generated';
    return 'implementation';
}
