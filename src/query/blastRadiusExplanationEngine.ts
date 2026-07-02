import { ProgramGraphStore } from '../store/programGraphStore';
import { TransitiveGraphWalker } from './transitiveGraphWalker';
import { DependencyPathEngine, DependencyPath, PathStep } from './dependencyPathEngine';

export interface ImpactExplanation {
    rootNodeId: string;
    impactedNodeId: string;
    shortestPath: DependencyPath;
    explanationDepth: number;
    impactedSubsystems: string[];
    evidence: PathStep[];
    criticalityScore: number;
}

export interface BlastRadiusSummary {
    rootNodeId: string;
    totalImpactedNodes: number;
    highestDepth: number;
    topImpactedNodes: string[];
    criticalPaths: DependencyPath[];
    impactedSubsystems: string[];
}

export interface BlastRadiusExplanation {
    rootNodeId: string;
    summary: BlastRadiusSummary;
    impactExplanations: ImpactExplanation[];
}

export class BlastRadiusExplanationEngine {
    private readonly MAX_IMPACT_EXPLANATIONS = 100;
    private readonly MAX_CRITICAL_PATHS = 20;

    constructor(
        private store: ProgramGraphStore,
        private walker: TransitiveGraphWalker,
        private pathEngine: DependencyPathEngine
    ) {}

    /**
     * Reconstructs the detailed PathStep array directly from an array of node IDs.
     * This avoids needing to re-run BFS if we already have the path.
     */
    private buildEvidenceFromPath(pathIds: string[]): PathStep[] {
        const evidence: PathStep[] = [];
        for (let i = 0; i < pathIds.length - 1; i++) {
            const fromId = pathIds[i];
            const toId = pathIds[i + 1];
            
            // In a blast radius, pathIds goes from root to impacted (up the dependency chain).
            // This means the structural edge goes from toId to fromId.
            const inbound = this.store.getInboundEdges(fromId);
            const edge = inbound.find(e => e.from === toId);
            
            if (edge) {
                // We preserve the causal direction for the explanation output
                // Example: Index -> Store. Explanation: Store is impacted by Index via 'calls'.
                evidence.push({
                    fromNodeId: toId,
                    toNodeId: fromId,
                    edgeType: edge.type,
                    edgeWeight: edge.weight
                });
            } else {
                // Fallback if edge somehow vanished (shouldn't happen in static graph)
                evidence.push({
                    fromNodeId: toId,
                    toNodeId: fromId,
                    edgeType: 'reads' // fallback default
                });
            }
        }
        return evidence;
    }

    /**
     * Extracts a pseudo-subsystem name from a node's filePath.
     * Example: 'src/query/foo.ts' -> 'src/query'
     */
    private extractSubsystem(filePath: string): string {
        const parts = filePath.split('/');
        if (parts.length > 1) {
            return parts.slice(0, parts.length - 1).join('/');
        }
        const partsWin = filePath.split('\\');
        if (partsWin.length > 1) {
            return partsWin.slice(0, partsWin.length - 1).join('/');
        }
        return 'root';
    }

    /**
     * Calculates the Path Importance Score.
     * Higher score = more important.
     * Formula: (pathDepth * 1) + (inboundDegree * 2) + (outboundDegree * 1)
     */
    private calculateScore(depth: number, impactedNodeId: string): number {
        const inboundDegree = this.store.getInboundEdges(impactedNodeId).length;
        const outboundDegree = this.store.getOutboundEdges(impactedNodeId).length;
        return (depth * 1) + (inboundDegree * 2) + (outboundDegree * 1);
    }

    /**
     * Fully orchestrates the explanation of a root node's blast radius.
     */
    public explainBlastRadius(rootNodeId: string): BlastRadiusExplanation {
        const walkerResult = this.walker.getBlastRadius(rootNodeId);
        
        let highestDepth = 0;
        const explanations: ImpactExplanation[] = [];
        const uniqueSubsystems = new Set<string>();

        // We process the reachable nodes (which are the dependent nodes)
        // Note: walker.getBlastRadius traverses DEPENDENTS (inbound edges to root)
        // so the shortestPath is actually [Root, ..., Impacted].
        for (const reachable of walkerResult.reachableNodes) {
            if (reachable.depth > highestDepth) {
                highestDepth = reachable.depth;
            }

            const subsystem = this.extractSubsystem(reachable.node.filePath);
            uniqueSubsystems.add(subsystem);

            const evidence = this.buildEvidenceFromPath(reachable.shortestPath);
            const score = this.calculateScore(reachable.depth, reachable.nodeId);

            const explanation: ImpactExplanation = {
                rootNodeId: rootNodeId,
                impactedNodeId: reachable.nodeId,
                shortestPath: { steps: evidence, depth: reachable.depth },
                explanationDepth: reachable.depth,
                impactedSubsystems: [subsystem],
                evidence: evidence,
                criticalityScore: score
            };

            explanations.push(explanation);
        }

        // Rank explanations by criticalityScore descending
        explanations.sort((a, b) => b.criticalityScore - a.criticalityScore);

        // Truncate to safe limits
        const truncatedExplanations = explanations.slice(0, this.MAX_IMPACT_EXPLANATIONS);

        // Extract critical paths for summary
        const criticalPaths = truncatedExplanations
            .slice(0, this.MAX_CRITICAL_PATHS)
            .map(exp => exp.shortestPath);

        const topImpactedNodes = truncatedExplanations
            .slice(0, this.MAX_CRITICAL_PATHS)
            .map(exp => exp.impactedNodeId);

        return {
            rootNodeId,
            summary: {
                rootNodeId,
                totalImpactedNodes: walkerResult.reachableNodes.length,
                highestDepth,
                topImpactedNodes,
                criticalPaths,
                impactedSubsystems: Array.from(uniqueSubsystems)
            },
            impactExplanations: truncatedExplanations
        };
    }

    /**
     * Explain specifically why one node impacts another.
     */
    public explainImpact(rootNodeId: string, impactedNodeId: string): ImpactExplanation | null {
        const pathResult = this.pathEngine.explainImpact(rootNodeId, impactedNodeId);
        
        if (!pathResult.shortestPath || pathResult.shortestPath.depth === 0) {
            return null;
        }

        const impactedNode = this.store.getNode(impactedNodeId);
        const subsystem = impactedNode ? this.extractSubsystem(impactedNode.filePath) : 'unknown';
        const score = this.calculateScore(pathResult.shortestPath.depth, impactedNodeId);

        return {
            rootNodeId,
            impactedNodeId,
            shortestPath: pathResult.shortestPath,
            explanationDepth: pathResult.shortestPath.depth,
            impactedSubsystems: [subsystem],
            evidence: pathResult.shortestPath.steps,
            criticalityScore: score
        };
    }

    /**
     * Return only the summary, saving some bandwidth.
     */
    public summarizeBlastRadius(rootNodeId: string): BlastRadiusSummary {
        return this.explainBlastRadius(rootNodeId).summary;
    }
}
