/**
 * Consumes the QueryDispatcher token stream for a single ask_repoguide MCP call,
 * filtering the internal side-band __type tokens out of the returned answer text
 * and capturing answerMetadata/gateStatus separately. Extracted as a standalone,
 * side-effect-free module so it's directly unit-testable -- mcpServer.ts itself
 * runs a heavyweight main() (LanceStore, ExecutionPlanner, RetrievalOrchestrator,
 * DatabaseSync, ...) as an unconditional side effect of being imported, so it
 * can't be imported into a test process at all.
 *
 * Filters progressUpdate: decomposed queries (enabled by default) yield this
 * token 3+ times per query (decomposed/sub_start/sub_done/merging stages) --
 * without filtering it, raw progress JSON was spliced into the returned answer
 * text for any MCP question that qualified for decomposition.
 *
 * Captures gateStatus: the same trust-visibility token the chat UI renders as a
 * Verified/Verified with notes/Blocked chip (see queryDispatcher.ts's
 * emitFinalAnswer and deriveGateStatusOutcome) -- previously dropped here
 * entirely, leaving MCP callers with no gate-outcome signal at all.
 */
export async function processAskRepoguideTokens(
    tokens: AsyncIterable<string>
): Promise<{ answer: string; metadata: any; gateStatus: any }> {
    let answer = '';
    let metadata: any = null;
    let gateStatus: any = null;

    for await (const token of tokens) {
        const trimmed = token.trim();
        if (trimmed.startsWith('{"__type":"healthCaveat"')) continue;
        if (trimmed.startsWith('{"__type":"answerMetadata"')) {
            try { metadata = JSON.parse(trimmed); } catch { /* leave metadata unset; token is still dropped below */ }
            continue;
        }
        if (trimmed.startsWith('{"__type":"answerProvenance"')) continue;
        if (trimmed.startsWith('{"__type":"shadowContext"')) continue;
        if (trimmed.startsWith('{"__type":"progressUpdate"')) continue;
        if (trimmed.startsWith('{"__type":"gateStatus"')) {
            try { gateStatus = JSON.parse(trimmed).status; } catch { /* leave gateStatus unset; token is still dropped below */ }
            continue;
        }

        answer += token;
    }

    return { answer, metadata, gateStatus };
}
