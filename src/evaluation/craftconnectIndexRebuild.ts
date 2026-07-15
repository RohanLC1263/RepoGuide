/**
 * Careful, minimal, single-purpose rebuild script: calls the real production indexing
 * entry point (prepareRepository() -> IndexManager.forceFullReindex() -> fullIndex()) --
 * the same underlying function extension.ts's own IndexManager instance calls -- against
 * CraftConnect, with nothing else running concurrently, and verifies Lance/BM25 chunk
 * counts independently afterward rather than trusting internal diagnostics alone.
 *
 * Written after finding that CraftConnect's chunk-level stores (Lance, BM25) were
 * completely empty despite logical_units.db/facts.db being populated -- root-caused to
 * dogfoodCraftconnect.ts's own forceFullReindex() call (via prepareRepository()) most
 * likely having been interrupted after the destructive clearAll() steps but before the
 * re-embedding step completed. This script does ONLY the reindex + verification, with no
 * other steps, to minimize risk surface for this one deliberate, carefully-watched rebuild.
 *
 * Usage: npm run compile && node out/evaluation/craftconnectIndexRebuild.js
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

import { prepareRepository } from '../preparation/repositoryPreparation';
import { SymbolIndex } from '../indexing/symbolIndex';
import { Logger, RepositoryContext } from '../context/repositoryContext';
import { Bm25Store } from '../store/bm25Store';
import { LanceStore } from '../store/lanceStore';
import { getCraftConnectPath } from './craftconnectPath';

async function main(): Promise<void> {
    const craftconnectPath = getCraftConnectPath();
    const workspaceRoot = path.resolve(craftconnectPath);
    const repoguideDir = path.join(workspaceRoot, '.repoguide');

    const outputChannel = { appendLine: (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`) };
    const logger: Logger = {
        appendLine: (m: string) => outputChannel.appendLine(m),
        debug: (m: string) => outputChannel.appendLine(m),
        info: (m: string) => outputChannel.appendLine(m),
        warn: (m: string) => outputChannel.appendLine(m),
        error: (m: string) => outputChannel.appendLine(m),
        stageStart: (stage: string, total?: number) => outputChannel.appendLine(`[Stage START] ${stage}${total ? ` (${total} items)` : ''}`),
        stageProgress: (opts: any) => outputChannel.appendLine(`[Stage PROGRESS] ${opts.stageName}: ${opts.current}/${opts.total}`),
        stageComplete: (stage: string, stats?: any) => outputChannel.appendLine(`[Stage COMPLETE] ${stage} ${JSON.stringify(stats ?? {})}`),
        stageFailed: (stage: string, error: any) => outputChannel.appendLine(`[Stage FAILED] ${stage}: ${error}`),
        artifactWritten: (a: any) => outputChannel.appendLine(`[Artifact] ${a.artifactName}`),
        queryLog: () => undefined,
        repairLog: () => undefined
    };
    const context: RepositoryContext = {
        workspaceRoot,
        repoguideDataDir: repoguideDir,
        getConfig: <T,>(_key: string, defaultValue?: T) => defaultValue as T,
        asRelativePath: (p: string) => path.relative(workspaceRoot, p),
        logger,
        notifyInfo: async (m: string) => outputChannel.appendLine(`[notify] ${m}`),
        notifyWarning: async (m: string) => outputChannel.appendLine(`[WARN notify] ${m}`),
        notifyError: async (m: string) => outputChannel.appendLine(`[ERROR notify] ${m}`)
    };
    const statusBar = {
        setIndexing: () => outputChannel.appendLine('[status] indexing'),
        setIndexingProgress: (done: number, total: number) => outputChannel.appendLine(`[status] progress ${done}/${total}`),
        setReady: (count: number) => outputChannel.appendLine(`[status] ready, ${count} chunks`),
        setError: (msg: string) => outputChannel.appendLine(`[status] ERROR ${msg}`),
        setSynced: () => outputChannel.appendLine('[status] synced')
    };

    console.log(`=== Rebuilding CraftConnect's real index (prepareRepository -> forceFullReindex) ===`);
    console.log(`Workspace: ${workspaceRoot}`);
    const startedAt = Date.now();

    const symbolIndex = new SymbolIndex();
    symbolIndex.setLogger(logger as any);

    let indexManager: any = null;
    let indexError: string | null = null;
    try {
        const result = await prepareRepository({
            workspaceRoot,
            repoguideDir,
            context,
            statusBar: statusBar as any,
            symbolIndex,
            runComprehension: false,
            validateRequiredArtifacts: false
        });
        indexManager = result.indexManager;
        console.log('\n=== Readiness report after rebuild ===');
        console.log(JSON.stringify(result.readinessReport, null, 2));
    } catch (error) {
        indexError = error instanceof Error ? (error.stack ?? error.message) : String(error);
        console.error('=== INDEXING CRASHED ===');
        console.error(indexError);
    }

    const durationMs = Date.now() - startedAt;
    console.log(`\n=== Reindex finished in ${(durationMs / 1000).toFixed(1)}s (error: ${indexError ? 'YES' : 'no'}) ===`);
    if (indexManager) {
        console.log('Diagnostics:', JSON.stringify(indexManager.getDiagnostics(), null, 2));
    }

    // Independent verification: open the stores fresh (not reusing whatever the indexer
    // itself holds in memory) and count real rows, exactly like the earlier probe did.
    console.log('\n=== Independent post-rebuild verification ===');
    const bm25Store = new Bm25Store(repoguideDir);
    await bm25Store.init();
    const bm25Count = await bm25Store.getChunkCount();
    console.log(`BM25 document count: ${bm25Count}`);

    const lanceStore = new LanceStore(repoguideDir);
    await lanceStore.init();
    const lanceCount = await lanceStore.getChunkCount();
    console.log(`Lance chunk count: ${lanceCount}`);

    if (bm25Count === 0 || lanceCount === 0) {
        console.error('\n!!! REBUILD DID NOT PRODUCE REAL CHUNKS -- at least one store is still empty !!!');
        process.exitCode = 1;
    } else {
        console.log('\nRebuild verified: both stores have real, non-zero content.');
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
