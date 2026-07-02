const path = require('path');
const Module = require('module');

const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(name) {
    if (name === 'vscode') {
        return {
            workspace: {
                getConfiguration: () => ({ get: (_key, fallback) => fallback })
            },
            window: {
                showWarningMessage: async message => console.log(`[Warn] ${message}`),
                createOutputChannel: () => ({
                    appendLine: message => console.log(message),
                    show: () => undefined,
                    dispose: () => undefined
                })
            },
            OutputChannel: class {
                appendLine(message) {
                    console.log(message);
                }
            }
        };
    }
    return originalRequire.apply(this, arguments);
};

const { ComprehensionEngine } = require('../out/comprehension/comprehensionEngine.js');
const { IndexManager } = require('../out/indexing/indexManager.js');
const { SymbolIndex } = require('../out/indexing/symbolIndex.js');
const { LanceStore } = require('../out/store/lanceStore.js');

const repoRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.join(repoRoot, 'eval_repos', 'medusa');
const repoguideDir = path.join(workspaceRoot, '.repoguide');
const outputChannel = {
    appendLine(message) {
        console.log(`${new Date().toISOString()} ${message}`);
    }
};

class EvalStatusBar {
    setIndexing() {}
    setIndexingProgress() {}
    setReady() {}
    setError() {}
    setSynced() {}
}

async function run() {
    console.log(`Starting medusa index + comprehension at ${new Date().toISOString()}`);
    console.log(`Workspace root: ${workspaceRoot}`);
    console.log(`RepoGuide dir: ${repoguideDir}`);

    const store = new LanceStore(repoguideDir);
    await store.init();

    const symbolIndex = new SymbolIndex();
    symbolIndex.setOutputChannel(outputChannel);

    const engine = new ComprehensionEngine(outputChannel, repoguideDir);
    const indexManager = new IndexManager(
        store,
        new EvalStatusBar(),
        workspaceRoot,
        repoguideDir,
        outputChannel,
        symbolIndex,
        undefined,
        undefined,
        engine,
        undefined
    );

    console.log(`Medusa full reindex started at ${new Date().toISOString()}`);
    await indexManager.forceFullReindex();
    console.log(`Medusa full reindex complete at ${new Date().toISOString()}`);

    console.log(`Medusa comprehension started at ${new Date().toISOString()}`);
    await engine.runFullComprehension(workspaceRoot);
    console.log(`Medusa comprehension complete at ${new Date().toISOString()}`);
}

run().catch(error => {
    console.error(`Medusa comprehension failed at ${new Date().toISOString()}`);
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
});
