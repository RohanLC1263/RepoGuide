import { SemanticGraph } from './semanticGraph';
import { GraphDelta, GraphUpdateRequest } from './graphRecomputationModels';

export class GraphUpdatePlanner {
    /**
     * Determines which graph facts require recomputation based on the repository delta.
     * Does not perform Store access.
     */
    public static plan(previousGraph: SemanticGraph, delta: GraphDelta): GraphUpdateRequest {
        const requiredContextFactIds = new Set<string>();

        // 1. We must re-evaluate any existing relationship that was previously missing an endpoint,
        // because newly added ENTITY facts might now resolve those endpoints.
        for (const diagnostic of previousGraph.diagnostics.missingEndpoints) {
            if (diagnostic.edgeId) {
                requiredContextFactIds.add(diagnostic.edgeId);
            }
        }

        // 2. We must re-evaluate any edge connected to a removed ENTITY,
        // because removing the entity breaks the edge and it must become a MissingEndpoint diagnostic,
        // which requires the original relationship fact payload.
        for (const removedFactId of delta.removedFactIds) {
            // Check outgoing edges
            for (const edge of previousGraph.getOutgoingEdges(removedFactId)) {
                if (edge.originatingFacts.length > 0) {
                    requiredContextFactIds.add(edge.originatingFacts[0]);
                }
            }
            // Check incoming edges
            for (const edge of previousGraph.getIncomingEdges(removedFactId)) {
                if (edge.originatingFacts.length > 0) {
                    requiredContextFactIds.add(edge.originatingFacts[0]);
                }
            }
        }

        // Return the required contextual fact IDs sorted deterministically
        return {
            delta,
            requiredContextFactIds: Array.from(requiredContextFactIds).sort((a, b) => a.localeCompare(b))
        };
    }
}
