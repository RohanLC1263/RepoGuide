import { randomUUID } from 'crypto';
import { RepositoryBrainStore } from './repositoryBrainStore';
import { assertTransition } from './repositoryKnowledgeLifecycle';
import {
    RepositoryKnowledge,
    RepositoryKnowledgeType,
    KnowledgeLifecycleState,
    ObserveKnowledgeRequest,
    ObserveKnowledgeResponse,
    ValidateKnowledgeRequest,
    ValidateKnowledgeResponse,
    PromoteKnowledgeRequest,
    PromoteKnowledgeResponse,
    RepositoryKnowledgeRetrieveRequest,
    RepositoryKnowledgeRetrieveResponse,
    RepositoryKnowledgeQueryRequest,
    RepositoryKnowledgeQueryResponse,
    ExplainKnowledgeRequest,
    ExplainKnowledgeResponse,
    InvalidateKnowledgeRequest,
    InvalidateKnowledgeResponse,
    RefreshKnowledgeRequest,
    RefreshKnowledgeResponse,
    RetireKnowledgeRequest,
    RetireKnowledgeResponse,
    ForgetKnowledgeRequest,
    ForgetKnowledgeResponse
} from './repositoryKnowledgeTypes';

const SCHEMA_VERSION = '1';
const MIGRATION_VERSION = '1';

/**
 * Minimum confidence bars for validate()/promote(). Chosen to roughly mirror the confidence
 * bands the 3 audited builders (causalReasoningBuilder, decisionOutcomeBuilder,
 * incidentIntelligenceBuilder) already compute on a 0-100 scale: their own STABLE/DEGRADING
 * cutoffs sit around 50-70, so validate() (a machine-only gate) uses a lower bar than
 * promote() (which commits knowledge to active use).
 */
const DEFAULT_VALIDATION_MIN_CONFIDENCE = 30;
const DEFAULT_PROMOTION_MIN_CONFIDENCE = 60;
const DEFAULT_RETENTION_WINDOW_DAYS = 30;

/**
 * RepositoryBrain: the frozen 10-method API (ARCHITECTURE_FREEZE.md Part 3) around the
 * `repository_knowledge` table. Enforces the 8-state lifecycle as real code, not documentation.
 */
export class RepositoryBrain {
    constructor(private readonly store: RepositoryBrainStore) {}

