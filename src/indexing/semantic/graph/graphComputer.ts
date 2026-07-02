import { IShadowGraphStore } from '../shadowGraphStoreContract';
import { CanonicalFact } from '../canonicalFact';
import { SemanticGraph } from './semanticGraph';
import { SemanticGraphNode, SemanticGraphEdge } from './semanticGraphModels';
import { GraphDiagnostics, GraphIntegrityViolation } from './graphDiagnostics';
import { GraphRecomputationPlan } from './graphRecomputationModels';

export class GraphComputer {
    /**
     * Deterministically computes the SemanticGraph from the given IShadowGraphStore.
     */
    public static compute(store: IShadowGraphStore): SemanticGraph {
        const allFacts = store.getAllFacts();
        
        // Sort facts deterministically by factId
        const sortedFacts = [...allFacts].sort((a, b) => a.factId.localeCompare(b.factId));

        const nodesMap = new Map<string, SemanticGraphNode>();
        const edgesList: SemanticGraphEdge[] = [];
        
        const unknownFacts: CanonicalFact[] = [];
        const missingEndpoints: GraphIntegrityViolation[] = [];
        const integrityViolations: GraphIntegrityViolation[] = [];
        const rejectedFacts: CanonicalFact[] = [];
        const buildWarnings: string[] = [];

        // Pass 1: Extract and register all ENTITY facts as nodes
        for (const fact of sortedFacts) {
            if (fact.factType === 'ENTITY') {
                const node: SemanticGraphNode = {
                    nodeId: fact.factId,
                    name: String(fact.payload.name || ''),
                    entityKind: String(fact.payload.entityKind || ''),
                    originatingFacts: [fact.factId],
                    payload: fact.payload
                };
                nodesMap.set(node.nodeId, node);
            } else if (fact.factType === 'UNKNOWN') {
                unknownFacts.push(fact);
            }
        }

        // Pass 2: Extract and validate all RELATIONSHIP facts as edges
        for (const fact of sortedFacts) {
            if (fact.factType === 'RELATIONSHIP') {
                const sourceIdentity = fact.payload.source;
                const targetIdentity = fact.payload.target;
                
                // We must map canonicalId structures back to a node.
                // The current schema creates node.nodeId equal to the factId of the ENTITY.
                // However, the relationship payload.source and payload.target hold CanonicalIdentity JSON, 
                // not the target factId.
                // We need to resolve the matching ENTITY fact.
                // A correct approach given the current models: The source/target CanonicalIdentity must be exactly matched.
                
                const sourceNodeId = this.resolveNodeId(nodesMap, sourceIdentity);
                const targetNodeId = this.resolveNodeId(nodesMap, targetIdentity);

                let isValid = true;
                if (!sourceNodeId) {
                    missingEndpoints.push({
                        type: 'MissingEndpoint',
                        edgeId: fact.factId,
                        missingCanonicalIdentity: JSON.stringify(sourceIdentity),
                        description: 'Missing source endpoint for relationship'
                    });
                    isValid = false;
                }
                
                if (!targetNodeId) {
                    missingEndpoints.push({
                        type: 'MissingEndpoint',
                        edgeId: fact.factId,
                        missingCanonicalIdentity: JSON.stringify(targetIdentity),
                        description: 'Missing target endpoint for relationship'
                    });
                    isValid = false;
                }

                if (isValid && sourceNodeId && targetNodeId) {
                    const edge: SemanticGraphEdge = {
                        edgeId: fact.factId,
                        category: String(fact.payload.category || ''),
                        relationshipKind: String(fact.payload.relationshipKind || ''),
                        sourceNodeId: sourceNodeId,
                        targetNodeId: targetNodeId,
                        originatingFacts: [fact.factId],
                        payload: fact.payload
                    };
                    edgesList.push(edge);
                }
            }
        }

        const diagnostics: GraphDiagnostics = {
            unknownFacts,
            missingEndpoints,
            integrityViolations,
            rejectedFacts,
            buildWarnings
        };

        return new SemanticGraph(
            Array.from(nodesMap.values()).sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
            edgesList.sort((a, b) => a.edgeId.localeCompare(b.edgeId)),
            diagnostics
        );
    }

