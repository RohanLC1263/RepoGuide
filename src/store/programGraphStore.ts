import * as fs from 'fs';
import * as path from 'path';
import { ProgramGraph, ProgramGraphNode, ProgramGraphEdge } from '../graph/programGraphTypes';
import { ProgramGraphBuilder } from '../graph/programGraphBuilder';
import { LogicalUnitStore } from './logicalUnitStore';
import { FactStore } from './factStore';

const GRAPH_DIR = 'graph';
const GRAPH_FILE = 'graph.json';

/**
 * Wraps persistence and query API for the Program Graph.
 * In-memory adjacency indexes are built on load/build for O(1) lookups.
 */
export class ProgramGraphStore {
    private graph: ProgramGraph | null = null;
    private outEdges = new Map<string, ProgramGraphEdge[]>();
    private inEdges = new Map<string, ProgramGraphEdge[]>();
    private symbolToNodes = new Map<string, string[]>();

    /**
     * Build the graph from existing stores and persist to disk.
     */
    async build(
        unitStore: LogicalUnitStore,
        factStore: FactStore,
        repoRoot: string
    ): Promise<ProgramGraph> {
        const builder = new ProgramGraphBuilder();
        this.graph = await builder.build(unitStore, factStore, repoRoot);
        this.buildIndexes();
        await this.save(repoRoot);
        return this.graph;
    }

    /**
     * Load a previously persisted graph from disk.
     */
    async load(repoRoot: string): Promise<ProgramGraph | null> {
        const graphPath = this.graphPath(repoRoot);
        if (!fs.existsSync(graphPath)) return null;
        try {
            const raw = fs.readFileSync(graphPath, 'utf-8');
            this.graph = JSON.parse(raw) as ProgramGraph;
            this.buildIndexes();
            return this.graph;
        } catch {
            return null;
        }
    }

    /**
     * Save the current graph to disk.
     */
    async save(repoRoot: string): Promise<void> {
        if (!this.graph) return;
        const graphDir = path.join(repoRoot, '.repoguide', GRAPH_DIR);
        if (!fs.existsSync(graphDir)) {
            fs.mkdirSync(graphDir, { recursive: true });
        }
        const graphPath = path.join(graphDir, GRAPH_FILE);
        fs.writeFileSync(graphPath, JSON.stringify(this.graph), 'utf-8');
    }

    /**
     * Get nodes that the given unit reads from (follows 'reads' edges outward).
     */
    getReads(unitId: string): ProgramGraphNode[] {
        return this.getOutbound(unitId, 'reads');
    }

    /**
     * Get nodes that call the given symbol (follows 'calls' edges inward to find callers).
     */
    getCallers(symbol: string): ProgramGraphNode[] {
        if (!this.graph) return [];
        // Find all node IDs matching the symbol
        const nodeIds = this.symbolToNodes.get(symbol.toLowerCase()) || [];
        const callers: ProgramGraphNode[] = [];
        const seen = new Set<string>();
        for (const nodeId of nodeIds) {
            const inbound = this.inEdges.get(nodeId) || [];
            for (const edge of inbound) {
                if (edge.type === 'calls' && !seen.has(edge.from)) {
                    seen.add(edge.from);
                    const node = this.graph.nodes[edge.from];
                    if (node) callers.push(node);
                }
            }
        }
        return callers;
    }

    /**
     * Get nodes called by the given unit (follows 'calls' edges outward).
     */
    getCallees(unitId: string): ProgramGraphNode[] {
        return this.getOutbound(unitId, 'calls');
    }

    /**
     * Get nodes that instantiate the given class (follows 'instantiates' edges inward).
     */
    getInstantiations(className: string): ProgramGraphNode[] {
        if (!this.graph) return [];
        const nodeIds = this.symbolToNodes.get(className.toLowerCase()) || [];
        const instantiators: ProgramGraphNode[] = [];
        const seen = new Set<string>();
        for (const nodeId of nodeIds) {
            const inbound = this.inEdges.get(nodeId) || [];
            for (const edge of inbound) {
                if (edge.type === 'instantiates' && !seen.has(edge.from)) {
                    seen.add(edge.from);
                    const node = this.graph.nodes[edge.from];
                    if (node) instantiators.push(node);
                }
            }
        }
        return instantiators;
    }

    /**
     * Get fallback targets for the given unit (follows 'fallback_to' edges outward).
     */
    getFallbacks(unitId: string): ProgramGraphNode[] {
        return this.getOutbound(unitId, 'fallback_to');
    }

    /**
     * Get the containing unit or file for the given unit (follows 'contains' edge inward).
     */
    getContainedBy(unitId: string): ProgramGraphNode | null {
        if (!this.graph) return null;
        const inbound = this.inEdges.get(unitId) || [];
        for (const edge of inbound) {
            if (edge.type === 'contains') {
                return this.graph.nodes[edge.from] || null;
            }
        }
        return null;
    }