    public async observe(request: ObserveKnowledgeRequest): Promise<ObserveKnowledgeResponse> {
        const now = new Date().toISOString();
        const diagnostics: string[] = [];

        const protectedMatch = this.store.findBySubject(request.type, request.subject.id, ['active', 'stale']);
        if (protectedMatch) {
            const claimChanged = JSON.stringify(protectedMatch.claim.data) !== JSON.stringify(request.claim.data);
            if (claimChanged && protectedMatch.lifecycleState === 'active') {
                // Frozen lifecycle only defines active -> contradicted directly; a stale record
                // with a conflicting new observation is left alone (it's already known-stale)
                // and the new observation is inserted as a fresh candidate below.
                protectedMatch.contradictions.push({
                    conflictingClaim: request.claim,
                    detectedAt: now,
                    reason: 'New observation conflicts with active claim.'
                });
                protectedMatch.lifecycleState = 'contradicted';
                protectedMatch.validationState = 'contradicted';
                protectedMatch.confidence = {
                    score: Math.max(0, protectedMatch.confidence.score * 0.3),
                    breakdown: { ...protectedMatch.confidence.breakdown, contradictionPenalty: -70 }
                };
                protectedMatch.timestamps.updatedAt = now;
                this.store.update(protectedMatch);
                diagnostics.push(`Existing active record ${protectedMatch.id} contradicted by new observation.`);

                const fresh = this.insertCandidate(request, now);
                return { id: fresh.id, lifecycleState: fresh.lifecycleState, created: true, contradicted: true, diagnostics };
            }

            if (!claimChanged) {
                // Reinforcing observation. Confidence only rises with independent provenance
                // (no overlap with already-recorded source artifacts).
                const existingArtifacts = new Set(protectedMatch.provenance.sourceArtifacts);
                const hasIndependentProvenance = request.provenance.sourceArtifacts.some(a => !existingArtifacts.has(a));
                if (hasIndependentProvenance) {
                    protectedMatch.confidence = {
                        score: Math.min(100, Math.max(protectedMatch.confidence.score, request.confidence.score) + 5),
                        breakdown: { ...protectedMatch.confidence.breakdown, ...request.confidence.breakdown, independentReinforcement: 5 }
                    };
                    protectedMatch.provenance.sourceArtifacts = Array.from(new Set([...protectedMatch.provenance.sourceArtifacts, ...request.provenance.sourceArtifacts]));
                    diagnostics.push('Confidence reinforced by independent provenance.');
                } else {
                    diagnostics.push('Observation matched existing record but provenance was not independent; confidence unchanged.');
                }
                protectedMatch.timestamps.updatedAt = now;
                protectedMatch.ownership.lastUpdatedBy = request.createdBy;
                this.store.update(protectedMatch);
                return { id: protectedMatch.id, lifecycleState: protectedMatch.lifecycleState, created: false, contradicted: false, diagnostics };
            }
            // claimChanged && protectedMatch.lifecycleState === 'stale': fall through to insert a fresh candidate.
            diagnostics.push(`Existing stale record ${protectedMatch.id} left untouched; new observation inserted as candidate.`);
            const fresh = this.insertCandidate(request, now);
            return { id: fresh.id, lifecycleState: fresh.lifecycleState, created: true, contradicted: false, diagnostics };
        }

        const unprotectedMatch = this.store.findBySubject(request.type, request.subject.id, ['candidate', 'validated']);
        if (unprotectedMatch) {
            unprotectedMatch.claim = request.claim;
            unprotectedMatch.confidence = request.confidence;
            unprotectedMatch.provenance = request.provenance;
            unprotectedMatch.supportingEvidence = request.supportingEvidence ?? unprotectedMatch.supportingEvidence;
            unprotectedMatch.tags = request.tags ?? unprotectedMatch.tags;
            unprotectedMatch.timestamps.updatedAt = now;
            unprotectedMatch.ownership.lastUpdatedBy = request.createdBy;
            unprotectedMatch.version.knowledgeVersion += 1;
            this.store.update(unprotectedMatch);
            return { id: unprotectedMatch.id, lifecycleState: unprotectedMatch.lifecycleState, created: false, contradicted: false, diagnostics };
        }

        const inserted = this.insertCandidate(request, now);
        return { id: inserted.id, lifecycleState: inserted.lifecycleState, created: true, contradicted: false, diagnostics };
    }

    private insertCandidate(request: ObserveKnowledgeRequest, now: string): RepositoryKnowledge {
        const knowledge: RepositoryKnowledge = {
            id: randomUUID(),
            schemaVersion: SCHEMA_VERSION,
            type: request.type,
            subject: request.subject,
            claim: request.claim,
            confidence: request.confidence,
            provenance: request.provenance,
            freshness: { state: 'fresh', computedAt: now, basis: 'observed at creation' },
            lifecycleState: 'candidate',
            validationState: 'unvalidated',
            supportingEvidence: request.supportingEvidence ?? [],
            contradictions: [],
            ownership: {
                owner: request.owner ?? 'repoguide',
                createdBy: request.createdBy,
                lastUpdatedBy: request.createdBy
            },
            timestamps: { createdAt: now, updatedAt: now },
            version: { knowledgeVersion: 1, producerVersion: request.producerVersion ?? '1.0', migrationVersion: MIGRATION_VERSION },
            tags: request.tags ?? [],
            diagnostics: []
        };
        this.store.insert(knowledge);
        return knowledge;
    }

    public async validate(request: ValidateKnowledgeRequest): Promise<ValidateKnowledgeResponse> {
        const record = this.store.getById(request.id);
        if (!record) {
            return { id: request.id, ok: false, lifecycleState: 'candidate', reason: 'Record not found.' };
        }
        const transitionError = assertTransition(record.lifecycleState, 'validated');
        if (transitionError) {
            return { id: request.id, ok: false, lifecycleState: record.lifecycleState, reason: transitionError };
        }
        if (record.supportingEvidence.length === 0) {
            return { id: request.id, ok: false, lifecycleState: record.lifecycleState, reason: 'No supporting evidence recorded.' };
        }
        const bar = validationThreshold(record.type);
        if (record.confidence.score < bar) {
            return { id: request.id, ok: false, lifecycleState: record.lifecycleState, reason: `Confidence ${record.confidence.score} below validation threshold ${bar}.` };
        }

        record.lifecycleState = 'validated';
        record.validationState = 'machine_validated';
        const now = new Date().toISOString();
        record.timestamps.validatedAt = now;
        record.timestamps.updatedAt = now;
        this.store.update(record);
        return { id: request.id, ok: true, lifecycleState: record.lifecycleState };
    }

