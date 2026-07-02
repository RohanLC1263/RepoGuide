import { DatabaseSync } from 'node:sqlite';
import { describe, test, expect, beforeEach } from '@jest/globals';
import { CommitStore } from '../intent/commit/commitStore';
import { ADRCodeLinkStore } from '../intent/linking/adrCodeLinkStore';
import { IntentStore } from '../intent/extraction/intentStore';
import { AuthorExpertiseStore } from './authorExpertiseStore';
import { AuthorExpertiseBuilder } from './authorExpertiseBuilder';
import { AuthorExpertiseQueryEngine } from './authorExpertiseQueryEngine';

describe('Author Expertise Graph', () => {
    let db: DatabaseSync;
    let commitStore: CommitStore;
    let adrStore: ADRCodeLinkStore;
    let intentStore: IntentStore;
    let store: AuthorExpertiseStore;
    let builder: AuthorExpertiseBuilder;
    let query: AuthorExpertiseQueryEngine;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        commitStore = new CommitStore(db);
        adrStore = new ADRCodeLinkStore(db);
        intentStore = new IntentStore(db);
        store = new AuthorExpertiseStore(db);
        builder = new AuthorExpertiseBuilder(db, store);
        query = new AuthorExpertiseQueryEngine(store);
    });

    test('Computes ADR expertise and protects against inflation via capping', async () => {
        // Setup ADR code links via direct db insert for tests
        db.exec(`
            INSERT INTO adr_code_links (id, adr_id, node_id) VALUES 
            ('1', 'ADR-12', 'auth/AuthenticationService.ts'),
            ('2', 'ADR-12', 'auth/OAuthProvider.ts'),
            ('3', 'ADR-12', 'auth/TokenValidator.ts'),
            ('4', 'ADR-12', 'auth/SessionStore.ts');
        `);

        const now = new Date();
        const commits = [];

        // Alice edits AuthenticationService 500 times
        for (let i = 0; i < 500; i++) {
            commits.push({
                sha: `alice-${i}`,
                authorName: 'Alice',
                authorEmail: 'alice@a.com',
                message: 'fix',
                timestamp: now,
                parentShas: ['parent'],
                repositoryId: 'r1',
                files: [
                    { sha: `alice-${i}`, path: 'auth/AuthenticationService.ts', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any }
                ]
            });
        }

        // Bob edits all four files 20 times each
        for (let i = 0; i < 20; i++) {
            commits.push({
                sha: `bob-${i}`,
                authorName: 'Bob',
                authorEmail: 'bob@b.com',
                message: 'feat',
                timestamp: now,
                parentShas: ['parent'],
                repositoryId: 'r1',
                files: [
                    { sha: `bob-${i}`, path: 'auth/AuthenticationService.ts', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any },
                    { sha: `bob-${i}`, path: 'auth/OAuthProvider.ts', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any },
                    { sha: `bob-${i}`, path: 'auth/TokenValidator.ts', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any },
                    { sha: `bob-${i}`, path: 'auth/SessionStore.ts', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any }
                ]
            });
        }

        await commitStore.saveBatch(commits);
        builder.build();

        // 1. Validate File Expertise
        const aliceFile = query.getExpertsForFile('auth/AuthenticationService.ts').find(e => e.authorEmail === 'alice@a.com');
        expect(aliceFile).toBeDefined();
        expect(aliceFile!.contributionCount).toBe(500);
        expect(aliceFile!.expertiseScore).toBeCloseTo(500); // recency multiplier 1.0

        const bobFile = query.getExpertsForFile('auth/OAuthProvider.ts').find(e => e.authorEmail === 'bob@b.com');
        expect(bobFile).toBeDefined();
        expect(bobFile!.contributionCount).toBe(20);

        // 2. Validate ADR Expertise (Capping Protection)
        const adrExperts = query.getExpertsForADR('ADR-12');
        expect(adrExperts.length).toBe(2);

        // Bob should rank above Alice because of the file cap
        expect(adrExperts[0].authorEmail).toBe('bob@b.com');
        expect(adrExperts[0].expertiseScore).toBe(40); // 4 files * cap(10) = 40
        expect(adrExperts[0].coveragePercentage).toBe(1.0); // 4/4 files

        expect(adrExperts[1].authorEmail).toBe('alice@a.com');
        expect(adrExperts[1].expertiseScore).toBe(10); // 1 file * cap(10) = 10
        expect(adrExperts[1].coveragePercentage).toBe(0.25); // 1/4 files
    });

    test('Ignores bots and merge commits', async () => {
        await commitStore.saveBatch([
            {
                sha: 'merge-1',
                authorName: 'Alice',
                authorEmail: 'alice@a.com',
                message: 'Merge pull request',
                timestamp: new Date(),
                parentShas: ['p1', 'p2'], // MERGE COMMIT
                repositoryId: 'r1',
                files: [{ sha: 'merge-1', path: 'A.ts', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any }]
            },
            {
                sha: 'bot-1',
                authorName: 'Dependabot',
                authorEmail: 'dependabot[bot]@users.noreply.github.com', // BOT
                message: 'bump deps',
                timestamp: new Date(),
                parentShas: ['p1'],
                repositoryId: 'r1',
                files: [{ sha: 'bot-1', path: 'A.ts', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any }]
            }
        ]);

        builder.build();
        const experts = query.getExpertsForFile('A.ts');
        expect(experts.length).toBe(0);
    });

    test('Computes directory expertise', async () => {
        await commitStore.saveBatch([
            {
                sha: 'c1',
                authorName: 'Charlie',
                authorEmail: 'c@c.com',
                message: 'msg',
                timestamp: new Date(),
                parentShas: ['p1'],
                repositoryId: 'r1',
                files: [
                    { sha: 'c1', path: 'src/components/Button.tsx', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any },
                    { sha: 'c1', path: 'src/components/Input.tsx', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any }
                ]
            }
        ]);

        builder.build();
        const dirExperts = query.getExpertsForDirectory('src/components');
        expect(dirExperts.length).toBe(1);
        expect(dirExperts[0].authorEmail).toBe('c@c.com');
        expect(dirExperts[0].contributionCount).toBe(2);
    });
});
