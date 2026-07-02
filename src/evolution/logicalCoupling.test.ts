import { DatabaseSync } from 'node:sqlite';
import { describe, test, expect, beforeEach } from '@jest/globals';
import { CommitStore } from '../intent/commit/commitStore';
import { LogicalCouplingStore } from './logicalCouplingStore';
import { LogicalCouplingBuilder } from './logicalCouplingBuilder';
import { LogicalCouplingQueryEngine } from './logicalCouplingQueryEngine';

describe('Logical Coupling Engine', () => {
    let db: DatabaseSync;
    let commitStore: CommitStore;
    let store: LogicalCouplingStore;
    let builder: LogicalCouplingBuilder;
    let query: LogicalCouplingQueryEngine;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        commitStore = new CommitStore(db);
        store = new LogicalCouplingStore(db);
        builder = new LogicalCouplingBuilder(db, store);
        query = new LogicalCouplingQueryEngine(store);
    });

    test('Computes logical coupling correctly for small commits, ignoring noise', async () => {
        await commitStore.saveBatch([
            {
                sha: 'commit1',
                authorName: 'A',
                authorEmail: 'a@a.com',
                message: 'msg',
                timestamp: new Date('2023-01-01'),
                parentShas: [],
                repositoryId: 'r1',
                files: [
                    { sha: 'commit1', path: 'A.ts', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any },
                    { sha: 'commit1', path: 'B.ts', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any }
                ]
            },
            {
                sha: 'commit2',
                authorName: 'A',
                authorEmail: 'a@a.com',
                message: 'msg',
                timestamp: new Date('2023-01-02'),
                parentShas: [],
                repositoryId: 'r1',
                files: [
                    { sha: 'commit2', path: 'A.ts', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any },
                    { sha: 'commit2', path: 'B.ts', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any },
                    { sha: 'commit2', path: 'C.ts', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any }
                ]
            },
            {
                sha: 'commit3',
                authorName: 'A',
                authorEmail: 'a@a.com',
                message: 'msg',
                timestamp: new Date('2023-01-03'),
                parentShas: [],
                repositoryId: 'r1',
                files: [
                    { sha: 'commit3', path: 'A.ts', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any },
                    { sha: 'commit3', path: 'package-lock.json', additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any }
                ]
            }
        ]);

        builder.build();

        // Check file stats
        const statsA = store.getFileStats('A.ts');
        expect(statsA).toBeDefined();
        expect(statsA!.changeCount).toBe(3); // commit1, commit2, commit3

        const statsB = store.getFileStats('B.ts');
        expect(statsB!.changeCount).toBe(2);

        // package-lock.json should be ignored
        const statsLock = store.getFileStats('package-lock.json');
        expect(statsLock).toBeNull();

        // Coupling between A.ts and B.ts
        const couplingAB = query.getCoupling('A.ts', 'B.ts');
        expect(couplingAB).toBeDefined();
        expect(couplingAB!.coChangeCount).toBe(2); // commit1, commit2

        // Jaccard: union = A(3) + B(2) - co(2) = 3
        // confidence = 2 / 3
        expect(couplingAB!.confidence).toBeCloseTo(0.666, 2);

        // A.ts and C.ts only changed once together, should be ignored (threshold = 2)
        const couplingAC = query.getCoupling('A.ts', 'C.ts');
        expect(couplingAC).toBeNull();

        // Evidence check
        const evidence = query.getEvidence(couplingAB!.id);
        expect(evidence.length).toBe(2);
        expect(evidence).toContain('commit1');
        expect(evidence).toContain('commit2');
    });

    test('Ignores large commits completely', async () => {
        const largeFiles = [];
        for (let i = 0; i < 51; i++) {
            largeFiles.push({ sha: 'commitL', path: `file${i}.ts`, additions: 1, deletions: 0, changes: 1, changeType: 'MODIFY' as any });
        }

        await commitStore.saveBatch([
            {
                sha: 'commitL',
                authorName: 'A',
                authorEmail: 'a@a.com',
                message: 'msg',
                timestamp: new Date('2023-01-01'),
                parentShas: [],
                repositoryId: 'r1',
                files: largeFiles
            }
        ]);

        builder.build();

        const stats = store.getFileStats('file0.ts');
        expect(stats).toBeNull();
    });
});
