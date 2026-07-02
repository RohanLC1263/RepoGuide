import { ProgramGraphStore } from '../store/programGraphStore';
import { ProgramGraphNode, ProgramGraphEdgeType } from '../graph/programGraphTypes';

export interface TraversalPlan {
    direction: 'DEPENDENTS' | 'DEPENDENCIES';
    edgeTypes: ProgramGraphEdgeType[];
    maxDepth: number;
}

export interface ReachableNode {
    nodeId: string;
    node: ProgramGraphNode;
    depth: number;
    incomingEdgeType: ProgramGraphEdgeType | null;
    shortestPath: string[]; // Path of Node IDs from root to this node
}

export interface TraversalResult {
    rootNodeId: string;
    reachableNodes: ReachableNode[];
}

export class TransitiveGraphWalker {
    constructor(private store: ProgramGraphStore) {}

    /**
     * Internal engine to perform BFS graph traversal.
     */
    private walk(nodeIdOrSymbol: string, plan: TraversalPlan): TraversalResult {
        if (!this.store.isLoaded()) {
            return { rootNodeId: nodeIdOrSymbol, reachableNodes: [] };
        }

        let rootIds = [nodeIdOrSymbol];
        if (!this.store.getNode(nodeIdOrSymbol)) {
            const resolved = this.store.getNodesBySymbol(nodeIdOrSymbol);
            if (resolved.length > 0) {
                rootIds = resolved;
            } else {
                return { rootNodeId: nodeIdOrSymbol, reachableNodes: [] }; // Node not found
            }
        }

        const validEdgeTypes = new Set(plan.edgeTypes);
        const visited = new Set<string>();
        const reachableNodes: ReachableNode[] = [];
        
        // Queue stores { id, depth, path, incomingEdgeType }
        const queue: { id: string; depth: number; path: string[]; incomingEdgeType: ProgramGraphEdgeType | null }[] = [];
        
        for (const rootId of rootIds) {
            queue.push({ id: rootId, depth: 0, path: [rootId], incomingEdgeType: null });
            visited.add(rootId);
        }

        while (queue.length > 0) {
            const current = queue.shift()!;
            
            // Add to results if it's not the root node itself
            if (current.depth > 0) {
                const node = this.store.getNode(current.id);
                if (node) {
                    reachableNodes.push({
                        nodeId: current.id,
                        node,
                        depth: current.depth,
                        incomingEdgeType: current.incomingEdgeType,
                        shortestPath: current.path
                    });
                }
            }

            if (current.depth >= plan.maxDepth) {
                continue;
            }

            const edges = plan.direction === 'DEPENDENTS' 
                ? this.store.getInboundEdges(current.id) 
                : this.store.getOutboundEdges(current.id);

            for (const edge of edges) {
                if (validEdgeTypes.has(edge.type)) {
                    // For DEPENDENTS (inbound edges): the source of the edge is dependent on current
                    // For DEPENDENCIES (outbound edges): the target of the edge is what current depends on
                    const nextId = plan.direction === 'DEPENDENTS' ? edge.from : edge.to;
                    
                    if (!visited.has(nextId)) {
                        visited.add(nextId);
                        queue.push({
                            id: nextId,
                            depth: current.depth + 1,
                            path: [...current.path, nextId],
                            incomingEdgeType: edge.type
                        });
                    }
                }
            }
        }

        return {
            rootNodeId: rootIds[0], // If symbol resolved to multiple, we just use the first for the result's rootId for now
            reachableNodes
        };
    }

    /**
     * Gets all nodes that transitively depend on the target node.
     * Uses BFS to traverse inbound edges (who calls/imports/reads me).
     */
    getTransitiveDependents(nodeIdOrSymbol: string, maxDepth: number = 10): TraversalResult {
        return this.walk(nodeIdOrSymbol, {
            direction: 'DEPENDENTS',
            edgeTypes: ['calls', 'reads', 'imports', 'references', 'instantiates', 'assigns'],
            maxDepth
        });
    }

    /**
     * Gets all nodes that the target node transitively depends on.
     * Uses BFS to traverse outbound edges (what do I call/import/read).
     */
    getTransitiveDependencies(nodeIdOrSymbol: string, maxDepth: number = 10): TraversalResult {
        return this.walk(nodeIdOrSymbol, {
            direction: 'DEPENDENCIES',
            edgeTypes: ['calls', 'reads', 'imports', 'references', 'instantiates', 'assigns'],
            maxDepth
        });
    }

    /**
     * Gets the full blast radius of a node, tracking what would break if this node changed.
     * Uses DEPENDENTS traversal with edge types indicating consequence.
     */
    getBlastRadius(nodeIdOrSymbol: string, maxDepth: number = 10): TraversalResult {
        return this.walk(nodeIdOrSymbol, {
            direction: 'DEPENDENTS',
            // Specifically focus on consequences: 
            // if I am called, read, imported, instantiated, or my assignment is used, things break.
            edgeTypes: ['calls', 'reads', 'imports', 'references', 'instantiates', 'assigns'],
            maxDepth
        });
    }
}
