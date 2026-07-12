import { EvidenceItem } from '../query/evidencePacket';

/**
 * Builds the get_dependencies MCP response from raw retrieval items -- twin
 * of dependentsResponseBuilder.ts's buildDependentsResponse, same
 * standalone/side-effect-free extraction for the same reason (mcpServer.ts
 * runs a heavyweight main() as an unconditional side effect of being
 * imported, so it can't be imported into a test process).
 *
 * get_dependents answers "who depends on this" (inbound graph edges);
 * get_dependencies answers "what does this itself call/read/import/
 * instantiate/fall back to" (outbound graph edges) -- the reverse
 * direction, backed by ProgramGraphStore.getDependencies() (the literal
 * outbound mirror of getDependents()). ProgramGraphProvider computes both
 * directions unconditionally for every retrieval (the same way it already
 * always computes a target's own symbol-node info alongside its dependents),
 * tagging each with a distinct retrieval_signal; this builder filters the
 * combined item set down to only the outbound-relationship signals, exactly
 * as buildDependentsResponse filters down to only the inbound ones from the
 * same superset.
 */

export type DependencyRelationship = 'callee' | 'read_target' | 'import_target' | 'instantiation_target' | 'fallback_target';

const RELATIONSHIP_BY_SIGNAL: Record<string, DependencyRelationship> = {
    graph_callee_dependency: 'callee',
    graph_read_target_dependency: 'read_target',
    graph_import_target_dependency: 'import_target',
    graph_instantiation_target_dependency: 'instantiation_target',
    graph_fallback_target_dependency: 'fallback_target'
};

export interface DependencyDetail {
    file: string;
    symbol?: string;
    startLine: number;
    relationship: DependencyRelationship;
}

export interface DependenciesResponse {
    sourceFile?: string;
    matchedSymbol?: EvidenceItem;
    dependencies: DependencyDetail[];
}

export function buildDependenciesResponse(items: EvidenceItem[]): DependenciesResponse {
    const matchedSymbolItem = items.find(item => item.retrieval_signal === 'graph_symbol_node') ?? items[0];

    const dependencies: DependencyDetail[] = [];
    for (const item of items) {
        const relationship = RELATIONSHIP_BY_SIGNAL[item.retrieval_signal];
        if (!relationship) {
            continue;
        }
        dependencies.push({
            file: item.file,
            symbol: item.symbol,
            startLine: item.startLine,
            relationship
        });
    }

    return {
        sourceFile: matchedSymbolItem?.file,
        matchedSymbol: matchedSymbolItem,
        dependencies
    };
}
