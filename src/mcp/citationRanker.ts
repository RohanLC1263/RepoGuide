/**
 * Ranks and caps the citation list mcpServer.ts's ask_repoguide handler
 * returns -- extracted as a standalone, side-effect-free module for the same
 * reason as dependentsResponseBuilder.ts/mcpConfigBuilder.ts (mcpServer.ts
 * can't be imported into a test process).
 *
 * queryDispatcher.ts's emitFinalAnswer (shared by chat and MCP) maps every
 * fact in the evidence packet into `file_references` uncapped and unranked
 * -- live-tested and confirmed: an ordinary question returned dozens of
 * single-line "Fact match: <generic word>" citations in files unrelated to
 * the question. That shared function is deliberately NOT touched here (it
 * also backs chat's own citation rendering) -- this module operates only on
 * mcpServer.ts's own post-processed `citations` array, after inline
 * ___CITE___ markers and file_references have already been merged, so the
 * cap is scoped to the MCP response only.
 *
 * Ranking is a string-containment check, not inference: a citation whose
 * `display` (inline ___CITE___ markers, which are always literally present
 * in the answer text -- they were substituted into it) or `symbol` appears
 * in the final answer text ranks first, in original order; everything else
 * follows, in original order. This naturally prioritizes citations the
 * model actually referenced over generic fact-matches from the same file
 * area, without inventing a new relevance score.
 */
export interface McpCitation {
    file: string;
    line_start?: number;
    line_end?: number;
    symbol?: string;
    display?: string;
    reason?: string;
    source?: string;
}

export const MCP_CITATION_CAP = 25;

export function rankAndCapCitations(
    citations: McpCitation[],
    answerText: string,
    cap: number = MCP_CITATION_CAP
): McpCitation[] {
    const mentioned: McpCitation[] = [];
    const unmentioned: McpCitation[] = [];

    for (const citation of citations) {
        const needle = citation.symbol || citation.display;
        if (needle && answerText.includes(needle)) {
            mentioned.push(citation);
        } else {
            unmentioned.push(citation);
        }
    }

    return [...mentioned, ...unmentioned].slice(0, cap);
}
