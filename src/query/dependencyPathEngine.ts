import { ProgramGraphStore } from '../store/programGraphStore';
import { ProgramGraphEdgeType, ProgramGraphEdge } from '../graph/programGraphTypes';

export interface PathStep {
    fromNodeId: string;
    toNodeId: string;
    edgeType: ProgramGraphEdgeType;
    edgeWeight?: number;
}

export interface DependencyPath {
    steps: PathStep[];
    depth: number;
}

export interface DependencyPathResult {
    sourceNodeId: string;
    targetNodeId: string;
    shortestPath?: DependencyPath;
    paths: DependencyPath[];
    totalPathsFound: number;
    isTruncated: boolean;
}

export class DependencyPathEngine {
    constructor(private store: ProgramGraphStore) {}

    /**
     * Answers: "How does source reach target via the shortest route?"
     * Uses BFS to find the shortest point-to-point path.
     */
    public findShortestPath(sourceId: string, targetId: string, edgeTypes?: ProgramGraphEdgeType[], maxDepth = 15): DependencyPathResult {
        const result: DependencyPathResult = {
            sourceNodeId: sourceId,
            targetNodeId: targetId,
            paths: [],
            totalPathsFound: 0,
            isTruncated: false
        };

        if (!this.store.isLoaded() || !this.store.getNode(sourceId) || !this.store.getNode(targetId)) {
            return result;
        }

        if (sourceId === targetId) {
            result.shortestPath = { steps: [], depth: 0 };
            result.paths.push(result.shortestPath);
            result.totalPathsFound = 1;
            return result;
        }

        const validEdgeTypes = edgeTypes ? new Set(edgeTypes) : null;
        const visited = new Set<string>();
        
        // Queue stores { id, depth, currentPath }
        const queue: { id: string; depth: number; currentPath: PathStep[] }[] = [];
        
        queue.push({ id: sourceId, depth: 0, currentPath: [] });
        visited.add(sourceId);

        while (queue.length > 0) {
            const current = queue.shift()!;
            
            if (current.id === targetId) {
                result.shortestPath = { steps: current.currentPath, depth: current.depth };
                result.paths.push(result.shortestPath);
                result.totalPathsFound = 1;
                return result;
            }

            if (current.depth >= maxDepth) {
                continue;
            }

            // We look at outbound edges from 'current' to see what it depends on/calls/reaches
            const edges = this.store.getOutboundEdges(current.id);

            for (const edge of edges) {
                if (validEdgeTypes && !validEdgeTypes.has(edge.type)) {
                    continue;
                }

                if (!visited.has(edge.to)) {
                    visited.add(edge.to);
                    
                    const step: PathStep = {
                        fromNodeId: edge.from,
                        toNodeId: edge.to,
                        edgeType: edge.type,
                        edgeWeight: edge.weight
                    };
                    
                    queue.push({
                        id: edge.to,
                        depth: current.depth + 1,
                        currentPath: [...current.currentPath, step]
                    });
                }
            }
        }

        return result;
    }

    /**
     * Answers: "Show me every possible way source reaches target."
     * Uses DFS with mandatory explosion limits to enumerate paths.
     */
    public findAllPaths(sourceId: string, targetId: string, edgeTypes?: ProgramGraphEdgeType[], maxDepth = 10, maxPaths = 100): DependencyPathResult {
        const result: DependencyPathResult = {
            sourceNodeId: sourceId,
            targetNodeId: targetId,
            paths: [],
            totalPathsFound: 0,
            isTruncated: false
        };

        if (!this.store.isLoaded() || !this.store.getNode(sourceId) || !this.store.getNode(targetId)) {
            return result;
        }

        if (sourceId === targetId) {
            result.shortestPath = { steps: [], depth: 0 };
            result.paths.push(result.shortestPath);
            result.totalPathsFound = 1;
            return result;
        }

        const validEdgeTypes = edgeTypes ? new Set(edgeTypes) : null;
        
        // Internal DFS routine
        const dfs = (currentId: string, depth: number, currentPath: PathStep[], visited: Set<string>) => {
            if (result.isTruncated) {
                return; // Global abort
            }

            if (currentId === targetId) {
                const completedPath: DependencyPath = { steps: [...currentPath], depth };
                result.paths.push(completedPath);
                result.totalPathsFound++;
                
                // Track shortest path manually during DFS
                if (!result.shortestPath || completedPath.depth < result.shortestPath.depth) {
                    result.shortestPath = completedPath;
                }

                if (result.totalPathsFound >= maxPaths) {
                    result.isTruncated = true;
                }
                return;
            }

            if (depth >= maxDepth) {
                return;
            }

            const edges = this.store.getOutboundEdges(currentId);

            for (const edge of edges) {
                if (validEdgeTypes && !validEdgeTypes.has(edge.type)) {
                    continue;
                }

                if (!visited.has(edge.to)) {
                    // Clone visited set strictly for this path branch to prevent inter-path pollution
                    // and inherently prevent A -> B -> A cycles within the same path
                    const nextVisited = new Set(visited);
                    nextVisited.add(edge.to);
                    
                    const step: PathStep = {
                        fromNodeId: edge.from,
                        toNodeId: edge.to,
                        edgeType: edge.type,
                        edgeWeight: edge.weight
                    };

                    currentPath.push(step);
                    dfs(edge.to, depth + 1, currentPath, nextVisited);
                    currentPath.pop(); // Backtrack
                }
            }
        };

        // Initialize DFS
        const initialVisited = new Set<string>();
        initialVisited.add(sourceId);
        dfs(sourceId, 0, [], initialVisited);

        return result;
    }

    /**
     * Answers: "Why does source depend on target?"
     * Alias for shortest path outbound from source.
     */
    public explainDependency(sourceId: string, dependencyId: string): DependencyPathResult {
        return this.findShortestPath(sourceId, dependencyId, ['calls', 'imports', 'reads', 'instantiates', 'assigns']);
    }

    /**
     * Answers: "Why is impactedId in the blast radius of rootId?"
     * We want to see how a change in rootId propagates to impactedId.
     * That means we look at outbound edges from rootId that eventually reach impactedId.
     * (e.g. rootId -> reads -> impactedId, or impactedId -> calls -> rootId... wait)
     * Wait, if rootId is modified, how does it affect impactedId?
     * It affects impactedId if impactedId depends on rootId (impactedId -> calls -> rootId).
     * Therefore, the path from impactedId to rootId explains the dependency!
     */
    public explainImpact(rootId: string, impactedId: string): DependencyPathResult {
        // Impact propagates backward across the dependency graph.
        // If impactedId is in rootId's blast radius, impactedId depends on rootId.
        // Thus, the path originates at impactedId and targets rootId.
        return this.findShortestPath(impactedId, rootId, ['calls', 'imports', 'reads', 'instantiates', 'assigns']);
    }

    /**
     * (Future Capability Placeholder)
     * Retrieves the top K most relevant paths.
     */
    public findTopKPaths(sourceId: string, targetId: string, k: number): void {
        throw new Error("findTopKPaths is a future capability pending the Risk Engine.");
    }
}
