import { RepositoryContext } from '../context/repositoryContext';
import { getProfile } from '../config/performanceConfig';
import { resolveOllamaUrl } from '../health/ollamaUrlSafety';

/**
 * Generates an embedding vector for the given text using Ollama.
 * Includes a timeout to prevent indefinite hangs.
 */
export async function embedText(context: RepositoryContext, text: string, model?: string): Promise<number[]> {
    const profile = getProfile();
    if (!model) {
        model = profile.embeddingModel;
    }
    
    const ollamaUrl = resolveOllamaUrl(context);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), profile.timeoutMs);

    const MAX_EMBED_CHARS = 1500;
    const truncatedText = text.length > MAX_EMBED_CHARS 
        ? text.substring(0, MAX_EMBED_CHARS).replace(/[\uD800-\uDBFF]$/, '') 
        : text;

    try {
        const response = await fetch(`${ollamaUrl}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: truncatedText }),
            signal: controller.signal as RequestInit["signal"]
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Failed to generate embeddings: ${response.statusText}`);
        }

        const data = (await response.json()) as { embedding: number[] };
        if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
            throw new Error('Ollama returned an empty embedding vector.');
        }
        return data.embedding;
    } catch (e: any) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') {
            throw new Error(`Embedding request timed out (${profile.timeoutMs}ms). Is Ollama responsive?`);
        }
        throw e;
    }
}
