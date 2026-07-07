
import { EvidencePacket } from './evidencePacket';
import { buildEvidenceMessages } from '../prompts/evidencePrompt';
import { buildEvidenceExplainSelectionMessages } from '../prompts/evidenceExplainSelectionPrompt';
import { buildDocumentationMessages } from '../prompts/docPrompt';
import { streamChat } from '../ollama/inferencer';
import { MemoryContext } from '../memory/memoryTypes';
import { RepositoryContext } from '../context/repositoryContext';
import { Message } from './conversationHistory';

export class EvidenceAnswerSynthesizer {
    constructor(private context: RepositoryContext) {}

    /**
     * Synthesizes an answer non-streamingly.
     */
    async synthesize(packet: EvidencePacket, model?: string, history: Message[] = []): Promise<string> {
        let fullAnswer = '';
        const generator = this.streamSynthesize(packet, model, undefined, history);
        for await (const chunk of generator) {
            fullAnswer += chunk;
        }
        return fullAnswer;
    }

    /**
     * Streams the synthesized answer.
     *
     * Deliberately does NOT run compactPacketForLLM: the main answer path's
     * selection now lives in ONE place -- buildEvidenceMessages()'s
     * question-aware, token-budgeted packer. The old two-layer arrangement
     * (signal-type slices here, then a score-only top-30 cut in the prompt
     * builder) was root-caused via contextTruncationProbe.ts as dropping the
     * single decisive evidence item (e.g. fc-06's REDIS_URL constant, fc-08's
     * "Delegates to MissionCoordinator" method) before the model ever saw it,
     * even with most of the context window empty.
     */
    async *streamSynthesize(packet: EvidencePacket, model?: string, signal?: AbortSignal, history: Message[] = []): AsyncGenerator<string> {
        const messages = buildEvidenceMessages(packet, history);

        // We do not inject any legacy retrieval logic here.
        // We only use the explicitly provided evidence packet.

        const stream = streamChat(this.context, messages, model, signal);

        for await (const chunk of stream) {
            yield chunk;
        }
    }

    /** Synthesizes an explain_selection answer non-streamingly. */
    async synthesizeExplainSelection(packet: EvidencePacket, model?: string, history: Message[] = []): Promise<string> {
        let fullAnswer = '';
        for await (const chunk of this.streamSynthesizeExplainSelection(packet, model, undefined, history)) {
            fullAnswer += chunk;
        }
        return fullAnswer;
    }

    async *streamSynthesizeExplainSelection(packet: EvidencePacket, model?: string, signal?: AbortSignal, history: Message[] = []): AsyncGenerator<string> {
        const compactedPacket = this.compactPacketForLLM(packet);
        compactedPacket.selection = packet.selection;
        const messages = buildEvidenceExplainSelectionMessages(compactedPacket, history);
        for await (const chunk of streamChat(this.context, messages, model, signal)) {
            yield chunk;
        }
    }

    /** Synthesizes a documentation report non-streamingly. */
    async synthesizeDocumentation(packet: EvidencePacket, model?: string): Promise<string> {
        let fullAnswer = '';
        for await (const chunk of this.streamSynthesizeDocumentation(packet, model, undefined)) {
            fullAnswer += chunk;
        }
        return fullAnswer;
    }

    async *streamSynthesizeDocumentation(packet: EvidencePacket, model?: string, signal?: AbortSignal): AsyncGenerator<string> {
        const messages = buildDocumentationMessages(packet);
        for await (const chunk of streamChat(this.context, messages, model, signal)) {
            yield chunk;
        }
    }

    /**
     * Still used by the explain-selection path only (its prompt builder has no
     * budget packer of its own yet). The main answer path intentionally bypasses
     * this -- see streamSynthesize().
     */
    private compactPacketForLLM(packet: EvidencePacket): EvidencePacket {
        const compactedItems: any[] = [];
        const symbolMatches: any[] = [];
        const bm25Matches: any[] = [];
        const graphMatches: any[] = [];
        const vectorMatches: any[] = [];
        const memoryMatches: any[] = [];
        const gaps: any[] = [];
        const annotations: any[] = [];
        
        for (const item of packet.items) {
            let content = item.content || '';
            const lines = content.split('\n');
            if (lines.length > 60) {
                content = lines.slice(0, 60).join('\n') + '\n[content truncated at 60 lines]';
            }
            const truncatedItem = { ...item, content };
    
            if (item.type === 'inferred_gap' || (item.role as string) === 'inferred_gap' || item.retrieval_signal === 'inferred_gap') {
                gaps.push(truncatedItem);
            } else if ((item.role as string) === 'annotation' || (item.role as string) === 'community_summary' || item.type === 'annotation' || item.type === 'community_summary') {
                annotations.push(truncatedItem);
            } else if (item.retrieval_signal === 'symbol_match' || item.retrieval_signal === 'fact_store_direct') {
                symbolMatches.push(truncatedItem);
            } else if (item.retrieval_signal === 'bm25') {
                bm25Matches.push(truncatedItem);
            } else if (item.retrieval_signal && item.retrieval_signal.startsWith('graph_')) {
                graphMatches.push(truncatedItem);
            } else if (item.retrieval_signal === 'memory_bridge') {
                memoryMatches.push(truncatedItem);
            } else if (item.retrieval_signal === 'vector') {
                vectorMatches.push(truncatedItem);
            } else {
                symbolMatches.push(truncatedItem);
            }
        }
    
        compactedItems.push(...gaps);
        compactedItems.push(...annotations.slice(0, 2));
    
        const logicalUnits: any[] = [];
        logicalUnits.push(...symbolMatches);
        logicalUnits.push(...bm25Matches.slice(0, 5));
        logicalUnits.push(...graphMatches.slice(0, 3));
        logicalUnits.push(...vectorMatches.slice(0, 2));
    
        compactedItems.push(...logicalUnits.slice(0, 10));
        compactedItems.push(...memoryMatches.slice(0, 3));
    
        return {
            ...packet,
            items: compactedItems,
            facts: packet.facts
        };
    }
}
