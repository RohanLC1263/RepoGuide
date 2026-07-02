import {
    CallChain,
    FunctionCallGraph,
    FunctionEdge,
    FunctionNode
} from '../types';

export class CallGraphTraverser {
    constructor(private graph: FunctionCallGraph) {}

    traverse(
        startNodeId: string,
        maxDepth = 8,
        maxNodes = 20
    ): CallChain | null {
        const startNode = this.graph.nodes[startNodeId];
        if (!startNode) {
            return null;
        }

        const visited = new Set<string>();
        const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: startNodeId, depth: 0 }];
        let maxDepthReachedValue = 0;
        let maxDepthHit = false;

        while (queue.length > 0 && visited.size < maxNodes) {
            const current = queue.shift();
            if (!current) {
                continue;
            }

            if (visited.has(current.nodeId)) {
                continue;
            }

            visited.add(current.nodeId);
            maxDepthReachedValue = Math.max(maxDepthReachedValue, current.depth);

            if (current.depth >= maxDepth) {
                maxDepthHit = true;
                continue;
            }

            for (const nextNodeId of this.graph.nodes[current.nodeId]?.outboundCalls ?? []) {
                if (visited.has(nextNodeId) || !this.graph.nodes[nextNodeId]) {
                    continue;
                }
                queue.push({ nodeId: nextNodeId, depth: current.depth + 1 });
            }
        }

        if (queue.length > 0) {
            const nextDepth = queue[0]?.depth;
            if (typeof nextDepth === 'number' && nextDepth >= maxDepth) {
                maxDepthHit = true;
            }
        }

        const edges = this.graph.edges.filter(edge =>
            visited.has(edge.from) && visited.has(edge.to)
        );
        const sortedNodes = topologicalSort(visited, edges, this.graph.nodes);

        return {
            entryPoint: startNode,
            nodes: sortedNodes,
            edges,
            depth: maxDepthReachedValue,
            maxDepthReached: maxDepthHit || maxDepthReachedValue >= maxDepth
        };
    }

    getNode(id: string): FunctionNode | null {
        return this.graph.nodes[id] ?? null;
    }

    getEdgesFrom(nodeId: string): FunctionEdge[] {
        return this.graph.edges.filter(edge => edge.from === nodeId);
    }

    getEdgesTo(nodeId: string): FunctionEdge[] {
        return this.graph.edges.filter(edge => edge.to === nodeId);
    }
}

function topologicalSort(
    visited: Set<string>,
    edges: FunctionEdge[],
    nodes: Record<string, FunctionNode>
): FunctionNode[] {
    const visitedIds = Array.from(visited);
    const incomingCount = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const nodeId of visitedIds) {
        incomingCount.set(nodeId, 0);
        adjacency.set(nodeId, []);
    }

    for (const edge of edges) {
        adjacency.get(edge.from)?.push(edge.to);
        incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
    }

    const queue = visitedIds.filter(nodeId => (incomingCount.get(nodeId) ?? 0) === 0);
    const sortedIds: string[] = [];

    while (queue.length > 0) {
        const nodeId = queue.shift();
        if (!nodeId) {
            continue;
        }

        sortedIds.push(nodeId);

        for (const nextNodeId of adjacency.get(nodeId) ?? []) {
            const nextIncoming = (incomingCount.get(nextNodeId) ?? 0) - 1;
            incomingCount.set(nextNodeId, nextIncoming);
            if (nextIncoming === 0) {
                queue.push(nextNodeId);
            }
        }
    }

    for (const nodeId of visitedIds) {
        if (!sortedIds.includes(nodeId)) {
            sortedIds.push(nodeId);
        }
    }

    return sortedIds
        .map(nodeId => nodes[nodeId])
        .filter((node): node is FunctionNode => Boolean(node));
}
