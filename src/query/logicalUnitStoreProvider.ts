import { LogicalUnit, LogicalUnitIndex } from '../indexing/logicalUnitTypes';
import { LogicalUnitStore } from '../store/logicalUnitStore';
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

export class LogicalUnitStoreProvider implements EvidenceProvider {
    readonly id = 'logical_unit_store';
    readonly kind = 'logical_unit_store' as const;
    readonly capabilities: EvidenceProviderCapabilities = {
        evidenceTypes: ['logical_unit', 'source_span', 'symbol_definition'],
        queryCategories: [
            'factual_lookup',
            'symbol_lookup',
            'dependency_analysis',
            'architectural_reasoning',
            'debugging',
            'documentation',
            'repository_exploration',
            'engineering_decision_support',
            'multi_step_reasoning'
        ],
        supportsFreshness: false,
        supportsProvenance: true
    };

    private initialized = false;

    constructor(private readonly unitStore: LogicalUnitStore) {}

    async initialize(_context: ProviderContext): Promise<ProviderInitResult> {
        this.initialized = true;
        return { ready: true, diagnostics: [] };
    }

    async health(): Promise<ProviderHealth> {
        return {
            status: this.initialized ? 'ready' : 'degraded',
            diagnostics: this.initialized ? [] : [{ level: 'warn', providerId: this.id, message: 'LogicalUnitStoreProvider has not been initialized.' }]
        };
    }

    async readiness(): Promise<ProviderReadinessStatus> {
        if (!this.initialized) {
            return { status: 'FAILED', diagnostics: [{ level: 'warn', providerId: this.id, message: 'LogicalUnitStoreProvider has not been initialized.' }], backingArtifacts: ['logical_units'] };
        }
        try {
            const sample = await this.unitStore.listIndexes({ limit: 1 });
            return {
                status: sample.length > 0 ? 'READY' : 'EMPTY',
                diagnostics: sample.length > 0 ? [] : [{ level: 'warn', providerId: this.id, message: 'LogicalUnitStore is empty.' }],
                backingArtifacts: ['logical_units'],
                recordCount: sample.length
            };
        } catch (error) {
            return { status: 'FAILED', diagnostics: [{ level: 'error', providerId: this.id, message: error instanceof Error ? error.message : String(error) }], backingArtifacts: ['logical_units'] };
        }
    }

    canHandle(request: EvidenceProviderRequest): ProviderDecision {
        if (!request.retrievalPlan.providerIds.includes(this.id)) {
            return { canHandle: false, reason: 'Provider was not selected by the execution plan.' };
        }
        if (!this.capabilities.queryCategories.includes(request.category)) {
            return { canHandle: false, reason: `LogicalUnitStoreProvider does not handle ${request.category}.` };
        }
        return { canHandle: true };
    }

    async retrieve(request: EvidenceProviderRequest): Promise<EvidenceProviderResponse> {
        const startedAt = performance.now();
        try {
            const units = await this.retrieveUnits(request);
            const items = dedupeUnits(units)
                .slice(0, request.limits.maxItems)
                .map(unit => unitToEvidenceItem(unit, this.id));
            const confidences = items.map(item => confidenceToNumber(item.confidence));
            return {
                providerId: this.id,
                status: items.length > 0 ? 'success' : 'empty',
                items,
                diagnostics: [{ level: 'info', providerId: this.id, message: `LogicalUnitStoreProvider returned ${items.length} logical units.` }],
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

    private async retrieveUnits(request: EvidenceProviderRequest): Promise<LogicalUnit[]> {
        const indexes: LogicalUnitIndex[] = [];
        for (const symbol of request.targets.symbols) {
            indexes.push(...await this.unitStore.searchBySymbol(symbol, { limit: request.limits.maxItems }));
        }
        for (const file of request.targets.files) {
            indexes.push(...(await this.unitStore.getUnitsByFile(file)).map(unit => ({
                id: unit.id,
                uuid: unit.uuid,
                type: unit.type,
                symbol: unit.symbol,
                filePath: unit.filePath,
                language: unit.language,
                startLine: unit.startLine,
                endLine: unit.endLine,
                role: unit.role,
                parseStatus: unit.parseStatus
            })));
        }
        const contentQuery = contentQueryFor(request.query);
        if (contentQuery) {
            indexes.push(...await this.unitStore.searchByContent(contentQuery, {
                excludeRoles: request.retrievalPlan.excludedRoles,
                limit: request.limits.maxItems
            }));
        }

        const units: LogicalUnit[] = [];
        for (const index of indexes) {
            if (request.retrievalPlan.excludedRoles.includes(index.role as any)) {
                continue;
            }
            const unit = await this.unitStore.getUnit(index.id);
            if (unit) {
                units.push(unit);
            }
        }
        return units;
    }
}


const LOGICAL_UNIT_QUERY_STOPWORDS = new Set([
    'what', 'where', 'which', 'does', 'this', 'that', 'project', 'file', 'files', 'define', 'defines',
    'implemented', 'implementation', 'responsibilities', 'responsibility', 'from', 'into', 'with',
    'the', 'and', 'for', 'how', 'why', 'are', 'is', 'context', 'display', 'stores', 'table', 'database'
]);

function contentQueryFor(query: string): string {
    const raw = query.match(/[A-Za-z_$][A-Za-z0-9_$]*|\/[A-Za-z0-9_.$/:{}-]+/g) ?? [];
    const terms = Array.from(new Set(raw
        .flatMap(token => [token, ...splitIdentifier(token)])
        .map(token => token.toLowerCase())
        .filter(token => token.length > 2 && !LOGICAL_UNIT_QUERY_STOPWORDS.has(token))));
    return terms.join(' ');
}

function splitIdentifier(value: string): string[] {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9_$]+|_/)
        .filter(Boolean);
}
function unitToEvidenceItem(unit: LogicalUnit, providerId: string): EvidenceItem {
    const confidence = unit.metadata.confidence;
    return withNormalizedEvidenceFields({
        id: unit.id,
        file: unit.filePath,
        startLine: unit.startLine,
        endLine: unit.endLine,
        role: unit.role,
        unitId: unit.id,
        symbol: unit.symbol,
        type: unit.type,
        content: unit.content,
        retrieval_signal: 'logical_unit_store',
        semanticCategory: SemanticCategory.GENERAL,
        score: confidenceToNumber(confidence),
        confidence,
        extractionMethod: unit.extractionMethod
    }, {
        providerId,
        evidenceType: 'logical_unit',
        freshness: 'unknown',
        provenance: {
            providerId,
            source: 'LogicalUnitStore',
            sourceId: unit.id,
            sourceType: unit.type,
            confidence,
            metadata: {
                uuid: unit.uuid,
                language: unit.language,
                parentUnitId: unit.parentUnitId,
                parentSymbol: unit.parentSymbol,
                parseStatus: unit.parseStatus,
                extractionMethod: unit.extractionMethod,
                ownerRole: unit.role
            }
        },
        canonicalSource: {
            providerId,
            file: unit.filePath,
            startLine: unit.startLine,
            endLine: unit.endLine,
            symbol: unit.symbol,
            sourceId: unit.id,
            sourceType: unit.type
        }
    });
}

function dedupeUnits(units: LogicalUnit[]): LogicalUnit[] {
    const byId = new Map<string, LogicalUnit>();
    for (const unit of units) {
        byId.set(unit.id, unit);
    }
    return Array.from(byId.values());
}

function confidenceRange(values: number[]): [number, number] | undefined {
    if (values.length === 0) {
        return undefined;
    }
    return [Math.min(...values), Math.max(...values)];
}