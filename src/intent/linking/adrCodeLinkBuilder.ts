import { createHash } from 'crypto';
import { ADRCodeLinkStore } from './adrCodeLinkStore';
import { ADRCodeLink, ADRCodeEvidence } from './adrCodeLinkTypes';
import { ProgramGraphStore } from '../../store/programGraphStore';
import { ADRQueryEngine } from '../adr/adrQueryEngine';
import { IntentQueryEngine } from '../extraction/intentQueryEngine';
import { ProgramGraphNode } from '../../graph/programGraphTypes';

export class ADRCodeLinkBuilder {
    constructor(
        private linkStore: ADRCodeLinkStore,
        private graphStore: ProgramGraphStore,
        private adrQueryEngine: ADRQueryEngine,
        private intentQueryEngine: IntentQueryEngine
    ) {}

    private generateLinkId(adrId: string, nodeId: string): string {
        return createHash('sha256').update(`${adrId}:${nodeId}`).digest('hex');
    }

    public async build(): Promise<void> {
        // 1. Build Inverted Index from ProgramGraphStore
        // Map: lowercase(token) -> Set<nodeId>
        const invertedIndex = new Map<string, Set<string>>();

        // Pre-fetch intents mapped to ADRs
        // Map: adrId -> Set<canonicalTopic>
        const adrIntentTopics = new Map<string, Set<string>>();
        const allIntents = this.intentQueryEngine.listIntents();
        
        for (const intent of allIntents) {
            const evs = this.intentQueryEngine.getEvidence(intent.id);
            for (const ev of evs) {
                if (ev.sourceType === 'ADR') {
                    if (!adrIntentTopics.has(ev.sourceId)) adrIntentTopics.set(ev.sourceId, new Set());
                    adrIntentTopics.get(ev.sourceId)!.add(intent.canonicalTopic.toLowerCase());
                }
            }
        }

        const nodes = Object.values((this.graphStore as any).graph?.nodes || {}) as ProgramGraphNode[];
        
        for (const node of nodes) {
            const nodeId = node.id;
            
            // Symbol Tokens
            if (node.symbol) {
                const symToken = node.symbol.toLowerCase();
                if (!invertedIndex.has(symToken)) invertedIndex.set(symToken, new Set());
                invertedIndex.get(symToken)!.add(nodeId);
                
                // For INTENT_MATCH, we just use the symbol itself or parts of it
                // We'll rely on checking if `adrIntentTopics` intersects with `symToken` 
                // in Phase 2, but we can also pre-split camel case here if we wanted.
            }

            // Path Tokens
            if (node.filePath) {
                // Split path by / or \ and map basename and directory parts
                const parts = node.filePath.split(/[/\\]/);
                for (const p of parts) {
                    if (!p) continue;
                    const lowerP = p.toLowerCase();
                    if (!invertedIndex.has(lowerP)) invertedIndex.set(lowerP, new Set());
                    invertedIndex.get(lowerP)!.add(nodeId);
                }
            }
        }

        // 2. Scan ADRs and lookup using inverted index
        const adrs = await this.adrQueryEngine.listADRs();
        const batchLinks = new Map<string, ADRCodeLink>();
        const batchEvidence: ADRCodeEvidence[] = [];

        for (const adr of adrs) {
            const adrText = `${adr.title}\n${adr.context}\n${adr.decision}\n${adr.consequences}`.toLowerCase();
            
            // To do O(tokens) lookup, we extract words from ADR text
            // Also add split by non-word chars
            const adrTokens = Array.from(new Set(adrText.split(/\W+/).filter(Boolean)));
            const activeTopicsForADR = adrIntentTopics.get(adr.id) || new Set<string>();

            // Temporary accumulator for Node Scores for this specific ADR
            // Map: nodeId -> { score, evidence[] }
            const nodeAccumulator = new Map<string, { score: number, ev: Array<{type: string, text: string, score: number}> }>();

            const addEvidence = (nodeId: string, evType: string, evText: string, score: number) => {
                if (!nodeAccumulator.has(nodeId)) {
                    nodeAccumulator.set(nodeId, { score: 0, ev: [] });
                }
                const acc = nodeAccumulator.get(nodeId)!;
                
                // Prevent duplicate identical evidence types for same node to avoid double counting
                if (!acc.ev.find(e => e.type === evType && e.text === evText)) {
                    acc.score += score;
                    acc.ev.push({ type: evType, text: evText, score });
                }
            };

            // Intent Match (Score: 5)
            // If an ADR implies Intent "Authentication", does the Node symbol contain "Authentication"?
            // We can iterate the node symbols if we want, but doing a full scan is what we tried to avoid.
            // Since activeTopicsForADR is small (1-5 topics), we can split the topic into words and lookup index.
            for (const topic of activeTopicsForADR) {
                const topicWords = topic.toLowerCase().split(/\s+/);
                for (const word of topicWords) {
                    // For intent matching, we probably need partial matches. 
                    // Let's just do a naive check over all nodes for INTENT_MATCH because activeTopicsForADR is so small.
                    for (const node of nodes) {
                        if (node.symbol && node.symbol.toLowerCase().includes(word)) {
                            addEvidence(node.id, "INTENT_MATCH", topic, 5);
                        }
                    }
                }
            }

            // Token Lookup for SYMBOL (Score: 10) and PATH (Score: 3)
            for (const token of adrTokens) {
                if (invertedIndex.has(token)) {
                    const matchedNodes = invertedIndex.get(token)!;
                    
                    for (const nodeId of matchedNodes) {
                        const node = nodes.find(n => n.id === nodeId)!;
                        
                        // Check if it's a SYMBOL match
                        if (node.symbol && node.symbol.toLowerCase() === token) {
                            addEvidence(nodeId, "SYMBOL_MATCH", node.symbol, 10);
                        }
                        
                        // Check if it's a PATH match
                        if (node.filePath && node.filePath.toLowerCase().includes(token)) {
                            // Only add path match if it's not already covered by symbol match exactly
                            // Actually, they can stack as per reqs
                            addEvidence(nodeId, "PATH_MATCH", token, 3);
                        }
                    }
                }
            }

            // 3. Filter Threshold and Create Link Objects
            for (const [nodeId, acc] of nodeAccumulator.entries()) {
                if (acc.score >= 5) {
                    const linkId = this.generateLinkId(adr.id, nodeId);
                    const confidence = Math.min(1.0, acc.score / 20.0);
                    
                    batchLinks.set(linkId, {
                        id: linkId,
                        adrId: adr.id,
                        nodeId,
                        relationshipType: "GOVERNS",
                        confidence,
                        evidenceCount: acc.ev.length,
                        score: acc.score
                    });

                    for (const e of acc.ev) {
                        batchEvidence.push({
                            linkId,
                            adrId: adr.id,
                            nodeId,
                            evidenceType: e.type as any,
                            evidence: e.text,
                            scoreContribution: e.score
                        });
                    }
                }
            }
        }

        // 4. Save to DB using idempotent bulk insert
        this.linkStore.saveBatch(batchLinks, batchEvidence);
    }
}
