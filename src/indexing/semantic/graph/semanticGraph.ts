import { SemanticGraphNode, SemanticGraphEdge } from './semanticGraphModels';
import { GraphDiagnostics } from './graphDiagnostics';

export class SemanticGraph {
    private readonly nodes = new Map<string, SemanticGraphNode>();
    private readonly edges = new Map<string, SemanticGraphEdge>();
    
    private readonly incomingEdges = new Map<string, SemanticGraphEdge[]>();
    private readonly outgoingEdges = new Map<string, SemanticGraphEdge[]>();

    public readonly diagnostics: GraphDiagnostics;

    constructor(
        nodes: SemanticGraphNode[],
        edges: SemanticGraphEdge[],
        diagnostics: GraphDiagnostics
    ) {
        this.diagnostics = diagnostics;

        // Populate nodes
        for (const node of nodes) {
            this.nodes.set(node.nodeId, node);
        }

        // Populate edges and indices
        for (const edge of edges) {
            this.edges.set(edge.edgeId, edge);

            // Incoming
            let incoming = this.incomingEdges.get(edge.targetNodeId);
            if (!incoming) {
                incoming = [];
                this.incomingEdges.set(edge.targetNodeId, incoming);
            }
            incoming.push(edge);

            // Outgoing
            let outgoing = this.outgoingEdges.get(edge.sourceNodeId);
            if (!outgoing) {
                outgoing = [];
                this.outgoingEdges.set(edge.sourceNodeId, outgoing);
            }
            outgoing.push(edge);
        }
        
        // Ensure deterministic iteration order by sorting indices
        for (const edgesList of this.incomingEdges.values()) {
            edgesList.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
        }
        for (const edgesList of this.outgoingEdges.values()) {
            edgesList.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
        }
    }

    public getNode(nodeId: string): SemanticGraphNode | undefined {
        return this.nodes.get(nodeId);
    }

    public getEdge(edgeId: string): SemanticGraphEdge | undefined {
        return this.edges.get(edgeId);
    }

    public getIncomingEdges(nodeId: string): SemanticGraphEdge[] {
        return this.incomingEdges.get(nodeId) || [];
    }

    public getOutgoingEdges(nodeId: string): SemanticGraphEdge[] {
        return this.outgoingEdges.get(nodeId) || [];
    }

    public getAllNodes(): SemanticGraphNode[] {
        return Array.from(this.nodes.values()).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    }

    public getAllEdges(): SemanticGraphEdge[] {
        return Array.from(this.edges.values()).sort((a, b) => a.edgeId.localeCompare(b.edgeId));
    }
}
