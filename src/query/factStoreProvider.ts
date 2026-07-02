import { FactRecord, FactType } from '../indexing/factTypes';
import { FactStore } from '../store/factStore';
import { EvidenceItem, SemanticCategory } from './evidencePacket';
import { confidenceToNumber, withNormalizedEvidenceFields } from './normalizedEvidence';
import {
    EvidenceProvider,
    EvidenceProviderCapabilities,
    EvidenceProviderRequest,
    EvidenceProviderResponse,
    ProviderContext,
    ProviderDecision,
    ProviderHealth,
    ProviderInitResult,
    ProviderReadinessStatus
} from './retrievalProvider';

const FACT_TYPES = new Set<FactType>([
    'constant',
    'numeric_threshold',
    'list_literal',
    'list_count',
    'dict_literal',
    'string_literal',
    'prompt_template',
    'config_value',
    'environment_variable',
    'fallback_chain',
    'guard_clause',
    'dependency_injection',
    'instantiation',
    'import',
    'exported_symbol',
    'call_site',
    'calls_method',
    'implements_interface',
    'assignment'
]);

export class FactStoreProvider implements EvidenceProvider {
    readonly id = 'fact_store';
    readonly kind = 'fact_store' as const;
    readonly capabilities: EvidenceProviderCapabilities = {
        evidenceTypes: Array.from(FACT_TYPES),
        queryCategories: [
            'factual_lookup',
            'symbol_lookup',
            'dependency_analysis',
            'architectural_reasoning',
            'debugging',
            'repository_exploration',
            'engineering_decision_support',
            'multi_step_reasoning'
        ],
        supportsFreshness: false,
        supportsProvenance: true
    };

    private initialized = false;

    constructor(private readonly factStore: FactStore) {}

    async initialize(_context: ProviderContext): Promise<ProviderInitResult> {
        this.initialized = true;
        return { ready: true, diagnostics: [] };
    }

    async health(): Promise<ProviderHealth> {
        return {
            status: this.initialized ? 'ready' : 'degraded',
            diagnostics: this.initialized ? [] : [{ level: 'warn', providerId: this.id, message: 'FactStoreProvider has not been initialized.' }]
        };
    }

    async readiness(): Promise<ProviderReadinessStatus> {
        if (!this.initialized) {
            return { status: 'FAILED', diagnostics: [{ level: 'warn', providerId: this.id, message: 'FactStoreProvider has not been initialized.' }], backingArtifacts: ['facts'] };
        }
        try {
            const sample = await this.factStore.queryFacts({ limit: 1 });
            return {
                status: sample.length > 0 ? 'READY' : 'EMPTY',
                diagnostics: sample.length > 0 ? [] : [{ level: 'warn', providerId: this.id, message: 'FactStore is empty.' }],
                backingArtifacts: ['facts'],
                recordCount: sample.length
            };
        } catch (error) {
            return { status: 'FAILED', diagnostics: [{ level: 'error', providerId: this.id, message: error instanceof Error ? error.message : String(error) }], backingArtifacts: ['facts'] };
        }
    }

    canHandle(request: EvidenceProviderRequest): ProviderDecision {
        if (!request.retrievalPlan.providerIds.includes(this.id)) {
            return { canHandle: false, reason: 'Provider was not selected by the execution plan.' };
        }
        if (!this.capabilities.queryCategories.includes(request.category)) {
            return { canHandle: false, reason: `FactStoreProvider does not handle ${request.category}.` };
        }
        return { canHandle: true };
    }