    public async promote(request: PromoteKnowledgeRequest): Promise<PromoteKnowledgeResponse> {
        const record = this.store.getById(request.id);
        if (!record) {
            return { id: request.id, ok: false, lifecycleState: 'candidate', reason: 'Record not found.' };
        }
        const transitionError = assertTransition(record.lifecycleState, 'promoted');
        if (transitionError) {
            return { id: request.id, ok: false, lifecycleState: record.lifecycleState, reason: transitionError };
        }
        const bar = promotionThreshold(record.type);
        if (record.confidence.score < bar) {
            return { id: request.id, ok: false, lifecycleState: record.lifecycleState, reason: `Confidence ${record.confidence.score} below promotion threshold ${bar}.` };
        }

        const now = new Date().toISOString();
        // The frozen diagram has validated -> promoted -> active as two hops, but the 10-method
        // API exposes no separate "activate" — promote() performs both in one call.
        record.timestamps.promotedAt = now;
        record.lifecycleState = 'active';
        record.timestamps.updatedAt = now;
        this.store.update(record);
        return { id: request.id, ok: true, lifecycleState: record.lifecycleState };
    }

    public async retrieve(request: RepositoryKnowledgeRetrieveRequest): Promise<RepositoryKnowledgeRetrieveResponse> {
        if (request.id) {
            const record = this.store.getById(request.id);
            return { items: record ? [record] : [] };
        }
        const items = this.store.query({
            types: request.type ? [request.type] : undefined,
            subjectIds: request.subjectId ? [request.subjectId] : undefined
        });
        return { items };
    }

    public async query(request: RepositoryKnowledgeQueryRequest): Promise<RepositoryKnowledgeQueryResponse> {
        const diagnostics: string[] = [];
        const lifecycleStates: KnowledgeLifecycleState[] = request.includeStale ? ['active', 'stale'] : ['active'];

        let items = this.store.query({
            types: request.knowledgeTypes.length > 0 ? request.knowledgeTypes : undefined,
            lifecycleStates,
            subjectIds: request.subjects && request.subjects.length > 0 ? request.subjects : undefined,
            limit: request.maxItems > 0 ? request.maxItems : 100
        });

        if (request.requireValidated) {
            items = items.filter(item => item.validationState !== 'unvalidated' && item.validationState !== 'invalid');
        }

        if (request.query && request.query.trim().length > 0) {
            const needle = request.query.toLowerCase();
            const keywordMatched = items.filter(item => item.claim.text.toLowerCase().includes(needle));
            // Text matching is a best-effort narrowing signal, not a hard filter: if nothing
            // matches the free-text query, fall back to the type/subject-filtered set rather
            // than silently returning empty.
            if (keywordMatched.length > 0) {
                items = keywordMatched;
            } else {
                diagnostics.push('Free-text query matched no claims; returning type/subject-filtered results.');
            }
        }

        if (items.length === 0) {
            diagnostics.push('No repository knowledge matched this query.');
        }

        return { items: items.slice(0, request.maxItems > 0 ? request.maxItems : items.length), diagnostics };
    }

    public async explain(request: ExplainKnowledgeRequest): Promise<ExplainKnowledgeResponse> {
        const record = this.store.getById(request.id);
        if (!record) {
            return { id: request.id, found: false };
        }
        return {
            id: request.id,
            found: true,
            provenance: record.provenance,
            confidence: record.confidence,
            contradictions: record.contradictions,
            supportingEvidence: record.supportingEvidence
        };
    }

