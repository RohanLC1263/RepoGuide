const path = require('path');
const Module = require('module');

const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(name) {
    if (name === 'vscode') {
        return {
            workspace: {
                getConfiguration: () => ({ get: (_key, fallback) => fallback })
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

const repoRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.join(repoRoot, 'eval_repos', 'yarn');
const repoguideDir = path.join(workspaceRoot, '.repoguide');
const outputChannel = {
    appendLine(message) {
        console.log(`${new Date().toISOString()} ${message}`);
    }
};

async function run() {
    console.log(`Starting yarn comprehension at ${new Date().toISOString()}`);
    console.log(`Workspace root: ${workspaceRoot}`);
    console.log(`RepoGuide dir: ${repoguideDir}`);

    const engine = new ComprehensionEngine(outputChannel, repoguideDir);
    await engine.runFullComprehension(workspaceRoot);

    console.log(`Yarn comprehension complete at ${new Date().toISOString()}`);
}

run().catch(error => {
    console.error(`Yarn comprehension failed at ${new Date().toISOString()}`);
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
});
