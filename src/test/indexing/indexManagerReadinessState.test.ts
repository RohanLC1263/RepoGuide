import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IndexManager } from '../../indexing/indexManager';
import { SymbolIndex } from '../../indexing/symbolIndex';
import { RepositoryContext } from '../../context/repositoryContext';

/**
 * Real investigation finding: the chat sidebar's readiness indicator could
 * show "Ready" for the entire duration of a real rebuild, because nothing
 * ever pushed a fresh indexHealth message to an already-open webview when a
 * rebuild started from the command palette, an auto-rebuild prompt, or the
 * sidebar's own Rebuild button -- postIndexHealth() was only ever called
 * BEFORE the rebuild (webview open) or AFTER it completed (sidebar button's
 * own call site), never during. These tests exercise the fix at its source:
 * IndexManager.onIndexingStateChanged() must fire synchronously on every
 * real isIndexing/isAnnotating transition, and getIndexingProgress()/
 * getLastIndexCompletedAt() must expose the same counters the VS Code status
 * bar's "Indexing (N/total files)..." text is built from
 * (indexManager.ts's setIndexingProgress() call sites), so the two can never
 * disagree.
 *
 * IndexManager's constructor performs no I/O and never touches `store`
 * synchronously (confirmed by reading it), so a minimal fake store/statusBar/
 * context is sufficient here -- this deliberately does NOT invoke
 * fullIndex()/forceFullReindex() (which need a real embedding backend), only
 * the setter/listener/getter mechanism those methods call into.
 */

function stubContext(): RepositoryContext {
    return {
        workspaceRoot: '/workspace',
        getConfig: (_key: string, defaultValue?: unknown) => defaultValue as any,
        asRelativePath: (p: string) => p,
        logger: {
            appendLine: () => undefined,
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
            stageStart: () => undefined,
            stageProgress: () => undefined,
            stageComplete: () => undefined,
            stageFailed: () => undefined,
            artifactWritten: () => undefined,
            queryLog: () => undefined,
            repairLog: () => undefined
        },
        notifyInfo: () => undefined,
        notifyWarning: () => undefined,
        notifyError: () => undefined
    };
}

function stubStatusBar(): any {
    return {
        setIndexing: () => undefined,
        setIndexingProgress: () => undefined,
        setReady: () => undefined,
        setError: () => undefined,
        setSynced: () => undefined,
        setAnswering: () => undefined,
        restoreReady: () => undefined
    };
}

function makeIndexManager(): { indexManager: IndexManager; tempDir: string } {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguide-indexmanager-readiness-'));
    const indexManager = new IndexManager(
        {} as any,
        stubStatusBar(),
        tempDir,
        tempDir,
        stubContext(),
        new SymbolIndex()
    );
    return { indexManager, tempDir };
}

test('onIndexingStateChanged: fires when isIndexing flips true, and again when it flips back false', () => {
    const { indexManager, tempDir } = makeIndexManager();
    try {
        const events: boolean[] = [];
        indexManager.onIndexingStateChanged(() => events.push(indexManager.getIsIndexing()));

        (indexManager as any).setIsIndexing(true);
        (indexManager as any).setIsIndexing(false);

        assert.deepEqual(events, [true, false]);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('onIndexingStateChanged: setting the SAME value twice does not re-fire (no-op guard)', () => {
    const { indexManager, tempDir } = makeIndexManager();
    try {
        let fireCount = 0;
        indexManager.onIndexingStateChanged(() => { fireCount++; });

        (indexManager as any).setIsIndexing(true);
        (indexManager as any).setIsIndexing(true);
        (indexManager as any).setIsIndexing(true);

        assert.equal(fireCount, 1, 'a redundant set to the already-current value must not notify listeners again');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('onIndexingStateChanged: fires independently for isAnnotating transitions too', () => {
    const { indexManager, tempDir } = makeIndexManager();
    try {
        const events: Array<{ isIndexing: boolean; isAnnotating: boolean }> = [];
        indexManager.onIndexingStateChanged(() => events.push({
            isIndexing: indexManager.getIsIndexing(),
            isAnnotating: indexManager.getIsAnnotating()
        }));

        (indexManager as any).setIsAnnotating(true);
        (indexManager as any).setIsAnnotating(false);

        assert.deepEqual(events, [
            { isIndexing: false, isAnnotating: true },
            { isIndexing: false, isAnnotating: false }
        ]);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('onIndexingStateChanged: the returned unsubscribe function stops further notifications', () => {
    const { indexManager, tempDir } = makeIndexManager();
    try {
        let fireCount = 0;
        const unsubscribe = indexManager.onIndexingStateChanged(() => { fireCount++; });

        (indexManager as any).setIsIndexing(true);
        unsubscribe();
        (indexManager as any).setIsIndexing(false);

        assert.equal(fireCount, 1);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('onIndexingStateChanged: multiple independent listeners all fire (SidebarProvider is one of potentially several subscribers)', () => {
    const { indexManager, tempDir } = makeIndexManager();
    try {
        let a = 0;
        let b = 0;
        indexManager.onIndexingStateChanged(() => { a++; });
        indexManager.onIndexingStateChanged(() => { b++; });

        (indexManager as any).setIsIndexing(true);

        assert.equal(a, 1);
        assert.equal(b, 1);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('onIndexingStateChanged: a listener that throws does not prevent other listeners from running', () => {
    const { indexManager, tempDir } = makeIndexManager();
    try {
        let secondListenerRan = false;
        indexManager.onIndexingStateChanged(() => { throw new Error('boom'); });
        indexManager.onIndexingStateChanged(() => { secondListenerRan = true; });

        assert.doesNotThrow(() => (indexManager as any).setIsIndexing(true));
        assert.equal(secondListenerRan, true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('getIndexingProgress: null before any progress is recorded, and reflects the same {current,total} shape the status bar reads from', () => {
    const { indexManager, tempDir } = makeIndexManager();
    try {
        assert.equal(indexManager.getIndexingProgress(), null);

        (indexManager as any).indexingProgress = { current: 65, total: 401 };

        assert.deepEqual(indexManager.getIndexingProgress(), { current: 65, total: 401 });
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('getLastIndexCompletedAt: null until a rebuild commits; getter reflects the field once set', () => {
    const { indexManager, tempDir } = makeIndexManager();
    try {
        assert.equal(indexManager.getLastIndexCompletedAt(), null);

        const now = new Date();
        (indexManager as any).lastIndexCompletedAt = now;

        assert.equal(indexManager.getLastIndexCompletedAt(), now);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
