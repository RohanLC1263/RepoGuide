import { ComprehensionEngine } from '../comprehension/comprehensionEngine';
import { ComprehensionJobRunner } from '../comprehension/comprehensionJobRunner';
import { RepositoryContext } from '../context/repositoryContext';
import { IndexManager } from '../indexing/indexManager';
import { SymbolIndex } from '../indexing/symbolIndex';
import { LanceStore } from '../store/lanceStore';
import { getRepositoryArtifactPaths } from './repositoryPaths';
import {
    RepositoryReadinessReport,
    assertRepositoryReady,
    buildRepositoryReadinessReport,
    writeRepositoryReadinessReport
} from './repositoryReadiness';

export interface PreparationStatusBar {
    setIndexing(): void;
    setIndexingProgress(current: number, total: number): void;
    setReady(count: number): void;
    setError(message: string): void;
    setSynced(): void;
}

export interface RepositoryPreparationOptions {
    workspaceRoot: string;
    repoguideDir?: string;
    context: RepositoryContext;
    statusBar: PreparationStatusBar;
    symbolIndex?: SymbolIndex;
    store?: LanceStore;
    comprehensionEngine?: ComprehensionEngine;
    comprehensionJobRunner?: ComprehensionJobRunner;
    runComprehension?: boolean;
    validateRequiredArtifacts?: boolean;
}

export interface RepositoryPreparationResult {
    readinessReport: RepositoryReadinessReport;
    indexManager: IndexManager;
}

export async function prepareRepository(options: RepositoryPreparationOptions): Promise<RepositoryPreparationResult> {
    const paths = getRepositoryArtifactPaths(options.workspaceRoot, options.repoguideDir);
    const store = options.store ?? new LanceStore(paths.lanceDbDir);
    await store.init();

    const symbolIndex = options.symbolIndex ?? new SymbolIndex();
    symbolIndex.setLogger(options.context.logger);

    const indexManager = new IndexManager(
        store,
        options.statusBar as any,
        paths.workspaceRoot,
        paths.repoguideDir,
        options.context,
        symbolIndex,
        undefined,
        undefined,
        options.comprehensionEngine,
        options.comprehensionJobRunner
    );

    await indexManager.forceFullReindex();

    if (options.runComprehension && options.comprehensionJobRunner) {
        await options.comprehensionJobRunner.run(paths.workspaceRoot);
    }

    const readinessReport = await buildRepositoryReadinessReport(paths.workspaceRoot, paths.repoguideDir);
    await writeRepositoryReadinessReport(readinessReport);
    if (options.validateRequiredArtifacts ?? true) {
        assertRepositoryReady(readinessReport);
    }

    return { readinessReport, indexManager };
}
