import { randomUUID } from 'crypto';
import { ProgramGraphStore } from '../store/programGraphStore';
import { ADRCodeLinkStore } from '../intent/linking/adrCodeLinkStore';
import { IntentStore } from '../intent/extraction/intentStore';
import { IntentGraphQueryEngine } from '../intent/graph/intentGraphQueryEngine';
import { IntentAwareBlastRadiusStore } from './intentAwareBlastRadiusStore';
import { StructuralImpactAnalyzer } from './structuralImpactAnalyzer';
import { GovernanceScorer } from './governanceScorer';
import { IntentAwareImpact, IntentImpactPath, GovernanceEvidence } from './intentAwareBlastRadiusTypes';

export class IntentAwareBlastRadiusEngine {
    private structuralAnalyzer: StructuralImpactAnalyzer;
    private scorer: GovernanceScorer;

    constructor(
        private graphStore: ProgramGraphStore,
        private adrCodeLinkStore: ADRCodeLinkStore,
        private intentStore: IntentStore,
        private intentGraphQuery: IntentGraphQueryEngine,
        private impactStore: IntentAwareBlastRadiusStore
    ) {
        this.structuralAnalyzer = new StructuralImpactAnalyzer(this.graphStore);
        this.scorer = new GovernanceScorer();
    }

    /**
     * Compute a unique string representing the combined version state of the governance layer.
     * This acts as the cache invalidation key.
     */
    private computeGovernanceSnapshotVersion(): string {
        // Mock versions for now. In a real system, these would read from actual store versions.
        // Assuming ProgramGraphStore has a version or we use timestamp if not provided.
        const pgVersion = (this.graphStore as any).version || Date.now().toString();
        // Return a combined hash
        return `snap_${pgVersion}`;
    }

    public async analyzeNode(rootNodeId: string): Promise<IntentAwareImpact> {
        const snapshotVersion = this.computeGovernanceSnapshotVersion();

        // Check if we already have this computed for the current snapshot
        const cached = this.impactStore.getImpact(rootNodeId, snapshotVersion);
        if (cached) return cached;

        const impactId = randomUUID();
        const generatedAt = new Date();

        // 1. Structural Blast Radius
        const structuralImpactMap = this.structuralAnalyzer.getImpactZone(rootNodeId);
        const impactedNodeIds = Array.from(structuralImpactMap.keys());

        // 2. ADR Resolution (Chunked IN query pattern)
        const uniqueADRs = new Set<string>();
        const paths: IntentImpactPath[] = [];
        const evidence: GovernanceEvidence[] = [];

        // Chunk node lookups to avoid SQLite variable limits (999)
        const CHUNK_SIZE = 900;
        for (let i = 0; i < impactedNodeIds.length; i += CHUNK_SIZE) {
            const chunk = impactedNodeIds.slice(i, i + CHUNK_SIZE);
            const chunkLinks = this.adrCodeLinkStore.getLinksForNodes(chunk); 
            
            for (const link of chunkLinks) {
                const nodeId = link.nodeId;
                const adrId = link.adrId;
                const pathLength = structuralImpactMap.get(nodeId) || 0;
                
                uniqueADRs.add(adrId);
                
                evidence.push({
                    impactId,
                    evidenceType: "ADR_LINK",
                    sourceId: nodeId,
                    targetId: adrId
                });

                paths.push({
                    impactId,
                    rootNodeId,
                    impactedNodeId: nodeId,
                    adrId,
                    intentId: '', // To be filled
                    pathLength
                });
            }
        }

        // 3. Intent Resolution
        const uniqueIntents = new Set<string>();
        for (const adrId of uniqueADRs) {
            // Get intents supported by this ADR
            const adrIntents = this.intentStore.getIntentsByEvidenceSource(adrId, 'ADR');
            for (const intent of adrIntents) {
                uniqueIntents.add(intent.id);
                
                evidence.push({
                    impactId,
                    evidenceType: "INTENT_LINK",
                    sourceId: adrId,
                    targetId: intent.id
                });

                // Update paths
                for (const p of paths) {
                    if (p.adrId === adrId && !p.intentId) {
                        p.intentId = intent.id;
                    } else if (p.adrId === adrId && p.intentId !== intent.id) {
                        // Clone path for multiple intents
                        paths.push({
                            ...p,
                            intentId: intent.id
                        });
                    }
                }
            }
        }

        // 4. Intent Graph Expansion (Depth 1)
        const uniqueNeighbors = new Set<string>();
        for (const intentId of uniqueIntents) {
            // Assume we can get strong neighbors
            const neighborhood = this.intentGraphQuery.getNeighbors(intentId);
            for (const edge of neighborhood.edges) {
                const neighborId = edge.sourceIntentId === intentId ? edge.targetIntentId : edge.sourceIntentId;
                if (!uniqueIntents.has(neighborId)) {
                    uniqueNeighbors.add(neighborId);
                    
                    evidence.push({
                        impactId,
                        evidenceType: "INTENT_GRAPH",
                        sourceId: intentId,
                        targetId: neighborId
                    });
                }
            }
        }

        // 5. Governance Scoring
        const score = this.scorer.calculateScore(uniqueADRs.size, uniqueIntents.size, uniqueNeighbors.size);
        const severity = this.scorer.determineSeverity(score);

        const impact: IntentAwareImpact = {
            id: impactId,
            rootNodeId,
            governanceSnapshotVersion: snapshotVersion,
            impactedNodeIds,
            impactedADRIds: Array.from(uniqueADRs),
            impactedIntentIds: Array.from(uniqueIntents),
            impactedNeighborIntentIds: Array.from(uniqueNeighbors),
            governanceScore: score,
            governanceSeverity: severity,
            generatedAt
        };

        // 6. Persistence
        this.impactStore.saveImpact(impact, paths.filter(p => p.intentId !== ''), evidence);

        return impact;
    }

    public async analyzeNodes(nodeIds: string[]): Promise<IntentAwareImpact[]> {
        const impacts: IntentAwareImpact[] = [];
        for (const id of nodeIds) {
            impacts.push(await this.analyzeNode(id));
        }
        return impacts;
    }
}
