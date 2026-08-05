/**
 * The answer-delivery stream's wire format, in one dependency-free place.
 *
 * `QueryDispatcher`'s answer generators (`query`, `explainSelection`,
 * `runDocumentationReport`) yield two kinds of string: plain answer text, and
 * typed JSON side-band control tokens (`{"__type":"gateStatus",...}`,
 * `answerMetadata`, `shadowContext`, `progressUpdate`, `healthCaveat`, ...).
 * Consumers that render or score the prose must separate the two.
 *
 * This module exists because that separation, and the citation-marker strip that
 * goes with it, were previously re-derived inline at every consumer
 * (`evaluation/queryPipelineHarness.ts`, `mcp/askRepoguideTokenProcessor.ts`,
 * `queryDispatcher.ts`'s own export block) with slightly different logic each
 * time. It is deliberately free of `vscode` and store imports so it can be unit
 * tested directly under `node:test` -- `queryDispatcher.ts` itself cannot be
 * required in a plain Node process (it transitively loads the LanceDB native
 * binding), which is exactly why these two pure pieces live here instead.
 */

/**
 * Resolves the inline citation markers the dispatcher injects
 * (`___CITE___file|start|end|display___CITE_END___`) down to their plain display
 * text. Used by the two consumers that render text rather than parse markers into
 * links: the query-evidence export, and the explain-selection panel
 * (`src/ui/explainPanel.ts`, which renders via `textContent`).
 */
export function stripCitationMarkersToDisplayText(text: string): string {
    return text.replace(
        /___CITE___(.*?)\|(.*?)\|(.*?)\|(.*?)___CITE_END___/g,
        (_match, _file, _startLine, _endLine, display) => display
    );
}

export type AnswerStreamToken =
    | { kind: 'control'; type: string; payload: Record<string, unknown> }
    | { kind: 'text'; value: string };

/**
 * Splits one yielded token into either a control message or answer text.
 *
 * Deliberately conservative: only a token whose TRIMMED form parses as JSON AND
 * carries a string `__type` counts as control. Answer prose that merely contains
 * a brace, and a fenced JSON code block inside an explanation (which arrives as
 * part of a larger token and therefore does not parse standalone), are both
 * treated as text. Erring toward "text" degrades to a visible stray token at
 * worst; erring toward "control" would silently delete answer content.
 */
export function classifyAnswerStreamToken(token: string): AnswerStreamToken {
    const trimmed = token.trim();
    if (trimmed.startsWith('{') && trimmed.includes('"__type"')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && typeof parsed.__type === 'string') {
                return { kind: 'control', type: parsed.__type, payload: parsed };
            }
        } catch {
            // Not a complete control token — fall through and render as text.
        }
    }
    return { kind: 'text', value: token };
}
