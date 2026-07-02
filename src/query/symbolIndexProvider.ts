import { SymbolIndex } from '../indexing/symbolIndex';
import { SymbolEntry } from '../store/storeTypes';
import { EvidenceItem, SemanticCategory } from './evidencePacket';
import { withNormalizedEvidenceFields } from './normalizedEvidence';
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

export class SymbolIndexProvider implements EvidenceProvider {
    readonly id = 'symbol_index';
    readonly kind = 'symbol_index' as const;
    readonly capabilities: EvidenceProviderCapabilities = {
        evidenceTypes: ['symbol_match', 'symbol_alias', 'symbol_location'],
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

    constructor(private readonly symbolIndex: SymbolIndex) {}

    async initialize(_context: ProviderContext): Promise<ProviderInitResult> {
        this.initialized = true;
        return { ready: true, diagnostics: [] };
    }

    async health(): Promise<ProviderHealth> {
        return {
            status: this.initialized ? 'ready' : 'degraded',
            diagnostics: this.initialized ? [] : [{ level: 'warn', providerId: this.id, message: 'SymbolIndexProvider has not been initialized.' }]
        };
    }

    async readiness(): Promise<ProviderReadinessStatus> {
        if (!this.initialized) {
            return { status: 'FAILED', diagnostics: [{ level: 'warn', providerId: this.id, message: 'SymbolIndexProvider has not been initialized.' }], backingArtifacts: ['symbols'] };
        }
        const stats = this.symbolIndex.getStats();
        return {
            status: stats.totalSymbols > 0 ? 'READY' : 'EMPTY',
            diagnostics: stats.totalSymbols > 0 ? [] : [{ level: 'warn', providerId: this.id, message: 'SymbolIndex is empty.' }],
            backingArtifacts: ['symbols'],
            recordCount: stats.totalSymbols
        };
    }

    canHandle(request: EvidenceProviderRequest): ProviderDecision {
        if (!request.retrievalPlan.providerIds.includes(this.id)) {
            return { canHandle: false, reason: 'Provider was not selected by the execution plan.' };
        }
        if (!this.capabilities.queryCategories.includes(request.category)) {
            return { canHandle: false, reason: `SymbolIndexProvider does not handle ${request.category}.` };
        }
        return { canHandle: true };
    }

    async retrieve(request: EvidenceProviderRequest): Promise<EvidenceProviderResponse> {
        const startedAt = performance.now();
        try {
            const matches: Array<{ entry: SymbolEntry; confidence: number; signal: string }> = [];
            for (const symbol of request.targets.symbols) {
                matches.push(...this.symbolIndex.lookupExact(symbol).map(result => ({ ...result, signal: 'symbol_exact' })));
                matches.push(...this.symbolIndex.lookupFuzzy(symbol).map(entry => ({ entry, confidence: 0.75, signal: 'symbol_alias' })));
            }
            if (matches.length === 0 && request.query) {
                const tokens = tokenize(request.query);
                matches.push(...this.symbolIndex.lookupByConceptTokens(tokens).map(result => ({ ...result, signal: 'symbol_concept' })));
            }
            const items = dedupeMatches(matches)
                .slice(0, request.limits.maxItems)
                .map(match => symbolToEvidenceItem(match.entry, match.confidence, match.signal, this.id));
            return {
                providerId: this.id,
                status: items.length > 0 ? 'success' : 'empty',
                items,
                diagnostics: [{ level: 'info', providerId: this.id, message: `SymbolIndexProvider returned ${items.length} symbol matches.` }],
                metadata: {
                    latencyMs: performance.now() - startedAt,
                    sourceCount: items.length,
                    confidenceRange: items.length > 0 ? [Math.min(...items.map(i => Number(i.confidence))), Math.max(...items.map(i => Number(i.confidence)))] : undefined
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
}

function symbolToEvidenceItem(entry: SymbolEntry, confidence: number, signal: string, providerId: string): EvidenceItem {
    return withNormalizedEvidenceFields({
        id: `${providerId}_${entry.filePath}_${entry.startLine}_${entry.endLine}_${entry.name}`,
        file: entry.filePath,
        startLine: entry.startLine,
        endLine: entry.endLine,
        role: 'implementation',
        symbol: entry.name,
        type: 'symbol_match',
        content: `Symbol ${entry.name} (${entry.kind}) located at ${entry.filePath}:${entry.startLine}-${entry.endLine}`,
        retrieval_signal: signal,
        semanticCategory: SemanticCategory.GENERAL,
        score: confidence,
        confidence,
        extractionMethod: 'symbol_index'
    }, {
        providerId,
        evidenceType: signal === 'symbol_alias' ? 'symbol_alias' : 'symbol_match',
        freshness: 'unknown',
        provenance: {
            providerId,
            source: 'SymbolIndex',
            sourceId: `${entry.filePath}:${entry.startLine}:${entry.endLine}:${entry.name}`,
            sourceType: entry.kind,
            confidence,
            metadata: { canonicalId: entry.canonicalId, signal }
        },
        canonicalSource: {
            providerId,
            file: entry.filePath,
            startLine: entry.startLine,
            endLine: entry.endLine,
            symbol: entry.name,
            sourceId: `${entry.filePath}:${entry.startLine}:${entry.endLine}:${entry.name}`,
            sourceType: entry.kind
        }
    });
}

function tokenize(query: string): string[] {
    return Array.from(new Set(query.toLowerCase().match(/[a-z0-9_$]+/g) ?? []));
}

function dedupeMatches(matches: Array<{ entry: SymbolEntry; confidence: number; signal: string }>): Array<{ entry: SymbolEntry; confidence: number; signal: string }> {
    const byKey = new Map<string, { entry: SymbolEntry; confidence: number; signal: string }>();
    for (const match of matches) {
        const key = `${match.entry.filePath}:${match.entry.startLine}:${match.entry.endLine}:${match.entry.name}`;
        const existing = byKey.get(key);
        if (!existing || match.confidence > existing.confidence) byKey.set(key, match);
    }
    return Array.from(byKey.values()).sort((a, b) => b.confidence - a.confidence);
}