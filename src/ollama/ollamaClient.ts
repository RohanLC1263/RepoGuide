import { RepositoryContext } from '../context/repositoryContext';
import { getProfile } from '../config/performanceConfig';
import { resolveOllamaUrl } from '../health/ollamaUrlSafety';

/**
 * Streams text generation from Ollama's /api/generate endpoint.
 * Used by the Right-click Explain feature.
 * Includes a timeout to prevent indefinite hangs.
 */
export async function* streamGenerate(context: RepositoryContext, prompt: string, model?: string): AsyncGenerator<string> {
    const profile = getProfile();
    if (!model) {
        model = profile.inferenceModel;
    }

    const ollamaUrl = resolveOllamaUrl(context);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), profile.timeoutMs);

    try {
        const response = await fetch(`${ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt, stream: true }),
            signal: controller.signal as RequestInit["signal"]
        });

        if (!response.ok) {
            throw new Error(`Ollama fetch failed: ${response.statusText}`);
        }

        if (!response.body) {
            throw new Error('No response body from Ollama');
        }

        const stream = response.body;
        const decoder = new TextDecoder();
        let buffer = '';

        for await (const chunk of stream as any) {
            buffer += decoder.decode(chunk, { stream: true });
            
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 1);
                
                if (line) {
                    const parsed = JSON.parse(line);
                    if (parsed.response) {
                        yield parsed.response;
                    }
                    if (parsed.done) {
                        clearTimeout(timeoutId);
                        return;
                    }
                }
            }
        }
        clearTimeout(timeoutId);
    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new Error(`Explain request timed out (${profile.timeoutMs}ms). Is Ollama responsive?`);
        }
        if (err instanceof Error) {
            throw new Error(`Failed to generate: ${err.message}`);
        }
        throw new Error('Failed to generate from Ollama');
    }
}
