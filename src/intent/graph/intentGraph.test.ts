import { expect, test, describe, beforeEach, afterEach } from '@jest/globals';
import { IntentStore } from '../extraction/intentStore';
import { IntentNormalizer } from '../extraction/intentNormalizer';
import { IntentExtractionEngine } from '../extraction/intentExtractionEngine';
import { IntentGraphStore } from './intentGraphStore';
import { IntentGraphBuilder } from './intentGraphBuilder';
import { IntentGraphQueryEngine } from './intentGraphQueryEngine';
import { IntentQueryEngine } from '../extraction/intentQueryEngine';
import { CommitStore } from '../commit/commitStore';
import { PullRequestStore } from '../pr/pullRequestStore';
import { ADRQueryEngine } from '../adr/adrQueryEngine';
import { ADRStore } from '../adr/adrStore';

describe('Intent Graph Engine', () => {
    let intentStore: IntentStore;
    let normalizer: IntentNormalizer;
    let commitStore: CommitStore;
    let prStore: PullRequestStore;
    let adrStore: ADRStore;
    let adrQueryEngine: ADRQueryEngine;
    
    let graphStore: IntentGraphStore;
    let graphBuilder: IntentGraphBuilder;
    
    let extractionEngine: IntentExtractionEngine;
    let queryEngine: IntentQueryEngine;
    let graphQueryEngine: IntentGraphQueryEngine;

    beforeEach(() => {
        intentStore = new IntentStore(':memory:');
        normalizer = new IntentNormalizer();
        commitStore = new CommitStore(':memory:');
        prStore = new PullRequestStore(':memory:');
        adrStore = new ADRStore(':memory:');
        adrQueryEngine = new ADRQueryEngine(adrStore);

        graphStore = new IntentGraphStore(intentStore.getDatabase());
        graphBuilder = new IntentGraphBuilder(graphStore);

        extractionEngine = new IntentExtractionEngine(
            intentStore,
            normalizer,
            commitStore,
            prStore,
            adrQueryEngine,
            graphBuilder
        );

        queryEngine = new IntentQueryEngine(intentStore);
        graphQueryEngine = new IntentGraphQueryEngine(graphStore, queryEngine);
    });

    afterEach(() => {
        intentStore.close();
        commitStore.close();
        prStore.close();
        adrStore.close();
    });

    test('Graph builds edges correctly with noise floor (weight >= 2)', async () => {
        // We will simulate text that hits multiple intents in the same source.
        // Let's use:
        // "jwt" -> Authentication (SECURITY)
        // "rbac" -> Authorization (SECURITY)
        // "gdpr" -> PCI Compliance (SECURITY) -- wait, gdpr maps to PCI Compliance in intentRules.ts

        const date = new Date();

        // Source 1: PR. Has JWT and RBAC. Co-occurrence weight = 1
        await prStore.save({
            id: 'pr-1', number: 1,
            title: 'Add login',
            body: 'Using jwt and rbac.',
            state: 'MERGED', author: 'Test',
            createdAt: date, updatedAt: date, repositoryId: 'r1',
            commits: [], files: [], comments: [], reviews: []
        });

        // If we extract now, weight = 1, which is < 2, so NO edges should exist!
        await extractionEngine.extractIncremental(10);
        
        const edges1 = graphStore.getAllEdges();
        expect(edges1.length).toBe(0); // Because weight >= 2 threshold

        // Source 2: Commit. Has JWT and RBAC again. Co-occurrence weight = 2
        await commitStore.save({
            sha: 'commit-1', authorName: 'Test', authorEmail: 'test@test.com',
            message: 'Fix jwt and rbac logic',
            timestamp: new Date(date.getTime() + 1000), parentShas: [], repositoryId: 'r1', files: []
        });

        await extractionEngine.extractIncremental(10);
        
        const edges2 = graphStore.getAllEdges();
        expect(edges2.length).toBe(1); // Now weight = 2!

        const edge = edges2[0];
        expect(edge.relationshipType).toBe('RELATED_TO');
        expect(edge.weight).toBe(2);
        
        // Confidence = min(1.0, 2/10) = 0.2
        expect(edge.confidence).toBe(0.2);

        // Breakdown counts
        expect(edge.adrEvidenceCount).toBe(0);
        expect(edge.prEvidenceCount).toBe(1);
        expect(edge.commitEvidenceCount).toBe(1);

        // Undirected normalization min/max check
        expect(edge.sourceIntentId < edge.targetIntentId).toBe(true);
    });

    test('Central intents and metrics calculation', async () => {
        const date = new Date();
        
        // To build a central node, we need an intent that co-occurs with many others, >=2 times.
        // "jwt" (Auth) co-occurs with "rbac" (Authz) 2 times.
        // "jwt" (Auth) co-occurs with "redis" (Caching) 2 times.
        // -> Auth is the central node.

        await prStore.save({
            id: 'pr-1', number: 1, title: 'Auth and Authz', body: 'jwt rbac',
            state: 'MERGED', author: 'T', createdAt: date, updatedAt: date, repositoryId: 'r1', commits: [], files: [], comments: [], reviews: []
        });
        await prStore.save({
            id: 'pr-2', number: 2, title: 'Auth and Authz', body: 'jwt rbac',
            state: 'MERGED', author: 'T', createdAt: date, updatedAt: date, repositoryId: 'r1', commits: [], files: [], comments: [], reviews: []
        });

        await prStore.save({
            id: 'pr-3', number: 3, title: 'Auth and Cache', body: 'jwt redis',
            state: 'MERGED', author: 'T', createdAt: date, updatedAt: date, repositoryId: 'r1', commits: [], files: [], comments: [], reviews: []
        });
        await prStore.save({
            id: 'pr-4', number: 4, title: 'Auth and Cache', body: 'jwt redis',
            state: 'MERGED', author: 'T', createdAt: date, updatedAt: date, repositoryId: 'r1', commits: [], files: [], comments: [], reviews: []
        });

        await extractionEngine.extractIncremental(10);

        const metrics = graphQueryEngine.getMetrics();
        expect(metrics.nodeCount).toBe(3); // Auth, Authz, Caching
        expect(metrics.edgeCount).toBe(2); // Auth<->Authz, Auth<->Caching

        const centralIntents = metrics.mostCentralIntents;
        expect(centralIntents.length).toBeGreaterThan(0);
        
        // Find the 'Authentication' intent ID
        const authIntent = queryEngine.searchTopic('Authentication')[0];
        expect(centralIntents[0]).toBe(authIntent.id); // It should be the most central
    });
});