    /**
     * Get dependents for a given symbol or file (impact analysis).
     */
    getDependents(symbolOrFile: string): {
        callers: ProgramGraphNode[],
        readers: ProgramGraphNode[],
        importers: ProgramGraphNode[],
        instantiators: ProgramGraphNode[],
        fallbackConsumers: ProgramGraphNode[],
        confidence: 'HIGH' | 'MEDIUM' | 'LOW'
    } {
        const callers: ProgramGraphNode[] = [];
        const readers: ProgramGraphNode[] = [];
        const importers: ProgramGraphNode[] = [];
        const instantiators: ProgramGraphNode[] = [];
        const fallbackConsumers: ProgramGraphNode[] = [];

        if (!this.graph) {
            return { callers, readers, importers, instantiators, fallbackConsumers, confidence: 'LOW' };
        }

        const nodeIds: string[] = [];

        // 1. Try file
        const fileMatchId = Array.from(this.inEdges.keys()).find(k => k.startsWith('file::') && k.endsWith(symbolOrFile));
        if (fileMatchId) {
            nodeIds.push(fileMatchId);
            // also push all units contained in this file
            const outbound = this.outEdges.get(fileMatchId) || [];
            for (const edge of outbound) {
                if (edge.type === 'contains') {
                    nodeIds.push(edge.to);
                }
            }
        }

        // 2. Try symbol
        if (nodeIds.length === 0) {
            const symNodes = this.symbolToNodes.get(symbolOrFile.toLowerCase()) || [];
            nodeIds.push(...symNodes);
        }

        const seenCallers = new Set<string>();
        const seenReaders = new Set<string>();
        const seenImporters = new Set<string>();
        const seenInstantiators = new Set<string>();
        const seenFallbackConsumers = new Set<string>();

        for (const targetNodeId of nodeIds) {
            const inbound = this.inEdges.get(targetNodeId) || [];
            for (const edge of inbound) {
                const sourceNode = this.graph.nodes[edge.from];
                if (!sourceNode) continue;

                switch (edge.type) {
                    case 'calls':
                        if (!seenCallers.has(edge.from)) {
                            seenCallers.add(edge.from);
                            callers.push(sourceNode);
                        }
                        break;
                    case 'reads':
                        if (!seenReaders.has(edge.from)) {
                            seenReaders.add(edge.from);
                            readers.push(sourceNode);
                        }
                        break;
                    case 'imports':
                        if (!seenImporters.has(edge.from)) {
                            seenImporters.add(edge.from);
                            importers.push(sourceNode);
                        }
                        break;
                    case 'instantiates':
                        if (!seenInstantiators.has(edge.from)) {
                            seenInstantiators.add(edge.from);
                            instantiators.push(sourceNode);
                        }
                        break;
                    case 'fallback_to':
                        if (!seenFallbackConsumers.has(edge.from)) {
                            seenFallbackConsumers.add(edge.from);
                            fallbackConsumers.push(sourceNode);
                        }
                        break;
                }
            }
        }

        let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
        if (callers.length > 0 || readers.length > 0 || instantiators.length > 0) {
            confidence = 'HIGH';
        } else if (importers.length > 0) {
            confidence = 'MEDIUM';
        }

        return { callers, readers, importers, instantiators, fallbackConsumers, confidence };
    }

