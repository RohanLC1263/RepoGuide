import { EvidenceItem } from '../query/evidencePacket';
import { identifierCorresponds, buildGraphSuggestions, GraphMatchSuggestion } from './graphIdentityMatch';

/**
 * Builds the get_dependents MCP response from raw retrieval items --
 * extracted as a standalone, side-effect-free module (see
 * askRepoguideTokenProcessor.ts's doc comment for why: mcpServer.ts runs a
 * heavyweight main() as an unconditional side effect of being imported, so
 * it can't be imported into a test process at all).
 *
 * Replaces the earlier flat `dependentFiles: string[]` shape (which deduped
 * away everything except the file path) with per-dependent detail --
 * symbol, line, and WHICH kind of relationship (caller/reader/importer/
 * instantiator/fallback consumer) -- that ProgramGraphStore.getDependents()
 * already computes and programGraphProvider.ts already attaches to each
 * item's retrieval_signal, but the old handler discarded.
 */

export type DependentRelationship = 'caller' | 'reader' | 'importer' | 'instantiator' | 'fallback_consumer';

const RELATIONSHIP_BY_SIGNAL: Record<string, DependentRelationship> = {
    graph_caller_dependency: 'caller',
    graph_reader_dependency: 'reader',
    graph_import_dependency: 'importer',
    graph_instantiation_dependency: 'instantiator',
    graph_fallback_dependency: 'fallback_consumer'
};

/**
 * Caps the caller's own identifier before it is echoed back in a not-found response.
 *
 * Measured: `get_dependents` with a 10,000-character junk symbol correctly returned
 * `found: false` with no dependents -- and a 20,258-character payload, because the
 * identifier is echoed twice (once as `requestedSymbol`, once inside `message`). The
 * verdict was right; the response was 60x larger than the equivalent answer for an
 * ordinary unknown symbol (300 chars). Nothing downstream needs more than enough
 * characters to recognise what was asked for.
 */
export function truncateIdentifierForEcho(identifier: string, max = 200): string {
    return identifier.length <= max ? identifier : identifier.slice(0, max) + `... (${identifier.length} chars total)`;
}

export interface DependentDetail {
    file: string;
    symbol?: string;
    startLine: number;
    relationship: DependentRelationship;
}

export interface DependentsResponse {
    found: boolean;
    requestedSymbol?: string;
    targetFile?: string;
    matchedSymbol?: EvidenceItem;
    dependents: DependentDetail[];
    suggestions?: GraphMatchSuggestion[];
    message?: string;
}

function collectDependents(items: EvidenceItem[]): DependentDetail[] {
    const dependents: DependentDetail[] = [];
    for (const item of items) {
        const relationship = RELATIONSHIP_BY_SIGNAL[item.retrieval_signal];
        if (!relationship) {
            continue;
        }
        dependents.push({
            file: item.file,
            symbol: item.symbol,
            startLine: item.startLine,
            relationship
        });
    }
    return dependents;
}

/**
 * @param requestedIdentifier the exact symbol/file the caller asked about. When
 *   supplied (the MCP get_dependents handler always does), the matched symbol
 *   node is validated against it: a token-only match that does not correspond
 *   to the request yields an explicit not-found response with closest-match
 *   suggestions, instead of silently describing the wrong symbol. Omitting it
 *   preserves the original first-symbol-node behavior for non-tool callers.
 */
export function buildDependentsResponse(items: EvidenceItem[], requestedIdentifier?: string): DependentsResponse {
    const symbolNodes = items.filter(item => item.retrieval_signal === 'graph_symbol_node');

    if (requestedIdentifier !== undefined) {
        const corresponding = symbolNodes.find(item => identifierCorresponds(requestedIdentifier, item));
        if (!corresponding) {
            const suggestions = buildGraphSuggestions(items);
            return {
                found: false,
                requestedSymbol: truncateIdentifierForEcho(requestedIdentifier),
                dependents: [],
                suggestions,
                message: `No symbol or file named "${truncateIdentifierForEcho(requestedIdentifier)}" was found in the program graph.`
                    + (suggestions.length ? ' Closest token matches (not necessarily related) are listed under "suggestions".' : '')
            };
        }
        return {
            found: true,
            requestedSymbol: truncateIdentifierForEcho(requestedIdentifier),
            targetFile: corresponding.file,
            matchedSymbol: corresponding,
            dependents: collectDependents(items)
        };
    }

    const matchedSymbolItem = symbolNodes[0] ?? items[0];
    return {
        found: true,
        targetFile: matchedSymbolItem?.file,
        matchedSymbol: matchedSymbolItem,
        dependents: collectDependents(items)
    };
}
