
import { RepositoryContext } from '../context/repositoryContext';
import { getProfile } from '../config/performanceConfig';

/**
 * `seed` is pinned alongside `temperature: 0`, not instead of it. Temperature 0 alone
 * does not make Ollama reproducible: with the seed unset it is drawn per request, and
 * a measured repeat of one question against a byte-identical prompt produced four
 * distinct answer texts in six runs (same substance, same gate verdict -- but not the
 * same bytes). Reproducibility is a hard requirement for this project's before/after
 * measurements, so the seed is fixed rather than left to chance. The value is
 * arbitrary; only its constancy matters.
 */
const DETERMINISTIC_SEED = 42;

export const INFERENCE_MODEL_OPTIONS = {
    num_ctx: 16384,
    num_gpu: 99,
    temperature: 0,
    seed: DETERMINISTIC_SEED
};

export const PLANNING_MODEL_OPTIONS = {
    num_ctx: 4096,
    num_gpu: 0,
    temperature: 0,
    seed: DETERMINISTIC_SEED
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
            options?: { num_gpu?: number; num_ctx?: number; temperature?: number; seed?: number };
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

        // stderr, not stdout: see the channel note in evidencePrompt.ts. These three
        // fire on EVERY inference call, so on stdout they were the steadiest source of
        // JSON-RPC stream corruption on the MCP path.
        console.error('Inference model:', model);
        console.error('Message count:', messages.length);
        const approxChars = JSON.stringify(messages).length;
        console.error('Approx prompt chars:', approxChars);
        // ~3.2 chars/token is deliberately conservative for code-heavy text.
        // Ollama does not error on an over-num_ctx prompt -- it silently keeps
        // only the tail, so the system prompt (rules, security framing) is the
        // first thing destroyed. Confirmed empirically via the needle test in
        // contextTruncationProbe.ts. Any prompt tripping this warning is a bug
        // in the caller's budgeting, not a tolerable degradation.
        const estTokens = Math.round(approxChars / 3.2);
        if (estTokens > INFERENCE_MODEL_OPTIONS.num_ctx) {
            console.warn(`[Warn] Prompt ~${estTokens} est tokens exceeds num_ctx=${INFERENCE_MODEL_OPTIONS.num_ctx} -- Ollama will silently drop the prompt HEAD (system rules first).`);
        }

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