    /**
     * Deterministically incrementally computes the SemanticGraph from a recomputation plan.
     */
    public static computeIncremental(previousGraph: SemanticGraph, plan: GraphRecomputationPlan): SemanticGraph {
        // 1. Clone maps
        const nodesMap = new Map<string, SemanticGraphNode>();
        for (const node of previousGraph.getAllNodes()) {
            nodesMap.set(node.nodeId, node);
        }

        const edgesList: SemanticGraphEdge[] = [...previousGraph.getAllEdges()];
        const unknownFacts: CanonicalFact[] = [...previousGraph.diagnostics.unknownFacts];
        
        // We rebuild missingEndpoints excluding ones that are re-evaluated or removed.
        let missingEndpoints: GraphIntegrityViolation[] = [...previousGraph.diagnostics.missingEndpoints];

        const integrityViolations: GraphIntegrityViolation[] = [...previousGraph.diagnostics.integrityViolations];
        const rejectedFacts: CanonicalFact[] = [...previousGraph.diagnostics.rejectedFacts];
        const buildWarnings: string[] = [...previousGraph.diagnostics.buildWarnings];

        const removedIds = new Set(plan.delta.removedFactIds);

        // 2. Process Removals
        if (removedIds.size > 0) {
            // Remove nodes
            for (const id of removedIds) {
                nodesMap.delete(id);
            }

            // Remove edges explicitly, or edges broken by node removal
            for (let i = edgesList.length - 1; i >= 0; i--) {
                const edge = edgesList[i];
                if (removedIds.has(edge.edgeId)) {
                    edgesList.splice(i, 1);
                } else if (removedIds.has(edge.sourceNodeId) || removedIds.has(edge.targetNodeId)) {
                    edgesList.splice(i, 1);
                    
                    const fact = plan.contextualFacts.find(f => f.factId === edge.edgeId);
                    if (fact) {
                        const sourceIdentity = fact.payload.source;
                        const targetIdentity = fact.payload.target;

                        if (removedIds.has(edge.sourceNodeId)) {
                            missingEndpoints.push({
                                type: 'MissingEndpoint',
                                edgeId: fact.factId,
                                missingCanonicalIdentity: JSON.stringify(sourceIdentity),
                                description: 'Missing source endpoint for relationship'
                            });
                        }
                        if (removedIds.has(edge.targetNodeId)) {
                            missingEndpoints.push({
                                type: 'MissingEndpoint',
                                edgeId: fact.factId,
                                missingCanonicalIdentity: JSON.stringify(targetIdentity),
                                description: 'Missing target endpoint for relationship'
                            });
                        }
                    } else {
                        integrityViolations.push({
                            type: 'Other',
                            edgeId: edge.edgeId,
                            description: 'Broken edge dropped without context fact for missing endpoint recovery'
                        });
                    }
                }
            }

            // Remove explicit diagnostic removals
            missingEndpoints = missingEndpoints.filter(d => !d.edgeId || !removedIds.has(d.edgeId));
            for (let i = unknownFacts.length - 1; i >= 0; i--) {
                if (removedIds.has(unknownFacts[i].factId)) {
                    unknownFacts.splice(i, 1);
                }
            }
        }

        // 3. Process Additions & Re-evaluations
        const addedFacts = [...plan.delta.addedFacts].sort((a, b) => a.factId.localeCompare(b.factId));
        
        for (const fact of addedFacts) {
            if (fact.factType === 'ENTITY') {
                const node: SemanticGraphNode = {
                    nodeId: fact.factId,
                    name: String(fact.payload.name || ''),
                    entityKind: String(fact.payload.entityKind || ''),
                    originatingFacts: [fact.factId],
                    payload: fact.payload
                };
                nodesMap.set(node.nodeId, node);
            } else if (fact.factType === 'UNKNOWN') {
                unknownFacts.push(fact);
            }
        }

        const relationshipsToEvaluate = new Map<string, CanonicalFact>();
        for (const fact of addedFacts) {
            if (fact.factType === 'RELATIONSHIP') {
                relationshipsToEvaluate.set(fact.factId, fact);
            }
        }
        for (const fact of plan.contextualFacts) {
            if (fact.factType === 'RELATIONSHIP') {
                relationshipsToEvaluate.set(fact.factId, fact);
            }
        }

        missingEndpoints = missingEndpoints.filter(d => !d.edgeId || !relationshipsToEvaluate.has(d.edgeId));

        const sortedRelationships = Array.from(relationshipsToEvaluate.values()).sort((a, b) => a.factId.localeCompare(b.factId));
        
        for (const fact of sortedRelationships) {
            const sourceIdentity = fact.payload.source;
            const targetIdentity = fact.payload.target;
            
            const sourceNodeId = this.resolveNodeId(nodesMap, sourceIdentity);
            const targetNodeId = this.resolveNodeId(nodesMap, targetIdentity);

            let isValid = true;
            if (!sourceNodeId) {
                missingEndpoints.push({
                    type: 'MissingEndpoint',
                    edgeId: fact.factId,
                    missingCanonicalIdentity: JSON.stringify(sourceIdentity),
                    description: 'Missing source endpoint for relationship'
                });
                isValid = false;
            }
            
            if (!targetNodeId) {
                missingEndpoints.push({
                    type: 'MissingEndpoint',
                    edgeId: fact.factId,
                    missingCanonicalIdentity: JSON.stringify(targetIdentity),
                    description: 'Missing target endpoint for relationship'
                });
                isValid = false;
            }

            if (isValid && sourceNodeId && targetNodeId) {
                const existingIndex = edgesList.findIndex(e => e.edgeId === fact.factId);
                if (existingIndex >= 0) {
                    edgesList.splice(existingIndex, 1);
                }

                const edge: SemanticGraphEdge = {
                    edgeId: fact.factId,
                    category: String(fact.payload.category || ''),
                    relationshipKind: String(fact.payload.relationshipKind || ''),
                    sourceNodeId: sourceNodeId,
                    targetNodeId: targetNodeId,
                    originatingFacts: [fact.factId],
                    payload: fact.payload
                };
                edgesList.push(edge);
            }
        }

        // Maintain strict deterministic sorting
        unknownFacts.sort((a, b) => a.factId.localeCompare(b.factId));
        missingEndpoints.sort((a, b) => {
            const cmp = (a.edgeId || '').localeCompare(b.edgeId || '');
            if (cmp !== 0) return cmp;
            return a.description.localeCompare(b.description);
        });
        integrityViolations.sort((a, b) => (a.edgeId || '').localeCompare(b.edgeId || ''));
        rejectedFacts.sort((a, b) => a.factId.localeCompare(b.factId));
        buildWarnings.sort((a, b) => a.localeCompare(b));

        const diagnostics: GraphDiagnostics = {
            unknownFacts,
            missingEndpoints,
            integrityViolations,
            rejectedFacts,
            buildWarnings
        };

        return new SemanticGraph(
            Array.from(nodesMap.values()).sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
            edgesList.sort((a, b) => a.edgeId.localeCompare(b.edgeId)),
            diagnostics
        );
    }

    /**
     * Resolves a CanonicalIdentity to an existing SemanticGraphNode.
     */
    private static resolveNodeId(nodesMap: Map<string, SemanticGraphNode>, identity: any): string | undefined {
        if (!identity) return undefined;
        
        // Find a node whose payload.canonicalId matches the identity structurally.
        // We compare properties of the identity.
        for (const node of nodesMap.values()) {
            const canonicalId = node.payload.canonicalId;
            if (canonicalId && this.identitiesMatch(canonicalId, identity)) {
                return node.nodeId;
            }
        }
        return undefined;
    }

    private static identitiesMatch(id1: any, id2: any): boolean {
        if (!id1 || !id2) return false;
        return id1.kind === id2.kind &&
               id1.package === id2.package &&
               id1.logicalNamespace === id2.logicalNamespace &&
               id1.qualifiedName === id2.qualifiedName &&
               id1.signatureHash === id2.signatureHash;
    }
}
