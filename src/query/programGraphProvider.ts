import { ProgramGraphNode } from '../graph/programGraphTypes';
import { ProgramGraphStore } from '../store/programGraphStore';
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

export class ProgramGraphProvider implements EvidenceProvider {
    readonly id = 'program_graph';
    readonly kind = 'program_graph' as const;
    readonly capabilities: EvidenceProviderCapabilities = {
        evidenceTypes: ['graph_dependency', 'graph_relationship', 'graph_node'],
        queryCategories: [
            'dependency_analysis',
            'architectural_reasoning',
            'debugging',
            'investigation',
            'engineering_decision_support',
            'multi_step_reasoning'
        ],
        supportsFreshness: false,
        supportsProvenance: true
    };

    private initialized = false;

    constructor(private readonly graphStore: ProgramGraphStore) {}

    async initialize(_context: ProviderContext): Promise<ProviderInitResult> {
        this.initialized = true;
        return { ready: this.graphStore.isLoaded(), diagnostics: this.graphStore.isLoaded() ? [] : [{ level: 'warn', providerId: this.id, message: 'Program graph is not loaded.' }] };
    }

    async health(): Promise<ProviderHealth> {
        if (!this.initialized) {
            return { status: 'degraded', diagnostics: [{ level: 'warn', providerId: this.id, message: 'ProgramGraphProvider has not been initialized.' }] };
        }
        return {
            status: this.graphStore.isLoaded() ? 'ready' : 'degraded',
            diagnostics: this.graphStore.isLoaded() ? [] : [{ level: 'warn', providerId: this.id, message: 'Program graph is not loaded.' }]
        };
    }

    async readiness(): Promise<ProviderReadinessStatus> {
        if (!this.initialized) {
            return { status: 'FAILED', diagnostics: [{ level: 'warn', providerId: this.id, message: 'ProgramGraphProvider has not been initialized.' }], backingArtifacts: ['program_graph'] };
        }
        const stats = this.graphStore.getStats();
        const count = stats ? stats.nodeCount + stats.edgeCount : 0;
        return {
            status: count > 0 ? 'READY' : 'EMPTY',
            diagnostics: count > 0 ? [] : [{ level: 'warn', providerId: this.id, message: 'Program graph is empty or not loaded.' }],
            backingArtifacts: ['program_graph'],
            recordCount: count
        };
    }

    canHandle(request: EvidenceProviderRequest): ProviderDecision {
        if (!request.retrievalPlan.providerIds.includes(this.id)) {
            return { canHandle: false, reason: 'Provider was not selected by the execution plan.' };
        }
        if (!this.graphStore.isLoaded()) {
            return { canHandle: false, reason: 'Program graph is not loaded.' };
        }
        if (!this.capabilities.queryCategories.includes(request.category)) {
            return { canHandle: false, reason: `ProgramGraphProvider does not handle ${request.category}.` };
        }
        return { canHandle: true };
    }

