/**
 * One-off pre-flight check (investigation-only, no production code modified):
 * confirms RepositoryLivenessGate reports 'ok' for CraftConnect's real, live
 * index before running a fresh dogfood pass, so the results can't be confounded
 * by the exact empty-chunk-store condition this thread just fixed.
 *
 * Usage: npm run compile && node out/evaluation/livenessGateCheck.js
 */
import * as path from 'path';
import * as moduleObj from 'module';

function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = {
        workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_k: string, f: unknown) => f }) },
        window: { createOutputChannel: () => ({ appendLine: console.log, show: () => undefined, dispose: () => undefined }) }
    };
    moduleObj.Module.prototype.require = function patchedRequire(id: string) {
        if (id === 'vscode') {return shim;}
        return originalRequire.apply(this, arguments as any);
    };
}
installVscodeShim();

import { RepositoryLivenessGate } from '../preparation/repositoryLivenessGate';
import { buildRepositoryReadinessReport } from '../preparation/repositoryReadiness';

async function main(): Promise<void> {
    const workspaceRoot = path.resolve(process.env.CRAFTCONNECT_PATH ?? 'C:\\Users\\rohan\\Downloads\\CraftConnect');
    const repoguideDir = path.join(workspaceRoot, '.repoguide');

    const report = await buildRepositoryReadinessReport(workspaceRoot, repoguideDir);
    console.log(`Readiness status: ${report.status}`);
    for (const artifact of report.artifacts) {
        console.log(`  ${artifact.name}: ${artifact.status} (${artifact.recordCount} records)`);
    }

    const gate = new RepositoryLivenessGate(workspaceRoot, repoguideDir);
    const result = await gate.check();
    console.log(`\nLivenessGate status: ${result.status}`);
    if (result.message) {
        console.log(`Message: ${result.message}`);
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
