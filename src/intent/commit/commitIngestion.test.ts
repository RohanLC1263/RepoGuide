import { expect, test, describe, beforeEach, afterEach } from '@jest/globals';
import { CommitStore } from './commitStore';
import { CommitProvider } from './providers/commitProvider';
import { CommitIngestionEngine } from './commitIngestionEngine';
import { CommitQueryEngine } from './commitQueryEngine';
import { ProgramGraphStore } from '../../store/programGraphStore';
import { CommitEntity } from './commitTypes';

class MockGitCommitProvider implements CommitProvider {
    public checkPointExists = true;

    public async verifyCheckpointExists(sha: string): Promise<boolean> {
        return this.checkPointExists;
    }

    public async listCommits(sinceSha?: string): Promise<CommitEntity[]> {
        if (sinceSha === 'commit2') return []; // no new commits
        
        return [
            {
                sha: 'commit1',
                authorName: 'alice',
                authorEmail: 'alice@example.com',
                message: 'Add auth module',
                timestamp: new Date('2026-01-01T10:00:00Z'),
                parentShas: [],
                repositoryId: 'local',
                files: [
                    { sha: 'commit1', path: 'src/auth.ts', additions: 100, deletions: 0, changes: 100, changeType: 'A' }
                ]
            },
            {
                sha: 'commit2',
                authorName: 'bob',
                authorEmail: 'bob@example.com',
                message: 'Rename auth module',
                timestamp: new Date('2026-01-02T10:00:00Z'),
                parentShas: ['commit1'],
                repositoryId: 'local',
                files: [
                    { sha: 'commit2', path: 'src/authService.ts', oldPath: 'src/auth.ts', additions: 10, deletions: 5, changes: 15, changeType: 'R' }
                ]
            }
        ];
    }
}

describe('Commit Ingestion Engine & Query Bridge', () => {
    let commitStore: CommitStore;
    let graphStore: ProgramGraphStore;
    let provider: MockGitCommitProvider;
    let ingestionEngine: CommitIngestionEngine;
    let queryEngine: CommitQueryEngine;

    beforeEach(() => {
        commitStore = new CommitStore(':memory:');
        graphStore = new ProgramGraphStore();
        
        // Mock graph store node pointing to the NEW renamed file
        (graphStore as any).graph = { nodes: {}, edges: [] };
        (graphStore as any).symbolToNodes = new Map();
        (graphStore as any).isLoaded = () => true;
        (graphStore as any).graph.nodes['AuthNode1'] = { 
            id: 'AuthNode1', 
            symbol: 'AuthenticationService', 
            type: 'class', 
            filePath: 'src/authService.ts' 
        };
        (graphStore as any).symbolToNodes.set('authenticationservice', ['AuthNode1']);
        graphStore.getNode = (id: string) => (graphStore as any).graph.nodes[id];
        
        provider = new MockGitCommitProvider();
        ingestionEngine = new CommitIngestionEngine(commitStore, provider);
        queryEngine = new CommitQueryEngine(commitStore, graphStore);
    });

    afterEach(() => {
        commitStore.close();
    });

    test('CommitIngestionEngine incrementally syncs and populates stats', async () => {
        const stats = await ingestionEngine.syncIncremental();
        
        expect(stats.commitsProcessed).toBe(2);
        expect(stats.filesProcessed).toBe(2);
        expect(stats.newestCommit).toBe('commit2');
        expect(stats.oldestCommit).toBe('commit1');
        
        const lastSync = commitStore.getLastProcessedCommit();
        expect(lastSync).toEqual('commit2');
    });

    test('CommitStore accurately saves and tracks rename lineage', async () => {
        await ingestionEngine.syncIncremental();
        
        // Lookup by NEW path
        const commitsByNew = commitStore.getByFile('src/authService.ts');
        expect(commitsByNew.length).toBe(1);
        expect(commitsByNew[0].sha).toBe('commit2');

        // Lookup by OLD path (should return the commit that created it AND the commit that renamed it)
        const commitsByOld = commitStore.getByFile('src/auth.ts');
        expect(commitsByOld.length).toBe(2);
    });

    test('CommitIngestionEngine recovers from force-pushes via full resync', async () => {
        await ingestionEngine.syncIncremental();
        expect(commitStore.getLastProcessedCommit()).toBe('commit2');

        // Simulate force-push removing commit2 from history
        provider.checkPointExists = false;
        
        // Running sync again should detect missing checkpoint and truncate
        await ingestionEngine.syncIncremental();
        
        // Since the mock provider always returns the same 2 commits on full sync, they are just rewritten.
        const commits = commitStore.getRecentCommits(10);
        expect(commits.length).toBe(2);
    });

    test('CommitQueryEngine bridges AST symbols to historical commits spanning renames', async () => {
        await ingestionEngine.syncIncremental();
        
        // Lookup by symbol resolves to src/authService.ts
        const commits = queryEngine.getCommitsForNode('AuthenticationService');
        
        // Right now, querying the NEW path directly only yields the commits after the rename.
        // A full Evolution Engine will recursively walk `oldPath`. 
        // For V1, we just verify the bridge successfully fetched the history of the current file path.
        expect(commits.length).toBe(1);
        expect(commits[0].sha).toBe('commit2');
        expect(commits[0].files[0].oldPath).toBe('src/auth.ts');
        expect(commits[0].files[0].changeType).toBe('R');
    });
});