    /**
     * Get dependencies for a given symbol or file -- "what does this itself
     * call/read/import/instantiate/fall back to," the reverse direction of
     * getDependents(). A literal mirror: same file/symbol resolution (try
     * file first, then symbol; a file match also pulls in its contained
     * units), same five edge types and confidence heuristic, just walked
     * outbound (outEdges, edge.to) instead of inbound (inEdges, edge.from).
     */
    getDependencies(symbolOrFile: string): {
        callees: ProgramGraphNode[],
        readTargets: ProgramGraphNode[],
        importTargets: ProgramGraphNode[],
        instantiationTargets: ProgramGraphNode[],
        fallbackTargets: ProgramGraphNode[],
        confidence: 'HIGH' | 'MEDIUM' | 'LOW'
    } {
        const callees: ProgramGraphNode[] = [];
        const readTargets: ProgramGraphNode[] = [];
        const importTargets: ProgramGraphNode[] = [];
        const instantiationTargets: ProgramGraphNode[] = [];
        const fallbackTargets: ProgramGraphNode[] = [];

        if (!this.graph) {
            return { callees, readTargets, importTargets, instantiationTargets, fallbackTargets, confidence: 'LOW' };
        }

        const nodeIds: string[] = [];

        // 1. Try file
        const fileMatchId = Array.from(this.inEdges.keys()).find(k => k.startsWith('file::') && k.endsWith(symbolOrFile));
        if (fileMatchId) {
            nodeIds.push(fileMatchId);
            // also push all units contained in this file
            const outbound = this.outEdges.get(fileMatchId) || [];
            for (const edge of outbound) {
                if (edge.type === 'contains') {
                    nodeIds.push(edge.to);
                }
            }
        }

        // 2. Try symbol
        if (nodeIds.length === 0) {
            const symNodes = this.symbolToNodes.get(symbolOrFile.toLowerCase()) || [];
            nodeIds.push(...symNodes);
        }

        const seenCallees = new Set<string>();
        const seenReadTargets = new Set<string>();
        const seenImportTargets = new Set<string>();
        const seenInstantiationTargets = new Set<string>();
        const seenFallbackTargets = new Set<string>();

        for (const sourceNodeId of nodeIds) {
            const outbound = this.outEdges.get(sourceNodeId) || [];
            for (const edge of outbound) {
                const targetNode = this.graph.nodes[edge.to];
                if (!targetNode) continue;

                switch (edge.type) {
                    case 'calls':
                        if (!seenCallees.has(edge.to)) {
                            seenCallees.add(edge.to);
                            callees.push(targetNode);
                        }
                        break;
                    case 'reads':
                        if (!seenReadTargets.has(edge.to)) {
                            seenReadTargets.add(edge.to);
                            readTargets.push(targetNode);
                        }
                        break;
                    case 'imports':
                        if (!seenImportTargets.has(edge.to)) {
                            seenImportTargets.add(edge.to);
                            importTargets.push(targetNode);
                        }
                        break;
                    case 'instantiates':
                        if (!seenInstantiationTargets.has(edge.to)) {
                            seenInstantiationTargets.add(edge.to);
                            instantiationTargets.push(targetNode);
                        }
                        break;
                    case 'fallback_to':
                        if (!seenFallbackTargets.has(edge.to)) {
                            seenFallbackTargets.add(edge.to);
                            fallbackTargets.push(targetNode);
                        }
                        break;
                }
            }
        }

        let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
        if (callees.length > 0 || readTargets.length > 0 || instantiationTargets.length > 0) {
            confidence = 'HIGH';
        } else if (importTargets.length > 0) {
            confidence = 'MEDIUM';
        }

        return { callees, readTargets, importTargets, instantiationTargets, fallbackTargets, confidence };
    }

    /**
     * Check if the graph has been loaded or built.
     */
    isLoaded(): boolean {
        return this.graph !== null;
    }

    /**
     * Get graph statistics.
     */
    getStats(): { nodeCount: number; edgeCount: number } | null {
        if (!this.graph) return null;
        return { nodeCount: this.graph.nodeCount, edgeCount: this.graph.edgeCount };
    }

    /**
     * Get a node by its ID.
     */
    getNode(id: string): ProgramGraphNode | undefined {
        return this.graph?.nodes[id];
    }

    /**
     * Get all inbound edges for a given node ID.
     */
    getInboundEdges(id: string): ProgramGraphEdge[] {
        return this.inEdges.get(id) || [];
    }

    /**
     * Get all outbound edges for a given node ID.
     */
    getOutboundEdges(id: string): ProgramGraphEdge[] {
        return this.outEdges.get(id) || [];
    }

    /**
     * Resolve a symbol name to its node IDs.
     */
    getNodesBySymbol(symbol: string): string[] {
        return this.symbolToNodes.get(symbol.toLowerCase()) || [];
    }

    // -- Private helpers --

    private getOutbound(unitId: string, edgeType: string): ProgramGraphNode[] {
        if (!this.graph) return [];
        const outbound = this.outEdges.get(unitId) || [];
        const results: ProgramGraphNode[] = [];
        const seen = new Set<string>();
        for (const edge of outbound) {
            if (edge.type === edgeType && !seen.has(edge.to)) {
                seen.add(edge.to);
                const node = this.graph.nodes[edge.to];
                if (node) results.push(node);
            }
        }
        return results;
    }

    private buildIndexes(): void {
        this.outEdges.clear();
        this.inEdges.clear();
        this.symbolToNodes.clear();

        if (!this.graph) return;

        // Build adjacency indexes
        for (const edge of this.graph.edges) {
            if (!this.outEdges.has(edge.from)) this.outEdges.set(edge.from, []);
            this.outEdges.get(edge.from)!.push(edge);
            if (!this.inEdges.has(edge.to)) this.inEdges.set(edge.to, []);
            this.inEdges.get(edge.to)!.push(edge);
        }

        // Build symbol → node index
        for (const [id, node] of Object.entries(this.graph.nodes)) {
            if (node.symbol) {
                const key = node.symbol.toLowerCase();
                if (!this.symbolToNodes.has(key)) this.symbolToNodes.set(key, []);
                this.symbolToNodes.get(key)!.push(id);
            }
        }
    }

    private graphPath(repoRoot: string): string {
        return path.join(repoRoot, '.repoguide', GRAPH_DIR, GRAPH_FILE);
    }
}
