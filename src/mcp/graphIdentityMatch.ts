import { EvidenceItem } from '../query/evidencePacket';

/**
 * Identity check for the get_dependents / get_dependencies MCP tools.
 *
 * ProgramGraphProvider token-expands the query (programGraphProvider.ts's
 * queryTermsForGraph splits identifiers into sub-tokens), which is correct for
 * fuzzy evidence retrieval but wrong for these two tools, which promise
 * "dependents/dependencies of THIS exact symbol or file". A nonexistent name
 * that merely shares a sub-token with a real node -- e.g. any made-up
 * "...Agent" name sharing the "agent" token with a node called `agent` --
 * would otherwise be matched at high confidence and the response would
 * silently describe the wrong symbol, with no "not found" signal. This module
 * gates the matched symbol on real correspondence to what was requested.
 *
 * Empirically, when a legitimate exact match exists (e.g. `BaseAgent`) the
 * provider's result is already clean -- the sub-token nodes do not pollute the
 * dependents list -- so this check only needs to validate the matched *symbol
 * node*, not filter the relationship list.
 */

export interface GraphMatchSuggestion {
    symbol?: string;
    file: string;
}

function normalize(value: string): string {
    return value.trim().toLowerCase();
}

function basename(pathLike: string): string {
    const parts = pathLike.split(/[\\/]/);
    return parts[parts.length - 1] || pathLike;
}

/**
 * True when `item` genuinely corresponds to the requested identifier -- an
 * exact (case-insensitive) symbol match, or a real file/path match -- rather
 * than merely sharing a sub-token with it.
 */
export function identifierCorresponds(requested: string, item: EvidenceItem): boolean {
    const req = normalize(requested);
    if (!req) {
        return false;
    }
    // Exact symbol match (case-insensitive). This is the common case for the
    // demo's symbol queries (BaseAgent, StoryGenerationAgent, execute_mission).
    if (item.symbol && normalize(item.symbol) === req) {
        return true;
    }
    // File / path correspondence, since the tool accepts "a symbol or a file".
    if (item.file) {
        const file = normalize(item.file);
        const reqBase = normalize(basename(requested));
        const fileBase = normalize(basename(item.file));
        if (file === req) {
            return true; // exact path
        }
        if (file.endsWith('/' + req)) {
            return true; // path suffix, e.g. requested "app/main.py"
        }
        if (reqBase.includes('.') && fileBase === reqBase) {
            return true; // same filename incl. extension, e.g. requested "main.py"
        }
        // A bare (extensionless) requested name matching the file's stem, e.g.
        // requested "main" -> main.py. Stem equality is exact, not sub-token, so
        // it does not reintroduce the token-overlap mis-match this guards against.
        if (!reqBase.includes('.') && fileBase.replace(/\.[^.]+$/, '') === reqBase) {
            return true;
        }
    }
    return false;
}

/**
 * The closest token-matched candidates the provider surfaced, offered as
 * "did you mean" suggestions when nothing corresponds. Deliberately drawn only
 * from the symbol-node items actually returned -- the builder has no view of
 * the whole graph -- so these are honestly "what token-matched", not a ranked
 * global search.
 */
export function buildGraphSuggestions(items: EvidenceItem[], limit = 3): GraphMatchSuggestion[] {
    const seen = new Set<string>();
    const suggestions: GraphMatchSuggestion[] = [];
    for (const item of items) {
        if (item.retrieval_signal !== 'graph_symbol_node') {
            continue;
        }
        const key = `${item.symbol ?? ''}::${item.file}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        suggestions.push({ symbol: item.symbol, file: item.file });
        if (suggestions.length >= limit) {
            break;
        }
    }
    return suggestions;
}
