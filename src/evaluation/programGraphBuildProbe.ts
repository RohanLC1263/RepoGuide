/**
 * Investigation-only probe: calls ProgramGraphStore.build() directly against
 * CraftConnect's real, existing LogicalUnitStore/FactStore data to determine
 * empirically whether it succeeds, throws, or silently fails to persist --
 * rather than reasoning abstractly about why .repoguide/graph/graph.json is
 * missing despite the wiring already existing in IndexManager.fullIndex().
 *
 * Usage: npm run compile && node out/evaluation/programGraphBuildProbe.js
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

import { LogicalUnitStore } from '../store/logicalUnitStore';
import { FactStore } from '../store/factStore';
import { ProgramGraphStore } from '../store/programGraphStore';

async function main(): Promise<void> {
    const workspaceRoot = process.env.CRAFTCONNECT_PATH ?? 'C:\\Users\\rohan\\Downloads\\CraftConnect';

    const unitStore = new LogicalUnitStore();
    await unitStore.init(workspaceRoot);
    const factStore = new FactStore();
    await factStore.init(workspaceRoot);

    const allUnits = await unitStore.listIndexes({ limit: Number.POSITIVE_INFINITY });
    console.log(`LogicalUnitStore has ${allUnits.length} units for ${workspaceRoot}`);

    const programGraphStore = new ProgramGraphStore();
    console.log('Calling ProgramGraphStore.build()...');
    try {
        const graph = await programGraphStore.build(unitStore, factStore, workspaceRoot);
        console.log(`SUCCESS: nodeCount=${graph.nodeCount}, edgeCount=${graph.edgeCount}`);
        console.log(`isLoaded() after build: ${programGraphStore.isLoaded()}`);

        const reloaded = new ProgramGraphStore();
        const loaded = await reloaded.load(workspaceRoot);
        console.log(`Re-load from disk: ${loaded ? 'SUCCESS, node/edge counts=' + loaded.nodeCount + '/' + loaded.edgeCount : 'FAILED (null)'}`);
        console.log(`Re-loaded isLoaded(): ${reloaded.isLoaded()}`);
    } catch (error) {
        console.log('THREW:', error instanceof Error ? error.stack : String(error));
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
