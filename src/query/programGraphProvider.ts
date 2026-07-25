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
        // When a caller has force-selected this provider (e.g. get_dependents /
        // get_dependencies routing a bare symbol straight to the graph), honour that
        // intent and skip the category gate -- otherwise a symbol that classifies as
        // repository_exploration (a category not in queryCategories) makes canHandle
        // decline and the tool returns an empty dependents list despite the graph
        // holding the edges. Planner-driven retrieval (no forcedProviderIds) still
        // gates on category as before.
        const forced = request.retrievalPlan.forcedProviderIds?.includes(this.id) ?? false;
        if (!forced && !this.capabilities.queryCategories.includes(request.category)) {
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
        // Graph targets come ONLY from the plan's properly-extracted symbol/file
        // targets -- never from re-tokenizing the raw question text here.
        //
        // This previously also unioned in queryTermsForGraph(request.query), which
        // sub-token-split every identifier ("BaseAgent" -> "Base", "Agent"). Those
        // bare fragments matched real but UNRELATED graph nodes (e.g. a node literally
        // named `agent` in craft_classifier_agent/agent.py), whose dependents were then
        // emitted under the same DEPENDENCY category as the real subject's. Downstream
        // that contaminated both the synthesis prompt (fabricated dependents in chat
        // answers) and MentorEngine's numeric blast-radius score. The plan's symbol
        // hints keep identifiers whole, so the subject still resolves -- only the
        // spurious fragment expansion is gone.
        const targets = unique([...request.targets.symbols, ...request.targets.files]);
        for (const target of targets) {
            // 1. Emit the symbol-node ANCHORS first. The get_dependents/get_dependencies
            //    response builders' identity check matches the requested symbol against a
            //    `graph_symbol_node` item; for a high-degree symbol the dependency list
            //    below can exceed the aggregate item cap and truncate the anchor off,
            //    making a real symbol report `found: false`. Emitting the anchor before
            //    the (cappable) dependency lists reserves it a surviving slot. The
            //    symbol node's own outbound edges are lower value, so they stay LAST.
            const symbolNodes: ProgramGraphNode[] = [];
            for (const nodeId of this.graphStore.getNodesBySymbol(target)) {
                const node = this.graphStore.getNode(nodeId);
                if (node) {
                    items.push(nodeToEvidenceItem(node, this.id, 'graph_symbol_node', 'HIGH'));
                    symbolNodes.push(node);
                }
            }

            // 2. Dependents ("who depends on this," get_dependents).
            const dependents = this.graphStore.getDependents(target);
            for (const node of dependents.callers) items.push(nodeToEvidenceItem(node, this.id, 'graph_caller_dependency', dependents.confidence));
            for (const node of dependents.readers) items.push(nodeToEvidenceItem(node, this.id, 'graph_reader_dependency', dependents.confidence));
            for (const node of dependents.importers) items.push(nodeToEvidenceItem(node, this.id, 'graph_import_dependency', dependents.confidence));
            for (const node of dependents.instantiators) items.push(nodeToEvidenceItem(node, this.id, 'graph_instantiation_dependency', dependents.confidence));
            for (const node of dependents.fallbackConsumers) items.push(nodeToEvidenceItem(node, this.id, 'graph_fallback_dependency', dependents.confidence));

            // 3. Outbound mirror -- "what does this itself depend on," backing the
            // get_dependencies MCP tool. Computed unconditionally alongside
            // dependents -- get_dependents' own response builder already ignores
            // signals it doesn't recognize, so this is additive to it.
            const dependencies = this.graphStore.getDependencies(target);
            for (const node of dependencies.callees) items.push(nodeToEvidenceItem(node, this.id, 'graph_callee_dependency', dependencies.confidence));
            for (const node of dependencies.readTargets) items.push(nodeToEvidenceItem(node, this.id, 'graph_read_target_dependency', dependencies.confidence));
            for (const node of dependencies.importTargets) items.push(nodeToEvidenceItem(node, this.id, 'graph_import_target_dependency', dependencies.confidence));
            for (const node of dependencies.instantiationTargets) items.push(nodeToEvidenceItem(node, this.id, 'graph_instantiation_target_dependency', dependencies.confidence));
            for (const node of dependencies.fallbackTargets) items.push(nodeToEvidenceItem(node, this.id, 'graph_fallback_target_dependency', dependencies.confidence));

            // 4. The symbol nodes' own outbound edges (lowest priority -- kept last so
            //    they never crowd out the anchor or the dependency lists above).
            for (const node of symbolNodes) {
                for (const edge of this.graphStore.getOutboundEdges(node.id)) {
                    const related = this.graphStore.getNode(edge.to);
                    if (related) items.push(nodeToEvidenceItem(related, this.id, `graph_${edge.type}`, edge.weight >= 0.8 ? 'HIGH' : edge.weight >= 0.5 ? 'MEDIUM' : 'LOW'));
                }
            }
        }
        return dedupeItems(items);
    }
}


function unique<T>(values: T[]): T[] {
    return Array.from(new Set(values));
}
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