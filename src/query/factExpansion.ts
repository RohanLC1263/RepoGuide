import { LogicalUnitIndex, LogicalUnitRole, LogicalUnitConfidence } from '../indexing/logicalUnitTypes';
import { FactRecord } from '../indexing/factTypes';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { FactStore } from '../store/factStore';
import { SymbolIndex } from '../indexing/symbolIndex';

export interface FactExpansionResult {
    expandedFacts: ExpandedFact[];
}

export interface ExpandedFact {
    fact: FactRecord;
    retrieval_signal: string;
    reason: string;
    sourceUnitId: string;
    confidence: number;
    depth: number;
}

export interface ExpansionStores {
    unitStore: LogicalUnitStore;
    factStore: FactStore;
    symbolIndex?: SymbolIndex;
}

export async function expandConstantsAndFacts(
    seedUnits: LogicalUnitIndex[],
    query: string,
    stores: ExpansionStores,
    maxDepth = 2,
    maxFacts = 50
): Promise<FactExpansionResult> {
    const isTestQuery = /test|mock|spec|stub|fixture/i.test(query);
    const excludeRoles: LogicalUnitRole[] = isTestQuery ? [] : ['test', 'generated'];

    const expandedFactsMap = new Map<string, ExpandedFact>();
    const seenSymbols = new Set<string>();

    let currentLevelUnits = seedUnits.map(u => ({ id: u.id, sourceUnitId: u.id }));
    
    for (let depth = 0; depth < maxDepth; depth++) {
        if (currentLevelUnits.length === 0 || expandedFactsMap.size >= maxFacts) {
            break;
        }

        const nextLevelSymbols = new Set<{ symbol: string, sourceUnitId: string }>();

        // For each unit in current level, parse tokens
        for (const unitRef of currentLevelUnits) {
            // First time it's from seed units, next times it's from expanded facts (we use their source unit id)
            const unit = await stores.unitStore.getUnit(unitRef.id);
            if (!unit) continue;

            const tokens = Array.from(new Set(unit.content.match(/[A-Z_a-z][\w]*/g) || []));
            for (const token of tokens) {
                if (token.length < 3 || seenSymbols.has(token)) {
                    continue;
                }
                seenSymbols.add(token);
                nextLevelSymbols.add({ symbol: token, sourceUnitId: unitRef.sourceUnitId });
            }
        }

        const nextLevelFacts: FactRecord[] = [];
        const factToSourceMap = new Map<string, string>();

        for (const { symbol, sourceUnitId } of nextLevelSymbols) {
            const facts = await stores.factStore.findBySymbol(symbol, { excludeRoles });
            for (const fact of facts) {
                if (!expandedFactsMap.has(fact.factId)) {
                    nextLevelFacts.push(fact);
                    factToSourceMap.set(fact.factId, sourceUnitId);
                }
            }
        }

        const factTypePriority: Record<string, number> = {
            'numeric_threshold': 1, 'constant': 1, 'config_value': 1, 'environment_variable': 1,
            'list_literal': 1, 'list_count': 1, 'prompt_template': 1, 'instantiation': 2,
            'fallback_chain': 3, 'guard_clause': 4, 'assignment': 5, 'call_site': 6
        };
        
        nextLevelFacts.sort((a, b) => {
            const pA = factTypePriority[a.factType] || 10;
            const pB = factTypePriority[b.factType] || 10;
            if (pA !== pB) return pA - pB;
            return getConfidenceScore(b.confidence) - getConfidenceScore(a.confidence);
        });

        currentLevelUnits = [];

        for (const fact of nextLevelFacts) {
            if (expandedFactsMap.size >= maxFacts) break;
            expandedFactsMap.set(fact.factId, {
                fact,
                retrieval_signal: 'symbol_reference',
                reason: `Seed unit referenced exact symbol ${fact.symbol}`,
                sourceUnitId: factToSourceMap.get(fact.factId)!,
                confidence: getConfidenceScore(fact.confidence),
                depth
            });

            // If the fact itself contains complex structured text, queue its unit for the next level
            if (fact.valueKind === 'string' || fact.valueKind === 'ast_node') {
                currentLevelUnits.push({ id: fact.unitId, sourceUnitId: factToSourceMap.get(fact.factId)! });
            }
        }
    }

    const expandedFacts = Array.from(expandedFactsMap.values());
    expandedFacts.sort(compareExpandedFacts);

    return { expandedFacts: expandedFacts.slice(0, maxFacts) };
}

function getConfidenceScore(c: LogicalUnitConfidence): number {
    if (c === 'high') return 1.0;
    if (c === 'medium') return 0.7;
    if (c === 'low') return 0.3;
    return 0.5;
}

function compareExpandedFacts(a: ExpandedFact, b: ExpandedFact): number {
    if (a.confidence !== b.confidence) {
        return b.confidence - a.confidence;
    }
    if (a.depth !== b.depth) {
        return a.depth - b.depth;
    }
    const pathCmp = a.fact.filePath.localeCompare(b.fact.filePath);
    if (pathCmp !== 0) {
        return pathCmp;
    }
    return a.fact.startLine - b.fact.startLine;
}
