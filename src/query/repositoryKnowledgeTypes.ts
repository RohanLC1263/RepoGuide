import { RepositoryKnowledgeType } from './executionPlanner';

export type { RepositoryKnowledgeType };

export type KnowledgeLifecycleState =
    | 'candidate'
    | 'validated'
    | 'promoted'
    | 'active'
    | 'stale'
    | 'contradicted'
    | 'retired'
    | 'archived';

export type KnowledgeValidationState =
    | 'unvalidated'
    | 'machine_validated'
    | 'runtime_validated'
    | 'developer_validated'
    | 'contradicted'
    | 'invalid';

export type KnowledgeSubjectKind = 'file' | 'symbol' | 'module' | 'decision' | 'runtime_component' | 'repository';

/** Concrete shape for the frozen contract's prose-only `subject` field rule. */
export interface KnowledgeSubject {
    kind: KnowledgeSubjectKind;
    /** Stable identifier within `kind` — file path, symbol name, ADR id, component id, or 'repository'. */
    id: string;
    file?: string;
    symbol?: string;
}

/** Concrete shape for the frozen contract's prose-only `claim` field rule. */
export interface KnowledgeClaim {
    /** Human-readable summary. */
    text: string;
    /** Machine-classifiable structured payload. */
    data: Record<string, unknown>;
}

export interface KnowledgeConfidenceBreakdown {
    [signal: string]: number | undefined;
}

/** Concrete shape for the frozen contract's "numeric score and source breakdown" rule. */
export interface KnowledgeConfidence {
    score: number;
    breakdown: KnowledgeConfidenceBreakdown;
}

/** Concrete shape for the frozen contract's "must reference source artifacts" rule. */
export interface KnowledgeProvenance {
    sourceArtifacts: string[];
    producedBy: string;
}

/** Concrete shape for the frozen contract's "must be recomputable" freshness rule. */
export interface KnowledgeFreshness {
    state: 'fresh' | 'possibly_stale' | 'stale' | 'unknown';
    computedAt: string;
    basis: string;
}

export interface KnowledgeEvidenceRef {
    sourceTable: string;
    sourceId: string;
    description?: string;
}

export interface KnowledgeContradiction {
    conflictingClaim: KnowledgeClaim;
    detectedAt: string;
    reason: string;
}

export interface RepositoryKnowledge {
    id: string;
    schemaVersion: string;

    type: RepositoryKnowledgeType;
    subject: KnowledgeSubject;
    claim: KnowledgeClaim;

    confidence: KnowledgeConfidence;
    provenance: KnowledgeProvenance;
    freshness: KnowledgeFreshness;

    lifecycleState: KnowledgeLifecycleState;
    validationState: KnowledgeValidationState;

    supportingEvidence: KnowledgeEvidenceRef[];
    contradictions: KnowledgeContradiction[];

    ownership: {
        owner: 'repoguide' | 'developer' | 'runtime' | 'imported';
        createdBy: string;
        lastUpdatedBy: string;
    };

    timestamps: {
        createdAt: string;
        updatedAt: string;
        validatedAt?: string;
        promotedAt?: string;
        staleAt?: string;
        retiredAt?: string;
        archivedAt?: string;
    };

    version: {
        knowledgeVersion: number;
        producerVersion: string;
        migrationVersion: string;
    };

    tags: string[];
    diagnostics: string[];
}

export interface ObserveKnowledgeRequest {
    type: RepositoryKnowledgeType;
    subject: KnowledgeSubject;
    claim: KnowledgeClaim;
    confidence: KnowledgeConfidence;
    provenance: KnowledgeProvenance;
    supportingEvidence?: KnowledgeEvidenceRef[];
    owner?: RepositoryKnowledge['ownership']['owner'];
    createdBy: string;
    tags?: string[];
    producerVersion?: string;
}

export interface ObserveKnowledgeResponse {
    id: string;
    lifecycleState: KnowledgeLifecycleState;
    /** True when a brand-new record was inserted (no existing candidate/validated/active/stale match). */
    created: boolean;
    /** True when this observation conflicted with an existing `active` record and forced it to `contradicted`. */
    contradicted: boolean;
    diagnostics: string[];
}

export interface ValidateKnowledgeRequest {
    id: string;
}
export interface ValidateKnowledgeResponse {
    id: string;
    ok: boolean;
    lifecycleState: KnowledgeLifecycleState;
    reason?: string;
}

export interface PromoteKnowledgeRequest {
    id: string;
}
export interface PromoteKnowledgeResponse {
    id: string;
    ok: boolean;
    lifecycleState: KnowledgeLifecycleState;
    reason?: string;
}

export interface RepositoryKnowledgeRetrieveRequest {
    id?: string;
    type?: RepositoryKnowledgeType;
    subjectId?: string;
}
export interface RepositoryKnowledgeRetrieveResponse {
    items: RepositoryKnowledge[];
}

export interface RepositoryKnowledgeQueryRequest {
    knowledgeTypes: RepositoryKnowledgeType[];
    subjects?: string[];
    query?: string;
    requireValidated: boolean;
    includeStale: boolean;
    maxItems: number;
}
export interface RepositoryKnowledgeQueryResponse {
    items: RepositoryKnowledge[];
    diagnostics: string[];
}

export interface ExplainKnowledgeRequest {
    id: string;
}
export interface ExplainKnowledgeResponse {
    id: string;
    found: boolean;
    provenance?: KnowledgeProvenance;
    confidence?: KnowledgeConfidence;
    contradictions?: KnowledgeContradiction[];
    supportingEvidence?: KnowledgeEvidenceRef[];
}

export interface InvalidateKnowledgeRequest {
    id: string;
    reason: 'source_changed' | 'conflicting_evidence';
    conflictingClaim?: KnowledgeClaim;
    detail?: string;
}
export interface InvalidateKnowledgeResponse {
    id: string;
    ok: boolean;
    lifecycleState: KnowledgeLifecycleState;
    reason?: string;
}

export interface RefreshKnowledgeRequest {
    id: string;
    sourceStillValid: boolean;
}
export interface RefreshKnowledgeResponse {
    id: string;
    ok: boolean;
    lifecycleState: KnowledgeLifecycleState;
    reason?: string;
}

export interface RetireKnowledgeRequest {
    id: string;
    retentionWindowDays?: number;
}
export interface RetireKnowledgeResponse {
    id: string;
    ok: boolean;
    lifecycleState: KnowledgeLifecycleState;
    reason?: string;
}

export interface ForgetKnowledgeRequest {
    id: string;
}
export interface ForgetKnowledgeResponse {
    id: string;
    deleted: boolean;
}
