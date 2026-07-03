import { describe, test, expect, beforeEach } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { RepositoryBrainStore } from './repositoryBrainStore';
import { RepositoryBrain } from './repositoryBrain';
import { ObserveKnowledgeRequest } from './repositoryKnowledgeTypes';

function makeObserveRequest(overrides: Partial<ObserveKnowledgeRequest> = {}): ObserveKnowledgeRequest {
    return {
        type: 'decision_outcome',
        subject: { kind: 'decision', id: 'ADR-1' },
        claim: { text: 'ADR-1 is SUCCESSFUL', data: { outcomeType: 'SUCCESSFUL' } },
        confidence: { score: 80, breakdown: { evidenceVolume: 80 } },
        provenance: { sourceArtifacts: ['decision_outcomes:ADR-1'], producedBy: 'decisionOutcomeBuilder' },
        supportingEvidence: [{ sourceTable: 'outcome_evidence', sourceId: 'ev1' }],
        createdBy: 'test',
        ...overrides
    };
}

describe('RepositoryBrain', () => {
    let db: DatabaseSync;
    let store: RepositoryBrainStore;
    let brain: RepositoryBrain;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        store = new RepositoryBrainStore(db);
        brain = new RepositoryBrain(store);
    });

    test('observe() creates a new candidate record', async () => {
        const res = await brain.observe(makeObserveRequest());
        expect(res.created).toBe(true);
        expect(res.lifecycleState).toBe('candidate');

        const fetched = await brain.retrieve({ id: res.id });
        expect(fetched.items).toHaveLength(1);
        expect(fetched.items[0].validationState).toBe('unvalidated');
    });

    test('observe() updates an existing candidate in place rather than duplicating', async () => {
        const first = await brain.observe(makeObserveRequest());
        const second = await brain.observe(makeObserveRequest({ claim: { text: 'Updated claim', data: { outcomeType: 'STABLE' } } }));

        expect(second.id).toBe(first.id);
        expect(second.created).toBe(false);

        const all = store.query({});
        expect(all).toHaveLength(1);
        expect(all[0].claim.text).toBe('Updated claim');
    });

    test('validate() rejects a record with no supporting evidence', async () => {
        const observed = await brain.observe(makeObserveRequest({ supportingEvidence: [] }));
        const result = await brain.validate({ id: observed.id });
        expect(result.ok).toBe(false);
        expect(result.lifecycleState).toBe('candidate');
    });

    test('validate() rejects a record below the confidence threshold', async () => {
        const observed = await brain.observe(makeObserveRequest({ confidence: { score: 5, breakdown: {} } }));
        const result = await brain.validate({ id: observed.id });
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/below validation threshold/);
    });

    test('validate() then promote() moves candidate all the way to active (two-hop in one call)', async () => {
        const observed = await brain.observe(makeObserveRequest());
        const validated = await brain.validate({ id: observed.id });
        expect(validated.ok).toBe(true);
        expect(validated.lifecycleState).toBe('validated');

        const promoted = await brain.promote({ id: observed.id });
        expect(promoted.ok).toBe(true);
        expect(promoted.lifecycleState).toBe('active');

        const explained = await brain.explain({ id: observed.id });
        expect(explained.found).toBe(true);
    });

    test('promote() rejects a candidate that has not been validated (illegal transition)', async () => {
        const observed = await brain.observe(makeObserveRequest());
        const promoted = await brain.promote({ id: observed.id });
        expect(promoted.ok).toBe(false);
        expect(promoted.reason).toMatch(/Illegal lifecycle transition/);
    });

    test('promote() rejects a validated record below the promotion threshold', async () => {
        const observed = await brain.observe(makeObserveRequest({ confidence: { score: 35, breakdown: {} } }));
        await brain.validate({ id: observed.id });
        const promoted = await brain.promote({ id: observed.id });
        expect(promoted.ok).toBe(false);
        expect(promoted.reason).toMatch(/below promotion threshold/);
    });

    async function makeActiveRecord(overrides: Partial<ObserveKnowledgeRequest> = {}): Promise<string> {
        const observed = await brain.observe(makeObserveRequest(overrides));
        await brain.validate({ id: observed.id });
        await brain.promote({ id: observed.id });
        return observed.id;
    }

    test('observe() on an active record with independent provenance raises confidence without duplicating', async () => {
        const id = await makeActiveRecord();
        const before = await brain.retrieve({ id });

        const res = await brain.observe(makeObserveRequest({
            provenance: { sourceArtifacts: ['decision_outcomes:ADR-1:cycle2'], producedBy: 'decisionOutcomeBuilder' }
        }));

        expect(res.id).toBe(id);
        expect(res.contradicted).toBe(false);
        const after = await brain.retrieve({ id });
        expect(after.items[0].confidence.score).toBeGreaterThan(before.items[0].confidence.score);
        expect(store.query({}).filter(k => k.type === 'decision_outcome')).toHaveLength(1);
    });

    test('observe() with a materially different claim contradicts the active record and inserts a fresh candidate', async () => {
        const id = await makeActiveRecord();

        const res = await brain.observe(makeObserveRequest({
            claim: { text: 'ADR-1 is FAILED', data: { outcomeType: 'FAILED' } }
        }));

        expect(res.contradicted).toBe(true);
        expect(res.created).toBe(true);
        expect(res.id).not.toBe(id);

        const original = await brain.retrieve({ id });
        expect(original.items[0].lifecycleState).toBe('contradicted');
        expect(original.items[0].contradictions).toHaveLength(1);

        const fresh = await brain.retrieve({ id: res.id });
        expect(fresh.items[0].lifecycleState).toBe('candidate');
    });

    test('query() returns only active knowledge by default', async () => {
        await makeActiveRecord();
        const result = await brain.query({
            knowledgeTypes: ['decision_outcome'],
            requireValidated: true,
            includeStale: false,
            maxItems: 10
        });
        expect(result.items).toHaveLength(1);
        expect(result.items[0].lifecycleState).toBe('active');
    });

    test('invalidate() moves active -> stale with a soft confidence reduction', async () => {
        const id = await makeActiveRecord();
        const before = await brain.retrieve({ id });

        const result = await brain.invalidate({ id, reason: 'source_changed' });
        expect(result.ok).toBe(true);
        expect(result.lifecycleState).toBe('stale');

        const after = await brain.retrieve({ id });
        expect(after.items[0].confidence.score).toBeLessThan(before.items[0].confidence.score);
    });

    test('invalidate() moves active -> contradicted with a sharp confidence reduction and preserves both claims', async () => {
        const id = await makeActiveRecord();
        const result = await brain.invalidate({
            id,
            reason: 'conflicting_evidence',
            conflictingClaim: { text: 'Conflicting claim', data: {} }
        });
        expect(result.ok).toBe(true);
        expect(result.lifecycleState).toBe('contradicted');

        const after = await brain.retrieve({ id });
        expect(after.items[0].contradictions).toHaveLength(1);
    });

    test('refresh() moves stale -> active when the source is still valid', async () => {
        const id = await makeActiveRecord();
        await brain.invalidate({ id, reason: 'source_changed' });

        const refreshed = await brain.refresh({ id, sourceStillValid: true });
        expect(refreshed.ok).toBe(true);
        expect(refreshed.lifecycleState).toBe('active');
    });

    test('refresh() moves stale -> retired when the source is gone', async () => {
        const id = await makeActiveRecord();
        await brain.invalidate({ id, reason: 'source_changed' });

        const refreshed = await brain.refresh({ id, sourceStillValid: false });
        expect(refreshed.ok).toBe(true);
        expect(refreshed.lifecycleState).toBe('retired');
    });

    test('retire() rejects a candidate (no legal path from candidate to retired)', async () => {
        const observed = await brain.observe(makeObserveRequest());
        const result = await brain.retire({ id: observed.id });
        expect(result.ok).toBe(false);
    });

    test('retire() moves stale -> retired, then retired -> archived once the retention window has elapsed', async () => {
        const id = await makeActiveRecord();
        await brain.invalidate({ id, reason: 'source_changed' });

        const retired = await brain.retire({ id });
        expect(retired.ok).toBe(true);
        expect(retired.lifecycleState).toBe('retired');

        const tooSoon = await brain.retire({ id, retentionWindowDays: 999 });
        expect(tooSoon.ok).toBe(false);
        expect(tooSoon.reason).toMatch(/Retention window/);

        const archived = await brain.retire({ id, retentionWindowDays: 0 });
        expect(archived.ok).toBe(true);
        expect(archived.lifecycleState).toBe('archived');
    });

    test('forget() hard-deletes the record', async () => {
        const observed = await brain.observe(makeObserveRequest());
        const result = await brain.forget({ id: observed.id });
        expect(result.deleted).toBe(true);

        const fetched = await brain.retrieve({ id: observed.id });
        expect(fetched.items).toHaveLength(0);
    });

    test('active knowledge never becomes stale or contradicted silently: invalidate() from candidate is illegal', async () => {
        const observed = await brain.observe(makeObserveRequest());
        const result = await brain.invalidate({ id: observed.id, reason: 'source_changed' });
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/Illegal lifecycle transition/);
    });
});
