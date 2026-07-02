import {
    FunctionCallGraph,
    FunctionEdge,
    FunctionNode,
    FunctionCall
} from '../types';

export function assembleGraph(
    nodes: Record<string, FunctionNode>,
    edges: FunctionEdge[],
    unresolvedCalls: FunctionCall[],
    projectRoot: string
): FunctionCallGraph {
    const nodeEntries = Object.values(nodes);

    for (const node of nodeEntries) {
        node.outboundCalls = [];
        node.inboundCalls = [];
        node.callCount = 0;
        node.importance = 0;
    }

    for (const edge of edges) {
        const fromNode = nodes[edge.from];
        const toNode = nodes[edge.to];
        if (!fromNode || !toNode) {
            continue;
        }

        if (!fromNode.outboundCalls.includes(edge.to)) {
            fromNode.outboundCalls.push(edge.to);
        }
        if (!toNode.inboundCalls.includes(edge.from)) {
            toNode.inboundCalls.push(edge.from);
        }
    }

    for (const node of nodeEntries) {
        node.callCount = node.outboundCalls.length + node.inboundCalls.length;
    }

    const entryPoints = nodeEntries
        .filter(node => node.isEntryPoint)
        .map(node => node.id);
    const distanceMap = computeEntryPointDistance(entryPoints, nodes);

    for (const node of nodeEntries) {
        const entryPointDistance = distanceMap.get(node.id) ?? 999;
        node.importance = (node.inboundCalls.length * 0.6) + ((1 / (entryPointDistance + 1)) * 0.4);
    }

    return {
        version: '2.0',
        generatedAt: new Date().toISOString(),
        projectRoot,
        nodes,
        edges,
        entryPoints,
        unresolvedCalls
    };
}

function computeEntryPointDistance(
    entryPoints: string[],
    nodes: Record<string, FunctionNode>
): Map<string, number> {
    const distances = new Map<string, number>();
    const queue: string[] = [];

    for (const entryPoint of entryPoints) {
        if (!nodes[entryPoint]) {
            continue;
        }
        distances.set(entryPoint, 0);
        queue.push(entryPoint);
    }

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {
            continue;
        }

        const currentDistance = distances.get(current) ?? 0;
        for (const next of nodes[current]?.outboundCalls ?? []) {
            if (distances.has(next) || !nodes[next]) {
                continue;
            }
            distances.set(next, currentDistance + 1);
            queue.push(next);
        }
    }

    return distances;
}
