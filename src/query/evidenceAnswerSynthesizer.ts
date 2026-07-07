
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
     * Deliberately does no packet pre-compaction: selection now lives in ONE
     * place -- buildEvidenceMessages()'s question-aware, token-budgeted packer.
     * The old two-layer arrangement (signal-type slices in a local
     * compactPacketForLLM, then a score-only top-30 cut in the prompt builder)
     * was root-caused via contextTruncationProbe.ts as dropping the single
     * decisive evidence item (e.g. fc-06's REDIS_URL constant, fc-08's
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

    /**
     * Runs one non-streaming chat completion over pre-built messages. Used by the
     * decomposed-query merge step, whose prompt is built from already-verified
     * sub-answers rather than an evidence packet -- kept here so every model call
     * still goes through one class (and therefore one backend seam).
     */
    async synthesizeFromMessages(messages: Array<{ role: string; content: string }>, model?: string, signal?: AbortSignal): Promise<string> {
        let out = '';
        for await (const chunk of streamChat(this.context, messages, model, signal)) {
            out += chunk;
        }
        return out;
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
        // No pre-compaction here either (see streamSynthesize) -- the explain-selection
        // prompt builder now runs the same shared token budgeter as the main path.
        const messages = buildEvidenceExplainSelectionMessages(packet, history);
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

}
