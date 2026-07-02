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
            console.log(`METRIC_TAG|${item.retrieval_signal}|${item.semanticCategory || 'UNKNOWN'}`);
            const contextItem: ContextItem = {
                id: item.id,
                file: item.file,
                startLine: item.startLine,
                endLine: item.endLine,
                symbol: item.symbol,
                content: item.content,
                category: item.semanticCategory || SemanticCategory.UNKNOWN,
                confidenceScore: typeof item.confidence === 'number' ? item.confidence : 0.5
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
