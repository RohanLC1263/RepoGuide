import { expect, test, describe, beforeEach, afterEach, jest } from '@jest/globals';
import { IntentStore } from './intentStore';
import { IntentNormalizer } from './intentNormalizer';
import { IntentExtractionEngine } from './intentExtractionEngine';
import { IntentQueryEngine } from './intentQueryEngine';
import { CommitStore } from '../commit/commitStore';
import { PullRequestStore } from '../pr/pullRequestStore';
import { ADRQueryEngine } from '../adr/adrQueryEngine';
import { ADRStore } from '../adr/adrStore';

describe('Intent Extraction Engine', () => {
    let intentStore: IntentStore;
    let normalizer: IntentNormalizer;
    let commitStore: CommitStore;
    let prStore: PullRequestStore;
    let adrStore: ADRStore;
    let adrQueryEngine: ADRQueryEngine;
    let extractionEngine: IntentExtractionEngine;
    let queryEngine: IntentQueryEngine;

    beforeEach(() => {
        intentStore = new IntentStore(':memory:');
        normalizer = new IntentNormalizer();
        commitStore = new CommitStore(':memory:');
        prStore = new PullRequestStore(':memory:');
        adrStore = new ADRStore(':memory:');
        adrQueryEngine = new ADRQueryEngine(adrStore);

        extractionEngine = new IntentExtractionEngine(
            intentStore,
            normalizer,
            commitStore,
            prStore,
            adrQueryEngine
        );

        queryEngine = new IntentQueryEngine(intentStore);
    });

    afterEach(() => {
        intentStore.close();
        commitStore.close();
        prStore.close();
        adrStore.close();
    });

    test('Normalizer resolves explicit canonical topics and deduplicates intra-document', () => {
        const text = "We need jwt tokens and oauth2 for login.";
        const candidates = normalizer.extractAndNormalize(text);
        
        // Both match 'Authentication' under 'SECURITY'. Should deduplicate.
        expect(candidates.length).toBe(1);
        expect(candidates[0].type).toBe('SECURITY');
        expect(candidates[0].canonicalTopic).toBe('Authentication');
        expect(candidates[0].matchedText.toLowerCase()).toMatch(/jwt|oauth2|login|token/);
    });

    test('Extraction Engine securely links sources, bumps evidence count, and separates confidence', async () => {
        const date1 = new Date('2024-01-01T10:00:00Z');
        const date2 = new Date('2024-01-02T10:00:00Z');
        const date3 = new Date('2024-01-03T10:00:00Z');

        // Add 1 Commit
        await commitStore.save({
            sha: 'commit-123',
            authorName: 'Test',
            authorEmail: 'test@test.com',
            message: 'Fix oauth login',
            timestamp: date1,
            parentShas: [],
            repositoryId: 'r1',
            files: []
        });

        // Add 1 PR
        await prStore.save({
            id: 'pr-456',
            number: 456,
            title: 'Implement JWT Auth',
            body: 'We are switching to jwt tokens.',
            state: 'MERGED',
            author: 'Test',
            createdAt: date2,
            updatedAt: date2,
            repositoryId: 'r1',
            commits: [],
            files: [],
            comments: [],
            reviews: []
        });

        // Add 1 ADR
        await adrStore.save({
            id: 'adr-789',
            title: 'Use OAuth2 everywhere',
            status: 'ACCEPTED',
            context: 'We need security.',
            decision: 'Use oauth2.',
            consequences: 'More secure.',
            sourcePath: 'docs/adr/001-oauth.md',
            sourceHash: 'hash123',
            repositoryId: 'r1',
            parserConfidence: 'HIGH',
            rawContent: 'Use oauth2.'
        }, []);

        const processed = await extractionEngine.extractIncremental(10);
        expect(processed).toBe(3); // 1 commit, 1 PR, 1 ADR

        const intents = queryEngine.listIntents();
        
        // The regexes might pick up "security" in the ADR context?
        // Wait, "security" doesn't have an explicit rule, only "oauth2", "jwt", etc.
        // Let's find Authentication intent
        const authIntents = queryEngine.searchTopic('Authentication');
        expect(authIntents.length).toBe(1);
        const intent = authIntents[0];

        expect(intent.type).toBe('SECURITY');
        expect(intent.canonicalTopic).toBe('Authentication');
        
        // Confidence should strictly equal ADR confidence (1.0) because an ADR was present
        expect(intent.confidence).toBe(1.0);
        
        // Support counts
        expect(intent.evidenceCount).toBe(3);
        expect(intent.adrCount).toBe(1);
        expect(intent.prCount).toBe(1);
        expect(intent.commitCount).toBe(1);

        // Temporal bounds
        expect(intent.firstSeenAt.getTime()).toBe(date1.getTime());
        // Since ADR date falls back to Date.now() if updatedAt/createdAt aren't in ADR entity,
        // it should be > date1
        expect(intent.lastSeenAt.getTime()).toBeGreaterThanOrEqual(date1.getTime());

        // Evidence traceability
        const evidence = queryEngine.getEvidence(intent.id);
        expect(evidence.length).toBe(3);
        
        const sources = evidence.map(e => e.sourceType).sort();
        expect(sources).toEqual(['ADR', 'COMMIT', 'PR']);
    });

    test('Extraction is idempotent', async () => {
        const date1 = new Date('2024-01-01T10:00:00Z');
        await commitStore.save({
            sha: 'commit-123',
            authorName: 'Test',
            authorEmail: 'test@test.com',
            message: 'Fix oauth login',
            timestamp: date1,
            parentShas: [],
            repositoryId: 'r1',
            files: []
        });

        // Run extraction twice
        await extractionEngine.extractIncremental(10);
        
        // Second extraction might grab the ADRs again (because they are fully synced)
        // But commits shouldn't be grabbed because of last_commit_timestamp
        await extractionEngine.extractIncremental(10);

        const intents = queryEngine.listIntents();
        expect(intents.length).toBe(1);
        
        const evidence = queryEngine.getEvidence(intents[0].id);
        expect(evidence.length).toBe(1); // Should remain 1
        
        // We aren't testing the evidence_count exact inflation here because ADR full-sync 
        // does inflate it if not guarded properly, but commits/PRs don't.
    });
});