    async retrieve(request: EvidenceProviderRequest): Promise<EvidenceProviderResponse> {
        const startedAt = performance.now();
        try {
            const facts = await this.retrieveFacts(request);
            const items = dedupeFacts(facts)
                .slice(0, request.limits.maxItems)
                .map(fact => factToEvidenceItem(fact, this.id));
            const confidences = items.map(item => confidenceToNumber(item.confidence));
            return {
                providerId: this.id,
                status: items.length > 0 ? 'success' : 'empty',
                items,
                diagnostics: [{ level: 'info', providerId: this.id, message: `FactStoreProvider returned ${items.length} facts.` }],
                metadata: {
                    latencyMs: performance.now() - startedAt,
                    sourceCount: items.length,
                    confidenceRange: confidenceRange(confidences)
                }
            };
        } catch (error) {
            return {
                providerId: this.id,
                status: 'failed',
                items: [],
                diagnostics: [{ level: 'error', providerId: this.id, message: error instanceof Error ? error.message : String(error) }],
                metadata: { latencyMs: performance.now() - startedAt, sourceCount: 0 }
            };
        }
    }

    async shutdown(): Promise<void> {
        this.initialized = false;
    }

    private async retrieveFacts(request: EvidenceProviderRequest): Promise<FactRecord[]> {
        const excludeRoles = request.retrievalPlan.excludedRoles;
        const results: FactRecord[] = [];
        const queryTerms = queryTermsFor(request.query);
        const symbols = unique([...request.targets.symbols, ...queryTerms.identifierTerms]);

        for (const symbol of symbols) {
            results.push(...await this.factStore.findBySymbol(symbol, { excludeRoles, limit: request.limits.maxItems }));
        }
        for (const filePath of request.targets.files) {
            results.push(...await this.factStore.queryFacts({ filePath, excludeRoles, limit: request.limits.maxItems }));
        }
        for (const preferred of expandPreferredFactTypes(request.retrievalPlan.preferredEvidenceTypes)) {
            results.push(...await this.factStore.findByType(preferred, { excludeRoles, limit: request.limits.maxItems }));
        }

        const candidateFacts = await this.factStore.queryFacts({ excludeRoles, limit: 500 });
        const scored = candidateFacts
            .map(fact => ({ fact, score: scoreFact(fact, queryTerms.tokens) }))
            .filter(result => result.score > 0)
            .sort((a, b) => b.score - a.score || compareFacts(a.fact, b.fact))
            .slice(0, request.limits.maxItems)
            .map(result => result.fact);
        results.push(...scored);
        return results;
    }
}

const PREFERRED_FACT_TYPE_ALIASES: Record<string, FactType[]> = {
    'fact evidence': Array.from(FACT_TYPES),
    'source span evidence': ['call_site', 'calls_method', 'assignment', 'import', 'exported_symbol'],
    'fallback order facts': ['fallback_chain', 'guard_clause'],
    'instantiation details': ['instantiation'],
    'DI parameters': ['dependency_injection'],
    'exact prompt string': ['prompt_template', 'string_literal'],
    'configuration keys': ['config_value', 'environment_variable'],
    'fallback/guard facts': ['fallback_chain', 'guard_clause'],
    'call_site': ['call_site'],
    'dependency facts': ['call_site', 'calls_method', 'dependency_injection', 'instantiation', 'import'],
    'flow evidence': ['call_site', 'calls_method', 'fallback_chain', 'guard_clause', 'assignment']
};

const QUERY_STOPWORDS = new Set([
    'what', 'where', 'which', 'does', 'this', 'that', 'project', 'file', 'files', 'define', 'defines',
    'implemented', 'implementation', 'frontend', 'backend', 'responsibilities', 'responsibility', 'from',
    'into', 'with', 'the', 'and', 'for', 'how', 'why', 'are', 'is', 'api', 'endpoint', 'service', 'logic',
    'context', 'load', 'stores', 'table', 'database', 'display', 'order', 'orders'
]);

interface QueryTerms {
    tokens: string[];
    identifierTerms: string[];
}

