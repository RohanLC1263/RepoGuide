/**
 * Drops Ollama's resident model instance so the next request starts from a canonical
 * state.
 *
 * WHY THIS EXISTS. Ollama is not a random component -- it is a *stateful* one. Measured
 * on qwen2.5-coder:7b at temperature 0 with a pinned seed, replaying a byte-identical
 * 46KB request 10 times back-to-back gave 10 identical answers; the output only ever
 * changed when the PRECEDING request changed. Four different preceding sequences
 * produced four different-but-individually-stable answers to the same question, and the
 * difference was not cosmetic -- one of them flipped the gate verdict from pass to
 * block. So a question's answer depends on what was asked before it, across client
 * processes, which is precisely what makes two runs of the same suite incomparable.
 *
 * WHAT DOES NOT WORK. A cheap "cache-normalising" request was tried first: a tiny
 * throwaway prompt before each synthesis. It appeared to work, then turned out to be a
 * full reload in disguise -- it specified a different `num_ctx`, and `num_ctx` is a
 * load-time parameter, so Ollama re-instantiated the model. Re-measured with a matching
 * `num_ctx` (so no reload occurs) it cost nothing and stabilised nothing: 2 of 3
 * questions still returned multiple distinct answers. There is no partial KV-cache reset
 * exposed by the API. Dropping the instance is the only thing that actually normalises
 * the state.
 *
 * THE PRICE. A microbenchmark over three captured requests asked in rotation suggests
 * 5.8s -> 14.6s median, roughly 2.5x. That number overstates it: the rotation replays the
 * same three prompts, so the no-reset arm gets prompt-prefix reuse that real usage never
 * gets, because consecutive real questions share no prefix. Measured end-to-end through
 * the actual pipeline the cost is 21.1s -> 25.0s median, **+18%**.
 *
 * ON BY DEFAULT (decided 2026-07-29). +18% is worth paying: this channel can flip a gate
 * verdict, not merely reword an answer, and an off-by-default setting that the evaluation
 * harness pins on would mean the harness measures a pipeline no user runs -- reopening
 * precisely the harness-vs-live divergence the session-variance investigation set out to
 * close. See `determinism.resetModelBeforeSynthesis`; set it false for lowest latency,
 * accepting that a repeated question may answer differently.
 */

/** Bounded poll: Ollama's unload response returns before the runner has actually exited. */
const MAX_UNLOAD_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 250;

export interface ModelResetResult {
    reset: boolean;
    waitedMs: number;
    reason?: string;
}

/**
 * Requests an unload and waits until the model is genuinely gone from `/api/ps`.
 *
 * Never throws: a determinism aid must not be able to break answering. A failed or
 * timed-out reset degrades to "answer anyway, non-normalised" and says so in the result,
 * because a slightly-less-reproducible answer beats no answer.
 */
export async function resetOllamaModelState(
    ollamaUrl: string,
    model: string,
    fetchImpl: typeof fetch = fetch
): Promise<ModelResetResult> {
    const startedAt = Date.now();
    try {
        await fetchImpl(`${ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, keep_alive: 0 })
        });
    } catch (e) {
        return { reset: false, waitedMs: Date.now() - startedAt, reason: `unload request failed: ${e}` };
    }

    while (Date.now() - startedAt < MAX_UNLOAD_WAIT_MS) {
        try {
            const res = await fetchImpl(`${ollamaUrl}/api/ps`);
            const body = await res.json() as { models?: Array<{ model?: string; name?: string }> };
            const stillLoaded = (body.models ?? []).some(m => m.model === model || m.name === model);
            if (!stillLoaded) {
                return { reset: true, waitedMs: Date.now() - startedAt };
            }
        } catch (e) {
            return { reset: false, waitedMs: Date.now() - startedAt, reason: `ps poll failed: ${e}` };
        }
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return { reset: false, waitedMs: Date.now() - startedAt, reason: 'timed out waiting for unload' };
}
