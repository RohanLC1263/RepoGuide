import { ProgramGraphStore } from '../store/programGraphStore';
import { ProgramGraphEdgeType } from '../graph/programGraphTypes';
import { UsageHeuristicEvaluator, UsageClassification } from './usageHeuristicEvaluator';

export interface ImpactAssessment {
    actionableFiles: string[];
    safeFiles: string[];
    ignoredFiles: string[];
    reasoning: Record<string, string>;
    confidence: 'high' | 'medium' | 'low';
    evidence: any[];
}

export class SemanticImpactEngine {
    constructor(
        private graphStore: ProgramGraphStore,
        private evaluator: UsageHeuristicEvaluator
    ) {}

    async assessImpact(targetSymbolId: string, changeIntent?: string): Promise<ImpactAssessment> {
        const actionableFiles = new Set<string>();
        const safeFiles = new Set<string>();
        const ignoredFiles = new Set<string>();
        const reasoning: Record<string, string> = {};
        
        if (!this.graphStore.isLoaded()) {
            return { actionableFiles: [], safeFiles: [], ignoredFiles: [], reasoning: {}, confidence: 'low', evidence: [] };
        }

        // We will do a BFS traversal (DEPENDENTS direction) but classify each node
        let rootNodes = [targetSymbolId];
        if (!this.graphStore.getNode(targetSymbolId)) {
            const resolved = this.graphStore.getNodesBySymbol(targetSymbolId);
            if (resolved.length > 0) {
                rootNodes = resolved;
            } else {
                return { actionableFiles: [], safeFiles: [], ignoredFiles: [], reasoning: {}, confidence: 'low', evidence: [] };
            }
        }

        const queue: { id: string; depth: number; targetSymbolName: string }[] = [];
        const visited = new Set<string>();

        for (const root of rootNodes) {
            const node = this.graphStore.getNode(root);
            queue.push({ id: root, depth: 0, targetSymbolName: node?.symbol || targetSymbolId });
            visited.add(root);
        }

        while (queue.length > 0) {
            const current = queue.shift()!;
            
            // Get inbound edges (who depends on current)
            const inboundEdges = this.graphStore.getInboundEdges(current.id);
            
            for (const edge of inboundEdges) {
                // Determine if we should process this edge based on its type
                if (edge.type === 'contains' || edge.type === 'decorates') continue;

                if (!visited.has(edge.from)) {
                    visited.add(edge.from);
                    
                    const consumerNode = this.graphStore.getNode(edge.from);
                    const consumerFile = consumerNode?.filePath;
                    
                    if (consumerFile) {
                        const evalResult = await this.evaluator.evaluateUsage(edge.from, current.targetSymbolName, edge.type);
                        
                        // Keep the most critical reasoning if visited multiple times or from different paths?
                        // Here visited.add(edge.from) ensures we only process a node once.
                        reasoning[consumerFile] = evalResult.reasoning;
                        
                        if (evalResult.classification === 'Actionable') {
                            actionableFiles.add(consumerFile);
                            // Propagate danger upstream
                            queue.push({ 
                                id: edge.from, 
                                depth: current.depth + 1, 
                                targetSymbolName: consumerNode?.symbol || current.targetSymbolName 
                            });
                        } else if (evalResult.classification === 'Safe') {
                            safeFiles.add(consumerFile);
                            // Do not propagate further
                        } else if (evalResult.classification === 'Noise') {
                            ignoredFiles.add(consumerFile);
                            // Do not propagate
                        }
                    }
                }
            }
        }
        
        return {
            actionableFiles: Array.from(actionableFiles),
            safeFiles: Array.from(safeFiles),
            ignoredFiles: Array.from(ignoredFiles),
            reasoning,
            confidence: 'high',
            evidence: []
        };
    }
}