function expandPreferredFactTypes(preferredEvidenceTypes: string[]): FactType[] {
    const expanded: FactType[] = [];
    for (const preferred of preferredEvidenceTypes) {
        if (FACT_TYPES.has(preferred as FactType)) {
            expanded.push(preferred as FactType);
            continue;
        }
        expanded.push(...(PREFERRED_FACT_TYPE_ALIASES[preferred] ?? []));
    }
    return unique(expanded);
}

function queryTermsFor(query: string): QueryTerms {
    const raw = query.match(/[A-Za-z_$][A-Za-z0-9_$]*|\/[A-Za-z0-9_.$/:{}-]+/g) ?? [];
    const tokens = unique(raw.flatMap(token => splitIdentifier(token)))
        .map(token => token.toLowerCase())
        .filter(token => token.length > 1 && !QUERY_STOPWORDS.has(token));
    const identifierTerms = unique(raw
        .filter(token => /[_$A-Z/.-]/.test(token) || token.length > 3)
        .flatMap(token => [token, token.replace(/^\//, ''), token.replace(/[^A-Za-z0-9_$]/g, '_')])
        .filter(token => token.length > 1 && !QUERY_STOPWORDS.has(token.toLowerCase())));
    return { tokens, identifierTerms };
}

function splitIdentifier(value: string): string[] {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9_$]+|_/)
        .filter(Boolean);
}

function scoreFact(fact: FactRecord, tokens: string[]): number {
    if (tokens.length === 0) return 0;
    const haystack = [
        fact.filePath,
        fact.symbol ?? '',
        fact.factType,
        fact.valueKind,
        fact.sourceText,
        typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value)
    ].join('\n').toLowerCase();
    return tokens.reduce((score, token) => score + occurrences(haystack, token), 0);
}

function occurrences(haystack: string, needle: string): number {
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count++;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}

function compareFacts(a: FactRecord, b: FactRecord): number {
    return a.filePath.localeCompare(b.filePath) ||
        a.startLine - b.startLine ||
        a.endLine - b.endLine ||
        a.factType.localeCompare(b.factType) ||
        a.factId.localeCompare(b.factId);
}

function unique<T>(values: T[]): T[] {
    return Array.from(new Set(values));
}
function factToEvidenceItem(fact: FactRecord, providerId: string): EvidenceItem {
    const content = fact.sourceText || String(fact.value);
    return withNormalizedEvidenceFields({
        id: fact.factId,
        file: fact.filePath,
        startLine: fact.startLine,
        endLine: fact.endLine,
        role: fact.role,
        factId: fact.factId,
        unitId: fact.unitId,
        symbol: fact.symbol,
        type: fact.factType,
        content,
        retrieval_signal: 'fact_store_direct',
        semanticCategory: SemanticCategory.BEHAVIOR,
        score: confidenceToNumber(fact.confidence),
        confidence: fact.confidence,
        extractionMethod: fact.extractionMethod
    }, {
        providerId,
        evidenceType: fact.factType,
        freshness: 'unknown',
        provenance: {
            providerId,
            source: 'FactStore',
            sourceId: fact.factId,
            sourceType: fact.factType,
            confidence: fact.confidence,
            metadata: {
                unitId: fact.unitId,
                subjectUuid: fact.subjectUuid,
                objectUuid: fact.objectUuid,
                valueKind: fact.valueKind,
                diagnostics: fact.diagnostics
            }
        },
        canonicalSource: {
            providerId,
            file: fact.filePath,
            startLine: fact.startLine,
            endLine: fact.endLine,
            symbol: fact.symbol,
            sourceId: fact.factId,
            sourceType: fact.factType
        }
    });
}

function dedupeFacts(facts: FactRecord[]): FactRecord[] {
    const byId = new Map<string, FactRecord>();
    for (const fact of facts) {
        byId.set(fact.factId, fact);
    }
    return Array.from(byId.values());
}

function confidenceRange(values: number[]): [number, number] | undefined {
    if (values.length === 0) {
        return undefined;
    }
    return [Math.min(...values), Math.max(...values)];
}