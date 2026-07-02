
import { RepositoryContext } from '../context/repositoryContext';
import { getProfile } from '../config/performanceConfig';

export const INFERENCE_MODEL_OPTIONS = {
    num_ctx: 16384,
    num_gpu: 99,
    temperature: 0
};

export const PLANNING_MODEL_OPTIONS = {
    num_ctx: 4096,
    num_gpu: 0,
    temperature: 0
};

const STREAM_CHAT_TIMEOUT_MS = 240000;

export async function* streamChat(
    context: RepositoryContext,
    messages: Array<{role: string, content: string}>,
    model?: string,
    signal?: AbortSignal,
    keepAlive?: string
): AsyncGenerator<string> {
    if (!model) {
        model = getProfile().inferenceModel;
    }
    model = model.trim();

    const ollamaUrl = context.getConfig<string>('ollamaUrl', 'http://localhost:11434');

    let timeoutId: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    let innerController: AbortController | undefined;

    try {
        const body: {
            model: string;
            messages: Array<{role: string, content: string}>;
            stream: boolean;
            keep_alive?: string;
            options?: { num_gpu?: number; num_ctx?: number };
        } = { model, messages, stream: true };

        if (keepAlive) {
            body.keep_alive = keepAlive;
        }

        body.options = INFERENCE_MODEL_OPTIONS;

        const requestUrl = `${ollamaUrl}/api/chat`;

        innerController = new AbortController();
        timeoutId = setTimeout(() => {
            console.warn(`[Warn] streamChat timeout after ${STREAM_CHAT_TIMEOUT_MS / 1000}s`);
            innerController?.abort();
        }, STREAM_CHAT_TIMEOUT_MS);
        abortHandler = () => innerController?.abort();
        signal?.addEventListener('abort', abortHandler, { once: true });
        if (signal?.aborted) innerController.abort();

        console.log('Inference model:', model);
        console.log('Message count:', messages.length);
        console.log('Approx prompt chars:', JSON.stringify(messages).length);

        const response = await fetch(requestUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: innerController.signal as RequestInit["signal"]
        });

        if (!response.ok) {
            throw new Error(`Ollama chat failed: ${response.statusText}`);
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
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.message?.content) {
                            yield parsed.message.content;
                        }
                        if (parsed.done) {
                            return;
                        }
                        if (parsed.error) {
                            throw new Error(`Ollama stream error: ${parsed.error}`);
                        }
                    } catch (parseError) {
                        // Re-throw Ollama-level errors
                        if (parseError instanceof Error && parseError.message.startsWith('Ollama stream error:')) {
                            throw parseError;
                        }
                        // Skip unparseable lines (partial chunks, status messages)
                        console.warn(`RepoGuide: Skipped unparseable stream chunk: ${line.substring(0, 100)}`);
                    }
                }
            }
        }
    } catch (e: any) {
        console.error('===== OLLAMA STREAM FAILURE =====');
        console.error('Raw error:', e);

        if (e instanceof Error) {
            console.error('Message:', e.message);
            console.error('Name:', e.name);
            console.error('Stack:', e.stack);
            console.error('Cause:', (e as any).cause);
        }

        if (e.name === 'AbortError') {
            throw e;
        }
        throw e;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (abortHandler && signal) signal.removeEventListener('abort', abortHandler);
    }
}
