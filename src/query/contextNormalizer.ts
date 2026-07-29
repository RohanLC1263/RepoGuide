import { EvidencePacket, EvidenceItem, SemanticCategory } from './evidencePacket';

export interface ContextItem {
    id: string;
    file: string;
    startLine: number;
    endLine: number;
    symbol?: string;
    content: string;
    category: SemanticCategory;
    confidenceScore: number;
    /**
     * The retrieval signal that produced this item, carried through so consumers can
     * tell WHICH KIND of dependency relationship it represents. The DEPENDENCY
     * category alone is far too coarse for that: it holds inbound dependents
     * (`graph_caller_dependency`), outbound dependencies (`graph_callee_dependency`,
     * `graph_callee_expansion`), and the subject's own anchor (`graph_symbol_node`)
     * all mixed together. MentorEngine's blast-radius count needs the inbound subset
     * only -- see INBOUND_DEPENDENT_SIGNALS there.
     */
    retrievalSignal?: string;
}

export interface ContextBundle {
    query: string;
    targetCapability: string;
    architecturalEvidence: ContextItem[];
    dependencyEvidence: ContextItem[];
    communityEvidence: ContextItem[];
    behavioralEvidence: ContextItem[];
    historicalEvidence: ContextItem[];
    memoryEvidence: ContextItem[];
    generalContext: ContextItem[];
}

export class ContextNormalizer {
    public normalize(packet: EvidencePacket, targetCapability: string): ContextBundle {
        const bundle: ContextBundle = {
            query: packet.query,
            targetCapability,
            architecturalEvidence: [],
            dependencyEvidence: [],
            communityEvidence: [],
            behavioralEvidence: [],
            historicalEvidence: [],
            memoryEvidence: [],
            generalContext: []
        };

        const processItem = (item: EvidenceItem) => {
            // stderr, not stdout: see the channel note in evidencePrompt.ts (MCP stdout is JSON-RPC).
            console.error(`METRIC_TAG|${item.retrieval_signal}|${item.semanticCategory || 'UNKNOWN'}`);
            const contextItem: ContextItem = {
                id: item.id,
                file: item.file,
                startLine: item.startLine,
                endLine: item.endLine,
                symbol: item.symbol,
                content: item.content,
                category: item.semanticCategory || SemanticCategory.UNKNOWN,
                confidenceScore: typeof item.confidence === 'number' ? item.confidence : 0.5,
                retrievalSignal: item.retrieval_signal
            };

            switch (contextItem.category) {
                case SemanticCategory.ARCHITECTURE:
                    bundle.architecturalEvidence.push(contextItem);
                    break;
                case SemanticCategory.DEPENDENCY:
                    bundle.dependencyEvidence.push(contextItem);
                    break;
                case SemanticCategory.COMMUNITY:
                    bundle.communityEvidence.push(contextItem);
                    break;
                case SemanticCategory.BEHAVIOR:
                    bundle.behavioralEvidence.push(contextItem);
                    break;
                case SemanticCategory.HISTORY:
                    bundle.historicalEvidence.push(contextItem);
                    break;
                case SemanticCategory.MEMORY:
                    bundle.memoryEvidence.push(contextItem);
                    break;
                case SemanticCategory.GENERAL:
                default:
                    bundle.generalContext.push(contextItem);
                    break;
            }
        };

        packet.items.forEach(processItem);
        packet.facts.forEach(processItem);

        return bundle;
    }
}
