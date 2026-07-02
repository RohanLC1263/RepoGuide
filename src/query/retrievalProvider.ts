import { RepositoryContext } from '../context/repositoryContext';
import { EvidenceItem } from './evidencePacket';
import { FreshnessPolicy, QueryCategory, RepositoryIntelligencePlan, RetrievalPlan } from './executionPlanner';

export type EvidenceProviderKind =
    | 'hybrid_retrieval'
    | 'repository_brain'
    | 'fact_store'
    | 'logical_unit_store'
    | 'program_graph'
    | 'symbol_index'
    | 'vector_store'
    | 'bm25'
    | 'annotation'
    | 'note'
    | 'runtime'
    | 'investigation';

export interface EvidenceProviderCapabilities {
    evidenceTypes: string[];
    queryCategories: QueryCategory[];
    supportsFreshness: boolean;
    supportsProvenance: boolean;
}

export interface ProviderContext {
    repositoryContext: RepositoryContext;
}

export interface ProviderInitResult {
    ready: boolean;
    diagnostics: ProviderDiagnostic[];
}

export interface ProviderHealth {
    status: 'ready' | 'degraded' | 'unavailable';
    diagnostics: ProviderDiagnostic[];
}

export interface ProviderReadinessStatus {
    status: 'READY' | 'PARTIAL' | 'EMPTY' | 'FAILED';
    diagnostics: ProviderDiagnostic[];
    backingArtifacts?: string[];
    recordCount?: number;
}

export interface ProviderDecision {
    canHandle: boolean;
    reason?: string;
}

export interface EvidenceProviderRequest {
    requestId: string;
    planId: string;
    query: string;
    category: QueryCategory;
    retrievalPlan: RetrievalPlan;
    intelligencePlan?: RepositoryIntelligencePlan;
    targets: {
        symbols: string[];
        files: string[];
        concepts: string[];
    };
    limits: {
        maxItems: number;
        maxLatencyMs: number;
    };
    freshnessPolicy: FreshnessPolicy;
    diagnosticsContext?: Record<string, unknown>;
}

export interface ProviderDiagnostic {
    level: 'info' | 'warn' | 'error';
    message: string;
    providerId?: string;
}

export interface EvidenceProviderResponse {
    providerId: string;
    status: 'success' | 'partial' | 'empty' | 'timeout' | 'failed';
    items: EvidenceItem[];
    diagnostics: ProviderDiagnostic[];
    metadata: {
        latencyMs: number;
        sourceCount?: number;
        staleCount?: number;
        confidenceRange?: [number, number];
        raw?: unknown;
    };
}

export interface EvidenceProvider {
    readonly id: string;
    readonly kind: EvidenceProviderKind;
    readonly capabilities: EvidenceProviderCapabilities;

    initialize(context: ProviderContext): Promise<ProviderInitResult>;
    health(): Promise<ProviderHealth>;
    readiness(): Promise<ProviderReadinessStatus>;
    canHandle(request: EvidenceProviderRequest): ProviderDecision;
    retrieve(request: EvidenceProviderRequest): Promise<EvidenceProviderResponse>;
    shutdown(): Promise<void>;
}
