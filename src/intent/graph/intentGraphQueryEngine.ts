import { IntentGraphStore } from './intentGraphStore';
import { IntentGraphMetrics, IntentNeighborhood } from './intentGraphTypes';
import { IntentQueryEngine } from '../extraction/intentQueryEngine';
import { IntentEntity } from '../extraction/intentTypes';

export class IntentGraphQueryEngine {
    constructor(
        private graphStore: IntentGraphStore,
        private intentQueryEngine: IntentQueryEngine
    ) {}

    public getNeighbors(intentId: string): IntentNeighborhood {
        const centerIntent = this.intentQueryEngine.getIntent(intentId);
        if (!centerIntent) {
            throw new Error(`Intent ${intentId} not found`);
        }

        const edges = this.graphStore.getEdgesForIntent(intentId);
        
        const neighborIds = new Set<string>();
        for (const edge of edges) {
            if (edge.sourceIntentId !== intentId) neighborIds.add(edge.sourceIntentId);
            if (edge.targetIntentId !== intentId) neighborIds.add(edge.targetIntentId);
        }

        const intents: IntentEntity[] = [];
        for (const nid of neighborIds) {
            const intent = this.intentQueryEngine.getIntent(nid);
            if (intent) intents.push(intent);
        }

        return {
            centerIntentId: intentId,
            intents,
            edges
        };
    }

    public getCentralIntents(limit: number = 10): string[] {
        return this.graphStore.getCentralIntents(limit);
    }

    public getMetrics(): IntentGraphMetrics {
        const allEdges = this.graphStore.getAllEdges();
        const allIntents = this.intentQueryEngine.listIntents();

        const nodeCount = allIntents.length;
        const edgeCount = allEdges.length;
        
        // Average degree in an undirected graph = 2 * E / V
        const averageDegree = nodeCount > 0 ? (2 * edgeCount) / nodeCount : 0;

        const mostCentralIntents = this.getCentralIntents(5);

        return {
            nodeCount,
            edgeCount,
            mostCentralIntents,
            averageDegree
        };
    }
}
