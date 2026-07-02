import { ProgramGraphStore } from '../store/programGraphStore';
import { BlastRadiusExplanationEngine } from './blastRadiusExplanationEngine';
import { DependencyPath } from './dependencyPathEngine';

export type RiskSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface StructuralRiskFactors {
    impactedNodeCount: number;
    maxDepth: number;
    criticalPathCount: number;
    subsystemCount: number;
    inboundDegree: number;
    outboundDegree: number;
}

export interface RiskFactors {
    structural: StructuralRiskFactors;
    // intent: IntentRiskFactors; // Future
    // evolution: EvolutionRiskFactors; // Future
}

export interface RiskRationale {
    topReasons: string[];
    criticalPaths: DependencyPath[];
}

export interface RiskAssessment {
    nodeId: string;
    score: number;
    severity: RiskSeverity;
    factors: RiskFactors;
    rationale: RiskRationale;
}

export class RiskEngine {
    constructor(
        private store: ProgramGraphStore,
        private explanationEngine: BlastRadiusExplanationEngine
    ) {}

    /**
     * Maps a 0-100 score to a severity category.
     */
    private getSeverity(score: number): RiskSeverity {
        if (score <= 20) return "LOW";
        if (score <= 50) return "MEDIUM";
        if (score <= 80) return "HIGH";
        return "CRITICAL";
    }

    /**
     * Deterministically assesses the risk of modifying a node.
     */
    public assessNodeRisk(nodeId: string): RiskAssessment {
        const inboundDegree = this.store.getInboundEdges(nodeId).length;
        const outboundDegree = this.store.getOutboundEdges(nodeId).length;

        // If the node doesn't exist or has no inbound edges, the structural risk is low
        if (!this.store.isLoaded() || !this.store.getNode(nodeId)) {
            return this.createEmptyAssessment(nodeId);
        }

        const summary = this.explanationEngine.summarizeBlastRadius(nodeId);

        const structural: StructuralRiskFactors = {
            impactedNodeCount: summary.totalImpactedNodes,
            maxDepth: summary.highestDepth,
            criticalPathCount: summary.criticalPaths.length,
            subsystemCount: summary.impactedSubsystems.length,
            inboundDegree,
            outboundDegree
        };

        const score = this.calculateStructuralScore(structural);
        const severity = this.getSeverity(score);
        const reasons = this.generateReasons(structural);

        return {
            nodeId,
            score,
            severity,
            factors: { structural },
            rationale: {
                topReasons: reasons,
                criticalPaths: summary.criticalPaths
            }
        };
    }

    /**
     * Alias for assessing the risk of a proposed change to a node.
     */
    public assessChangeRisk(nodeId: string): RiskAssessment {
        return this.assessNodeRisk(nodeId);
    }

    /**
     * Alias for explaining the risk of a node.
     */
    public explainRisk(nodeId: string): RiskAssessment {
        return this.assessNodeRisk(nodeId);
    }

    /**
     * Calculates the deterministic risk score based on structural factors.
     * Formula:
     * (impactedNodeCount * 2) + (maxDepth * 4) + (criticalPathCount * 5) + 
     * (subsystemCount * 5) + (inboundDegree * 2) + (outboundDegree * 1)
     */
    private calculateStructuralScore(factors: StructuralRiskFactors): number {
        let score = 
            (factors.impactedNodeCount * 2) +
            (factors.maxDepth * 4) +
            (factors.criticalPathCount * 5) +
            (factors.subsystemCount * 5) +
            (factors.inboundDegree * 2) +
            (factors.outboundDegree * 1);
        
        return Math.min(score, 100);
    }

    /**
     * Generates a list of string reasons deterministically.
     */
    private generateReasons(factors: StructuralRiskFactors): string[] {
        const reasons: string[] = [];
        if (factors.impactedNodeCount > 0) reasons.push(`${factors.impactedNodeCount} impacted nodes`);
        if (factors.maxDepth > 0) reasons.push(`${factors.maxDepth} dependency layers`);
        if (factors.criticalPathCount > 0) reasons.push(`${factors.criticalPathCount} critical paths`);
        if (factors.subsystemCount > 0) reasons.push(`touches ${factors.subsystemCount} subsystems`);
        if (factors.inboundDegree > 0) reasons.push(`${factors.inboundDegree} direct inbound dependents`);
        return reasons;
    }

    /**
     * Creates an empty baseline assessment for nodes with no impact or missing nodes.
     */
    private createEmptyAssessment(nodeId: string): RiskAssessment {
        return {
            nodeId,
            score: 0,
            severity: "LOW",
            factors: {
                structural: {
                    impactedNodeCount: 0,
                    maxDepth: 0,
                    criticalPathCount: 0,
                    subsystemCount: 0,
                    inboundDegree: 0,
                    outboundDegree: 0
                }
            },
            rationale: { topReasons: ["No structural impact found"], criticalPaths: [] }
        };
    }

    /**
     * Lightweight V1 ranker: avoids O(V * (V+E)) graph explosion.
     * Ranks all nodes in the repository based on base heuristic (degree centrality),
     * and evaluates the exact full score only on the Top M candidates.
     */
    public rankRepositoryRisk(topN: number = 10): RiskAssessment[] {
        if (!this.store.isLoaded()) {
            return [];
        }

        const nodes = Object.values((this.store as any).graph.nodes as any[]);
        
        // Step 1: Pre-filter using lightweight metrics to avoid computing full blast radius 10,000 times
        const lightweightScored = nodes.map((node: any) => {
            const inbound = this.store.getInboundEdges(node.id).length;
            const outbound = this.store.getOutboundEdges(node.id).length;
            // Simple proxy for risk: highly depended upon nodes
            const heuristicScore = (inbound * 3) + (outbound * 1);
            return { id: node.id, heuristicScore };
        });

        // Sort descending by heuristic
        lightweightScored.sort((a, b) => b.heuristicScore - a.heuristicScore);

        // Take top M candidates (we'll take 50 to be safe, ensuring we catch edge cases where a low-degree node has huge depth)
        // For very small repositories, just take all.
        const candidateCount = Math.min(lightweightScored.length, Math.max(topN * 3, 50));
        const topCandidates = lightweightScored.slice(0, candidateCount);

        // Step 2: Compute exact risk for the top candidates
        const exactAssessments: RiskAssessment[] = [];
        for (const candidate of topCandidates) {
            exactAssessments.push(this.assessNodeRisk(candidate.id));
        }

        // Sort descending by actual risk score
        exactAssessments.sort((a, b) => b.score - a.score);

        // Return top N
        return exactAssessments.slice(0, topN);
    }
}