    async retrieve(request: EvidenceProviderRequest): Promise<EvidenceProviderResponse> {
        const startedAt = performance.now();
        try {
            const items = this.retrieveGraphEvidence(request).slice(0, request.limits.maxItems);
            return {
                providerId: this.id,
                status: items.length > 0 ? 'success' : 'empty',
                items,
                diagnostics: [{ level: 'info', providerId: this.id, message: `ProgramGraphProvider returned ${items.length} graph evidence items.` }],
                metadata: {
                    latencyMs: performance.now() - startedAt,
                    sourceCount: items.length,
                    confidenceRange: items.length > 0 ? [Math.min(...items.map(i => Number(i.confidence) || 0.7)), Math.max(...items.map(i => Number(i.confidence) || 0.7))] : undefined
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

    private retrieveGraphEvidence(request: EvidenceProviderRequest): EvidenceItem[] {
        const items: EvidenceItem[] = [];
        const targets = unique([...request.targets.symbols, ...request.targets.files, ...queryTermsForGraph(request.query)]);
        for (const target of targets) {
            const dependents = this.graphStore.getDependents(target);
            for (const node of dependents.callers) items.push(nodeToEvidenceItem(node, this.id, 'graph_caller_dependency', dependents.confidence));
            for (const node of dependents.readers) items.push(nodeToEvidenceItem(node, this.id, 'graph_reader_dependency', dependents.confidence));
            for (const node of dependents.importers) items.push(nodeToEvidenceItem(node, this.id, 'graph_import_dependency', dependents.confidence));
            for (const node of dependents.instantiators) items.push(nodeToEvidenceItem(node, this.id, 'graph_instantiation_dependency', dependents.confidence));
            for (const node of dependents.fallbackConsumers) items.push(nodeToEvidenceItem(node, this.id, 'graph_fallback_dependency', dependents.confidence));

            for (const nodeId of this.graphStore.getNodesBySymbol(target)) {
                const node = this.graphStore.getNode(nodeId);
                if (node) {
                    items.push(nodeToEvidenceItem(node, this.id, 'graph_symbol_node', 'HIGH'));
                    for (const edge of this.graphStore.getOutboundEdges(node.id)) {
                        const related = this.graphStore.getNode(edge.to);
                        if (related) items.push(nodeToEvidenceItem(related, this.id, `graph_${edge.type}`, edge.weight >= 0.8 ? 'HIGH' : edge.weight >= 0.5 ? 'MEDIUM' : 'LOW'));
                    }
                }
            }
        }
        return dedupeItems(items);
    }
}


function queryTermsForGraph(query: string): string[] {
    const raw = query.match(/[A-Za-z_$][A-Za-z0-9_$]*|\/[A-Za-z0-9_.$/:{}-]+/g) ?? [];
    return unique(raw
        .flatMap(token => [
            token,
            token.replace(/^\//, ''),
            token.replace(/[^A-Za-z0-9_$]/g, '_'),
            ...splitIdentifier(token)
        ])
        .map(token => token.trim())
        .filter(token => token.length > 2 && !GRAPH_QUERY_STOPWORDS.has(token.toLowerCase())));
}

function splitIdentifier(value: string): string[] {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9_$]+|_/)
        .filter(Boolean);
}

function unique<T>(values: T[]): T[] {
    return Array.from(new Set(values));
}

const GRAPH_QUERY_STOPWORDS = new Set([
    'what', 'where', 'which', 'does', 'frontend', 'backend', 'file', 'define', 'defines', 'implemented',
    'implementation', 'from', 'into', 'with', 'the', 'and', 'for', 'how', 'why', 'are', 'is', 'api',
    'endpoint', 'service', 'logic', 'context', 'load', 'display', 'order', 'orders', 'project'
]);
function nodeToEvidenceItem(node: ProgramGraphNode, providerId: string, signal: string, confidenceLabel: 'HIGH' | 'MEDIUM' | 'LOW'): EvidenceItem {
    const confidence = confidenceLabel === 'HIGH' ? 0.9 : confidenceLabel === 'MEDIUM' ? 0.7 : 0.45;
    const startLine = node.startLine ?? 0;
    const endLine = node.endLine ?? startLine;
    return withNormalizedEvidenceFields({
        id: `${providerId}_${signal}_${node.id}`,
        file: node.filePath,
        startLine,
        endLine,
        role: node.role,
        unitId: node.id,
        symbol: node.symbol,
        type: 'graph_dependency',
        content: `Graph relationship ${signal}\nNode: ${node.symbol ?? node.id}\nType: ${node.type}\nFile: ${node.filePath}`,
        retrieval_signal: signal,
        semanticCategory: SemanticCategory.DEPENDENCY,
        score: confidence,
        confidence,
        extractionMethod: 'program_graph'
    }, {
        providerId,
        evidenceType: 'graph_dependency',
        freshness: 'unknown',
        provenance: {
            providerId,
            source: 'ProgramGraphStore',
            sourceId: node.id,
            sourceType: node.type,
            confidence,
            metadata: { signal, uuid: node.uuid }
        },
        canonicalSource: {
            providerId,
            file: node.filePath,
            startLine,
            endLine,
            symbol: node.symbol,
            sourceId: node.id,
            sourceType: node.type
        }
    });
}

function dedupeItems(items: EvidenceItem[]): EvidenceItem[] {
    const byId = new Map<string, EvidenceItem>();
    for (const item of items) byId.set(item.id, item);
    return Array.from(byId.values());
}