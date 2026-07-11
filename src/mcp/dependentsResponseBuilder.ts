import { EvidenceItem } from '../query/evidencePacket';

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

export interface DependentDetail {
    file: string;
    symbol?: string;
    startLine: number;
    relationship: DependentRelationship;
}

export interface DependentsResponse {
    targetFile?: string;
    matchedSymbol?: EvidenceItem;
    dependents: DependentDetail[];
}

export function buildDependentsResponse(items: EvidenceItem[]): DependentsResponse {
    const matchedSymbolItem = items.find(item => item.retrieval_signal === 'graph_symbol_node') ?? items[0];

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

    return {
        targetFile: matchedSymbolItem?.file,
        matchedSymbol: matchedSymbolItem,
        dependents
    };
}
