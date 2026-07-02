import { ConceptEntry, ConceptMap, ConceptSearchResult, NavigationTarget } from './types';

export class ConceptMapSearcher {
    constructor(
        private index: Map<string, ConceptEntry[]>,
        private map: ConceptMap
    ) { }

    setData(index: Map<string, ConceptEntry[]>, map: ConceptMap): void {
        this.index = index;
        this.map = map;
    }

    getIndex(): Map<string, ConceptEntry[]> {
        return this.index;
    }

    getMap(): ConceptMap {
        return this.map;
    }

    isLoaded(): boolean { return this.index !== null && this.index.size > 0; }

    search(question: string, topK = 10): ConceptSearchResult[] {
        try {
            const tokens = this.extractConcepts(question);
            const results: ConceptSearchResult[] = [];

            for (const token of tokens) {
                const exactEntries = this.index.get(token) ?? [];
                for (const entry of exactEntries) {
                    this.addEntryResults(results, entry, 'exact', 1.0);
                }

                const synonymEntries = this.lookupFuzzy(token)
                    .filter(entry => entry.synonyms.some(synonym => normalize(synonym) === token));
                for (const entry of synonymEntries) {
                    this.addEntryResults(results, entry, 'synonym', 0.9);
                }

                if (token.length >= 4) {
                    const partialEntries = this.lookupFuzzy(token).filter(entry => {
                        const concept = normalize(entry.concept);
                        return concept.includes(token) || token.includes(concept) || entry.synonyms.some(synonym => {
                            const normalizedSynonym = normalize(synonym);
                            return normalizedSynonym.includes(token) || token.includes(normalizedSynonym);
                        });
                    });
                    for (const entry of partialEntries) {
                        this.addEntryResults(results, entry, 'partial', 0.7);
                    }
                }

                const relatedEntries = this.map.concepts.filter(entry =>
                    entry.relatedConcepts.some(related => normalize(related) === token)
                );
                for (const entry of relatedEntries) {
                    this.addEntryResults(results, entry, 'related', 0.5);
                }
            }

            const deduped = new Map<string, ConceptSearchResult>();
            for (const result of results) {
                const key = `${result.location.filePath}:${result.location.startLine}`;
                const existing = deduped.get(key);
                if (!existing || result.matchScore > existing.matchScore) {
                    deduped.set(key, result);
                }
            }

            return Array.from(deduped.values())
                .sort((a, b) => {
                    const typeOrder: Record<ConceptSearchResult['matchType'], number> = {
                        exact: 3,
                        synonym: 2,
                        partial: 1,
                        related: 0
                    };
                    const typeDiff = (typeOrder[b.matchType] ?? 0) - (typeOrder[a.matchType] ?? 0);
                    if (typeDiff !== 0) {
                        return typeDiff;
                    }
                    return b.matchScore - a.matchScore;
                })
                .slice(0, topK);
        } catch {
            return [];
        }
    }

    searchForNavigation(question: string, topK = 5): NavigationTarget[] {
        const results = this.search(question, topK * 2);

        return results
            .filter(result => result.matchScore > 0.5)
            .slice(0, topK)
            .map(result => ({
                filePath: result.location.filePath,
                startLine: result.location.startLine,
                endLine: result.location.endLine,
                confidence: Math.min(0.95, result.matchScore),
                source: 'concept_map',
                symbolName: result.location.symbolName,
                reason: `Concept map match: "${result.matchedConcept}" (${result.matchType})`
            }));
    }

    extractConcepts(question: string): string[] {
        return Array.from(new Set(
            question
                .toLowerCase()
                .replace(/[^a-z0-9_\-\s]/g, ' ')
                .split(/\s+/)
                .map(token => token.trim())
                .filter(token => token.length > 2 && !STOP_WORDS.has(token))
        ));
    }

    lookup(concept: string): ConceptEntry | null {
        const normalized = normalize(concept);
        return this.index.get(normalized)?.[0] ?? null;
    }

    lookupFuzzy(term: string): ConceptEntry[] {
        const normalized = normalize(term);
        if (!normalized) {
            return [];
        }

        const matches: ConceptEntry[] = [];
        for (const [key, entries] of this.index.entries()) {
            if (key.includes(normalized) || normalized.includes(key)) {
                for (const entry of entries) {
                    if (!matches.includes(entry)) {
                        matches.push(entry);
                    }
                }
            }
        }
        return matches;
    }

    getRelated(concept: string): string[] {
        return this.lookup(concept)?.relatedConcepts ?? [];
    }

    private addEntryResults(
        results: ConceptSearchResult[],
        entry: ConceptEntry,
        matchType: ConceptSearchResult['matchType'],
        multiplier: number
    ): void {
        for (const location of entry.locations) {
            results.push({
                location,
                matchedConcept: entry.concept,
                matchScore: location.relevanceScore * multiplier,
                matchType
            });
        }
    }
}

const STOP_WORDS = new Set([
    'what', 'does', 'the', 'this', 'that', 'with', 'from', 'have',
    'where', 'which', 'about', 'their', 'there', 'would', 'could',
    'should', 'explain', 'describe', 'tell', 'show', 'find', 'give',
    'how', 'does', 'work', 'used', 'uses', 'using', 'code', 'file',
    'function', 'class', 'method', 'module', 'project', 'please'
]);

function normalize(value: string): string {
    return value.toLowerCase().trim();
}
