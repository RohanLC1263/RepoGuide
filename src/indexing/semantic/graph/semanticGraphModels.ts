import { CanonicalFact } from '../canonicalFact';

/**
 * Represents a discrete architectural entity in the graph.
 * Derived exclusively from an ENTITY CanonicalFact.
 */
export interface SemanticGraphNode {
    readonly nodeId: string;            // The CanonicalFact factId
    readonly name: string;
    readonly entityKind: string;
    readonly originatingFacts: string[]; // List of factIds that define this node
    readonly payload: Record<string, any>;
}

/**
 * Represents a structural dependency or relationship in the graph.
 * Derived exclusively from a RELATIONSHIP CanonicalFact.
 */
export interface SemanticGraphEdge {
    readonly edgeId: string;            // The CanonicalFact factId
    readonly category: string;
    readonly relationshipKind: string;
    readonly sourceNodeId: string;      // Must reference an existing SemanticGraphNode
    readonly targetNodeId: string;      // Must reference an existing SemanticGraphNode
    readonly originatingFacts: string[]; // List of factIds that define this edge
    readonly payload: Record<string, any>;
}
