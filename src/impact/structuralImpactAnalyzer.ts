import { ProgramGraphStore } from '../store/programGraphStore';

export class StructuralImpactAnalyzer {
    constructor(private graphStore: ProgramGraphStore) {}

    /**
     * Performs a Breadth-First Search (BFS) over the ProgramGraphStore's inbound edges 
     * to find all nodes structurally impacted by a change to the given rootNodeId.
     * 
     * Returns a Map of NodeID -> Path Length (distance from root).
     */
    public getImpactZone(rootNodeId: string): Map<string, number> {
        const impactZone = new Map<string, number>();
        
        // Ensure the root node exists
        const rootNode = this.graphStore.getNode(rootNodeId);
        if (!rootNode) return impactZone;

        // BFS Queue stores [nodeId, currentDepth]
        const queue: [string, number][] = [[rootNodeId, 0]];
        impactZone.set(rootNodeId, 0);

        while (queue.length > 0) {
            const [currentNodeId, currentDepth] = queue.shift()!;
            
            // Get all edges coming into the current node (dependents)
            // Example: If A imports B, the edge is A -> B. 
            // Inbound edges to B tell us who depends on B (i.e. A).
            const inboundEdges = this.graphStore.getInboundEdges(currentNodeId);
            
            for (const edge of inboundEdges) {
                // Determine if this edge type propagates blast radius
                if (this.isImpactPropagating(edge.type)) {
                    const dependentNodeId = edge.from;
                    
                    if (!impactZone.has(dependentNodeId)) {
                        impactZone.set(dependentNodeId, currentDepth + 1);
                        queue.push([dependentNodeId, currentDepth + 1]);
                    }
                }
            }
        }

        return impactZone;
    }

    private isImpactPropagating(edgeType: string): boolean {
        // Types that mean a change to the target impacts the source
        return [
            'imports',
            'calls',
            'reads',
            'instantiates',
            'contains',
            'fallback_to',
            'assigns',
            'decorates'
        ].includes(edgeType);
    }
}
