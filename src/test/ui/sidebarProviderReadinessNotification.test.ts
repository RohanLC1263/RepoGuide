import { describe, test, expect } from '@jest/globals';
import { SidebarProvider } from '../../ui/sidebarProvider';
import { IndexHealthData } from '../../ui/indexHealthProvider';

/**
 * Real investigation finding: the chat sidebar's readiness indicator could
 * show "Ready" for the entire duration of a real rebuild. postIndexHealth()
 * was only ever called when the webview first opened, or (for the sidebar's
 * own Rebuild button) AFTER forceFullReindex() had already resolved -- never
 * DURING a rebuild triggered from the command palette, an auto-rebuild
 * prompt, or a rebuild that started before the sidebar was opened. The fix:
 * SidebarProvider subscribes to IndexManager.onIndexingStateChanged() once,
 * in its constructor, and pushes a fresh indexHealth message on every real
 * transition. This is the regression test for that fix -- it proves the push
 * actually reaches the webview, not just that the underlying flags are
 * correct (that part is covered by deriveReadinessStatus's pure-function
 * tests and indexManagerReadinessState.test.ts).
 *
 * Runs under jest (not node:test) because sidebarProvider.ts uses `vscode`
 * as a real value (not just types) in several method bodies, so importing it
 * outside jest's moduleNameMapper vscode mock throws "Cannot find module
 * 'vscode'" at require time -- confirmed directly against the compiled
 * output before writing this file.
 */

function fakeHealthData(overrides: Partial<IndexHealthData> = {}): IndexHealthData {
    return {
        chunkCount: 0,
        fileCount: 0,
        symbolCount: 0,
        lastIndexedAt: null,
        lastSyncedAt: null,
        isIndexing: true,
        isAnnotating: false,
        indexingProgress: { current: 65, total: 401 },
        lastIndexCompletedAt: null,
        workspaceRoot: '/workspace',
        embeddingModel: 'test-embed',
        inferenceModel: 'test-infer',
        validationIssues: null,
        ...overrides
    };
}

function fakeIndexHealthProvider(health: IndexHealthData): any {
    return {
        getHealthData: async () => health,
        getTopIndexedFolders: async () => [],
        formatHealthSummary: () => ''
    };
}

function fakeIndexManager(): { stub: any; fireStateChange: () => void } {
    let listener: (() => void) | undefined;
    const stub = {
        onIndexingStateChanged: (cb: () => void) => {
            listener = cb;
            return () => { listener = undefined; };
        },
        getIsIndexing: () => true,
        getIsAnnotating: () => false
    };
    return { stub, fireStateChange: () => listener && listener() };
}

function fakeWebview() {
    const posted: any[] = [];
    return {
        posted,
        webview: {
            postMessage: async (msg: any) => { posted.push(msg); return true; }
        } as any
    };
}

function makeProvider(indexManagerStub: any, healthProvider: any): SidebarProvider {
    return new SidebarProvider(
        {} as any, // extensionUri
        {} as any, // pipeline
        {} as any, // history
        indexManagerStub,
        {} as any, // accumulator
        {} as any, // workingSet
        healthProvider,
        {} as any, // store
        {} as any, // decorationManager
        '/workspace'
    );
}

/** postIndexHealth() bootstraps a real 3s setInterval poll whenever the
 * pushed data reports isIndexing/isAnnotating -- unrelated to what this file
 * tests (the push itself), but left running it would keep the process alive
 * and hang jest. Clear it after each assertion instead of letting it fire. */
function stopHealthPoll(provider: SidebarProvider): void {
    const timer = (provider as any).healthPollTimer;
    if (timer) {
        clearInterval(timer);
        (provider as any).healthPollTimer = undefined;
    }
}

describe('SidebarProvider subscribes to IndexManager readiness state changes', () => {
    test('pushes a fresh indexHealth message to an already-open webview the instant a real rebuild starts -- the exact regression this investigation found', async () => {
        const { stub: indexManagerStub, fireStateChange } = fakeIndexManager();
        const health = fakeHealthData({ isIndexing: true, indexingProgress: { current: 65, total: 401 } });
        const provider = makeProvider(indexManagerStub, fakeIndexHealthProvider(health));

        const { posted, webview } = fakeWebview();
        (provider as any)._view = { webview };

        fireStateChange();
        await new Promise(resolve => setImmediate(resolve));
        stopHealthPoll(provider);

        const healthMessages = posted.filter(m => m.type === 'indexHealth');
        expect(healthMessages.length).toBeGreaterThanOrEqual(1);
        expect(healthMessages[0].data.isIndexing).toBe(true);
        expect(healthMessages[0].data.indexingProgress).toEqual({ current: 65, total: 401 });
    });

    test('a real rebuild-completion transition also pushes the settled state (isIndexing false) to the webview', async () => {
        const { stub: indexManagerStub, fireStateChange } = fakeIndexManager();
        const health = fakeHealthData({ isIndexing: false, isAnnotating: false, indexingProgress: null, lastIndexCompletedAt: new Date().toISOString() as any });
        const provider = makeProvider(indexManagerStub, fakeIndexHealthProvider(health));

        const { posted, webview } = fakeWebview();
        (provider as any)._view = { webview };

        fireStateChange();
        await new Promise(resolve => setImmediate(resolve));
        stopHealthPoll(provider);

        const healthMessages = posted.filter(m => m.type === 'indexHealth');
        expect(healthMessages.length).toBeGreaterThanOrEqual(1);
        expect(healthMessages[0].data.isIndexing).toBe(false);
        expect(healthMessages[0].data.lastIndexCompletedAt).toBeTruthy();
    });

    test('is a no-op (does not throw, does not post) when no webview is currently open', async () => {
        const { stub: indexManagerStub, fireStateChange } = fakeIndexManager();
        const provider = makeProvider(indexManagerStub, fakeIndexHealthProvider(fakeHealthData()));

        expect(() => fireStateChange()).not.toThrow();
        expect((provider as any)._view).toBeUndefined();
    });
});