    public async invalidate(request: InvalidateKnowledgeRequest): Promise<InvalidateKnowledgeResponse> {
        const record = this.store.getById(request.id);
        if (!record) {
            return { id: request.id, ok: false, lifecycleState: 'candidate', reason: 'Record not found.' };
        }
        const target: KnowledgeLifecycleState = request.reason === 'conflicting_evidence' ? 'contradicted' : 'stale';
        const transitionError = assertTransition(record.lifecycleState, target);
        if (transitionError) {
            return { id: request.id, ok: false, lifecycleState: record.lifecycleState, reason: transitionError };
        }

        const now = new Date().toISOString();
        if (target === 'contradicted' && request.conflictingClaim) {
            record.contradictions.push({
                conflictingClaim: request.conflictingClaim,
                detectedAt: now,
                reason: request.detail ?? 'Conflicting evidence observed.'
            });
            record.confidence = { score: Math.max(0, record.confidence.score * 0.3), breakdown: { ...record.confidence.breakdown, contradictionPenalty: -70 } };
            record.validationState = 'contradicted';
        } else {
            record.confidence = { score: Math.max(0, record.confidence.score * 0.7), breakdown: { ...record.confidence.breakdown, stalenessPenalty: -30 } };
            record.timestamps.staleAt = now;
            record.freshness = { state: 'stale', computedAt: now, basis: request.detail ?? 'Source dependency changed.' };
        }
        record.lifecycleState = target;
        record.timestamps.updatedAt = now;
        this.store.update(record);
        return { id: request.id, ok: true, lifecycleState: record.lifecycleState };
    }

    public async refresh(request: RefreshKnowledgeRequest): Promise<RefreshKnowledgeResponse> {
        const record = this.store.getById(request.id);
        if (!record) {
            return { id: request.id, ok: false, lifecycleState: 'candidate', reason: 'Record not found.' };
        }
        const now = new Date().toISOString();
        if (request.sourceStillValid) {
            const transitionError = assertTransition(record.lifecycleState, 'active');
            if (transitionError) {
                return { id: request.id, ok: false, lifecycleState: record.lifecycleState, reason: transitionError };
            }
            record.lifecycleState = 'active';
            record.freshness = { state: 'fresh', computedAt: now, basis: 'Refreshed evidence validated the claim.' };
            record.timestamps.updatedAt = now;
            this.store.update(record);
            return { id: request.id, ok: true, lifecycleState: record.lifecycleState };
        }

        const transitionError = assertTransition(record.lifecycleState, 'retired');
        if (transitionError) {
            return { id: request.id, ok: false, lifecycleState: record.lifecycleState, reason: transitionError };
        }
        record.lifecycleState = 'retired';
        record.timestamps.retiredAt = now;
        record.timestamps.updatedAt = now;
        this.store.update(record);
        return { id: request.id, ok: true, lifecycleState: record.lifecycleState };
    }

    public async retire(request: RetireKnowledgeRequest): Promise<RetireKnowledgeResponse> {
        const record = this.store.getById(request.id);
        if (!record) {
            return { id: request.id, ok: false, lifecycleState: 'candidate', reason: 'Record not found.' };
        }
        const now = new Date().toISOString();

        if (record.lifecycleState === 'retired') {
            const retentionDays = request.retentionWindowDays ?? DEFAULT_RETENTION_WINDOW_DAYS;
            const retiredAt = record.timestamps.retiredAt ? new Date(record.timestamps.retiredAt).getTime() : 0;
            const elapsedDays = (Date.now() - retiredAt) / (1000 * 60 * 60 * 24);
            if (elapsedDays < retentionDays) {
                return { id: request.id, ok: false, lifecycleState: record.lifecycleState, reason: `Retention window (${retentionDays}d) not yet elapsed (${elapsedDays.toFixed(1)}d).` };
            }
            const transitionError = assertTransition(record.lifecycleState, 'archived');
            if (transitionError) {
                return { id: request.id, ok: false, lifecycleState: record.lifecycleState, reason: transitionError };
            }
            record.lifecycleState = 'archived';
            record.timestamps.archivedAt = now;
            record.timestamps.updatedAt = now;
            this.store.update(record);
            return { id: request.id, ok: true, lifecycleState: record.lifecycleState };
        }

        const transitionError = assertTransition(record.lifecycleState, 'retired');
        if (transitionError) {
            return { id: request.id, ok: false, lifecycleState: record.lifecycleState, reason: transitionError };
        }
        record.lifecycleState = 'retired';
        record.timestamps.retiredAt = now;
        record.timestamps.updatedAt = now;
        this.store.update(record);
        return { id: request.id, ok: true, lifecycleState: record.lifecycleState };
    }

    public async forget(request: ForgetKnowledgeRequest): Promise<ForgetKnowledgeResponse> {
        const deleted = this.store.deleteById(request.id);
        return { id: request.id, deleted };
    }
}

function validationThreshold(_type: RepositoryKnowledgeType): number {
    return DEFAULT_VALIDATION_MIN_CONFIDENCE;
}

function promotionThreshold(_type: RepositoryKnowledgeType): number {
    return DEFAULT_PROMOTION_MIN_CONFIDENCE;
}
