import { expect, test, describe, beforeEach, afterEach } from '@jest/globals';
import { PullRequestStore } from './pullRequestStore';
import { PullRequestProvider } from './providers/pullRequestProvider';
import { PRIngestionEngine } from './prIngestionEngine';
import { PRQueryEngine } from './prQueryEngine';
import { ProgramGraphStore } from '../../store/programGraphStore';
import { PullRequestEntity, PullRequestComment, PullRequestReview, PullRequestFile, PullRequestCommit } from './prTypes';

class MockPullRequestProvider implements PullRequestProvider {
    public async listPullRequests(since?: Date): Promise<PullRequestEntity[]> {
        return [{
            id: 'pr_1',
            number: 1,
            title: 'Initial Commit',
            body: 'Adding auth service',
            state: 'MERGED',
            author: 'alice',
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-02T00:00:00Z'),
            mergedAt: new Date('2026-01-02T00:00:00Z'),
            repositoryId: 'repo_1',
            commits: [],
            files: [],
            comments: [],
            reviews: []
        }];
    }
    public async getPullRequest(id: string): Promise<PullRequestEntity> {
        throw new Error('Not used in incremental sync flow');
    }
    public async getComments(id: string): Promise<PullRequestComment[]> {
        return [{
            id: 'c_1',
            author: 'bob',
            body: 'Looks good',
            createdAt: new Date('2026-01-01T12:00:00Z')
        }];
    }
    public async getReviews(id: string): Promise<PullRequestReview[]> {
        return [{
            id: 'r_1',
            reviewer: 'bob',
            state: 'APPROVED',
            submittedAt: new Date('2026-01-02T00:00:00Z')
        }];
    }
    public async getChangedFiles(id: string): Promise<PullRequestFile[]> {
        return [{
            path: 'src/auth/authService.ts',
            additions: 100,
            deletions: 0,
            changes: 100
        }];
    }
    public async getCommits(id: string): Promise<PullRequestCommit[]> {
        return [{
            sha: 'abcdef123',
            message: 'Implement auth service',
            author: 'alice',
            timestamp: new Date('2026-01-01T10:00:00Z')
        }];
    }
}

describe('PR Ingestion Engine & Query Bridge', () => {
    let prStore: PullRequestStore;
    let graphStore: ProgramGraphStore;
    let provider: PullRequestProvider;
    let ingestionEngine: PRIngestionEngine;
    let queryEngine: PRQueryEngine;

    beforeEach(() => {
        prStore = new PullRequestStore(':memory:');
        graphStore = new ProgramGraphStore();
        
        // Mock graph store node
        (graphStore as any).graph = { nodes: {}, edges: [] };
        (graphStore as any).symbolToNodes = new Map();
        (graphStore as any).isLoaded = () => true;
        (graphStore as any).graph.nodes['AuthNode1'] = { 
            id: 'AuthNode1', 
            symbol: 'AuthenticationService', 
            type: 'class', 
            filePath: 'src/auth/authService.ts' 
        };
        (graphStore as any).symbolToNodes.set('authenticationservice', ['AuthNode1']);
        graphStore.getNode = (id: string) => (graphStore as any).graph.nodes[id];
        
        provider = new MockPullRequestProvider();
        ingestionEngine = new PRIngestionEngine(prStore, provider);
        queryEngine = new PRQueryEngine(prStore, graphStore);
    });

    afterEach(() => {
        prStore.close();
    });

    test('PRIngestionEngine incrementally syncs and populates stats', async () => {
        const stats = await ingestionEngine.syncIncremental();
        
        expect(stats.prsProcessed).toBe(1);
        expect(stats.commentsProcessed).toBe(1);
        expect(stats.reviewsProcessed).toBe(1);
        expect(stats.commitsProcessed).toBe(1);
        expect(stats.startedAt).toBeDefined();
        expect(stats.completedAt).toBeDefined();
        
        const lastSync = prStore.getLastSyncTimestamp();
        expect(lastSync).toEqual(stats.startedAt); // Timestamp updated
    });

    test('PullRequestStore accurately saves and retrieves nested entities', async () => {
        await ingestionEngine.syncIncremental();
        
        const pr = prStore.getById('pr_1');
        expect(pr).toBeDefined();
        expect(pr!.title).toBe('Initial Commit');
        expect(pr!.comments.length).toBe(1);
        expect(pr!.reviews.length).toBe(1);
        expect(pr!.files.length).toBe(1);
        expect(pr!.commits.length).toBe(1);
        
        expect(pr!.commits[0].sha).toBe('abcdef123');
        expect(pr!.files[0].path).toBe('src/auth/authService.ts');
    });

    test('PRQueryEngine bridges AST symbols to historical PRs', async () => {
        await ingestionEngine.syncIncremental();
        
        // Lookup by symbol
        const prs = queryEngine.getPRsForNode('AuthenticationService');
        
        expect(prs.length).toBe(1);
        expect(prs[0].id).toBe('pr_1');
        expect(prs[0].files[0].path).toBe('src/auth/authService.ts');
    });
});
