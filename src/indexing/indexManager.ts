import { RepositoryContext } from '../context/repositoryContext';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LanceStore } from '../store/lanceStore';
import { StatusBarManager } from '../ui/statusBar';
import { walkFiles, DEFAULT_MAX_FILES } from './fileWalker';
import { detectLanguage } from './languageDetector';
import { redactDotenvContent } from './dotenvRedactor';
import { astChunk } from './astChunker';
import { chunkId, hashText, hashFileContent } from './chunkHasher';
import { embedText } from '../ollama/embedder';
import { CodeChunk } from '../store/storeTypes';
import { setFileHash, deleteFileHash, clearFileHashes } from '../watchers/syncHelpers';
import { MIN_CHUNK_CHARS } from './textChunker';
import { Bm25Store } from '../store/bm25Store';
import { PageRankGraphBuilder } from './pageRankGraphBuilder';
import { SymbolIndex } from './symbolIndex';
import { extractSymbols } from './symbolExtractor';
import { saveMeta, updateSyncTime } from '../store/indexMeta';
import { QAGenerator } from '../cache/qaGenerator';
import { QACache } from '../cache/qaCache';
import { getProfile } from '../config/performanceConfig';
import { ComprehensionEngine } from '../comprehension/comprehensionEngine';
import { ComprehensionJobRunner } from '../comprehension/comprehensionJobRunner';

import { FileAnnotationEngine } from '../comprehension/fileAnnotationEngine';
import { MerkleHashTracker } from '../comprehension/merkleHashTracker';
import { CommunityClustering } from '../comprehension/communityClustering';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { extractLogicalUnitsFromFile } from './logicalUnitExtractor';
import { LogicalUnit } from './logicalUnitTypes';
import { extractFacts } from './factExtractor';
import { FactRecord } from './factTypes';
import { FactStore } from '../store/factStore';
import { IndexManifestStore } from './indexManifest';
import { LogicalUnitBm25Store } from '../store/logicalUnitBm25Store';
import { ProgramGraphStore } from '../store/programGraphStore';
import * as crypto from 'crypto';
import { StoragePipeline } from '../store/storagePipeline';
import { ExtractionCoordinator } from './semantic/extractionCoordinator';
import { ExtractionDispatcher } from './semantic/extractionDispatcher';
import { ExtractionExecutionPolicy, ExtractionMode } from './semantic/extractionExecutionPolicy';
import { TypeScriptSemanticProvider } from './semantic/providers/typescript/typeScriptSemanticProvider';
import { PythonSemanticProvider } from './semantic/providers/python/pythonSemanticProvider';
import { JavaSemanticProvider } from './semantic/providers/java/javaSemanticProvider';
import { CSharpSemanticProvider } from './semantic/providers/csharp/csharpSemanticProvider';
import { GoSemanticProvider } from './semantic/providers/go/goSemanticProvider';
import { RustSemanticProvider } from './semantic/providers/rust/rustSemanticProvider';
import { CppSemanticProvider } from './semantic/providers/cpp/cppSemanticProvider';

import { AdrIngester } from '../memory/ingestion/adrIngester';
import { MemoryIngestionPipeline } from '../memory/ingestion/memoryIngestionPipeline';
import { ValidationPipeline } from '../memory/ingestion/validationPipeline';
import { DeduplicationService } from '../memory/ingestion/deduplicationService';
import { ConflictResolutionService } from '../memory/ingestion/conflictResolutionService';
import { PromotionService } from '../memory/ingestion/promotionService';
import { InMemoryEphemeralMemoryRepository } from '../memory/ingestion/ephemeralMemoryRepository';
import { TimelineEventEmitter } from '../memory/lifecycle/timelineEventEmitter';
import { InMemoryTimelineStore } from '../memory/lifecycle/inMemoryTimelineStore';
import { LanceDbMemoryStore } from '../memory/lanceDbMemoryStore';
import { LocalEmbeddingProvider } from '../memory/embeddings/localEmbeddingProvider';
import { MemoryStoreFactory } from '../memory/memoryStoreFactory';

export interface IndexDiagnostics {
    logicalUnitCount: number;
    factCount: number;
    chunkCount: number;
    fileCount: number;
    truncated: boolean;
    totalDiscovered: number;
}

export class IndexManager {
    private isIndexing = false;
    private activeUpdates = new Set<string>();
    private bm25Store: Bm25Store;
    private pageRankGraphBuilder: PageRankGraphBuilder;
    private annotationEngine: FileAnnotationEngine;
    private hashTracker: MerkleHashTracker;
    private communityClustering: CommunityClustering;
    private logicalUnitStore: LogicalUnitStore;
    private factStore: FactStore;
    private logicalUnitBm25Store: LogicalUnitBm25Store;
    private programGraphStore: ProgramGraphStore;
    private manifestStore: IndexManifestStore;
    private lastDiagnostics: IndexDiagnostics = {
        logicalUnitCount: 0,
        factCount: 0,
        chunkCount: 0,
        fileCount: 0,
        truncated: false,
        totalDiscovered: 0
    };
    private adrIngester: AdrIngester | null = null;
    private storagePipeline: StoragePipeline;
    private extractionCoordinator: ExtractionCoordinator;

    constructor(
        private store: LanceStore, 
        private statusBar: StatusBarManager, 
        private workspaceRoot: string,
        private repoguideDir: string,
        private context: RepositoryContext,
        private symbolIndex: SymbolIndex,
        private qaGenerator?: QAGenerator,
        private qaCache?: QACache,
        private comprehensionEngine?: ComprehensionEngine,
        private comprehensionJobRunner?: ComprehensionJobRunner
    ) {
        this.bm25Store = new Bm25Store(this.repoguideDir);
        this.pageRankGraphBuilder = new PageRankGraphBuilder(this.repoguideDir, this.workspaceRoot, this.symbolIndex);
        this.annotationEngine = new FileAnnotationEngine(this.repoguideDir, this.workspaceRoot, this.context);
        this.hashTracker = new MerkleHashTracker(this.repoguideDir);
        this.communityClustering = new CommunityClustering(this.repoguideDir, this.context);
        this.logicalUnitStore = new LogicalUnitStore(this.repoguideDir);
        this.factStore = new FactStore(this.repoguideDir);
        this.storagePipeline = new StoragePipeline(this.repoguideDir, this.logicalUnitStore, this.factStore);
        this.logicalUnitBm25Store = new LogicalUnitBm25Store(this.repoguideDir);
        this.programGraphStore = new ProgramGraphStore();
        this.manifestStore = new IndexManifestStore(this.repoguideDir, this.context.logger);

        // CP3A Semantic Framework Setup (Shadow Mode)
        const policy = new ExtractionExecutionPolicy();
        policy.setMode(ExtractionMode.ShadowMode);
        
        const dispatcher = new ExtractionDispatcher();
        dispatcher.registerProvider(new TypeScriptSemanticProvider());
        dispatcher.registerProvider(new PythonSemanticProvider());
        dispatcher.registerProvider(new JavaSemanticProvider());
        dispatcher.registerProvider(new CSharpSemanticProvider());
        dispatcher.registerProvider(new GoSemanticProvider());
        dispatcher.registerProvider(new RustSemanticProvider());
        dispatcher.registerProvider(new CppSemanticProvider());
        
        this.extractionCoordinator = new ExtractionCoordinator(
            policy,
            dispatcher,
            extractLogicalUnitsFromFile
        );
    }

    getIsIndexing(): boolean {
        return this.isIndexing;
    }

    public getAnnotationEngine(): FileAnnotationEngine {
        return this.annotationEngine;
    }

    public getUnitStore(): LogicalUnitStore {
        return this.logicalUnitStore;
    }

    public getFactStore(): FactStore {
        return this.factStore;
    }

    public getLogicalUnitBm25Store(): LogicalUnitBm25Store {
        return this.logicalUnitBm25Store;
    }

    public getProgramGraphStore(): ProgramGraphStore {
        return this.programGraphStore;
    }

    public getManifestStore(): IndexManifestStore {
        return this.manifestStore;
    }
    private adrIngesterPromise: Promise<AdrIngester> | null = null;
    private async getAdrIngester(): Promise<AdrIngester> {
        // Memoized as an in-flight promise, not just the resolved value -- with
        // concurrent file workers, multiple callers can otherwise all observe
        // `this.adrIngester` as unset and each construct their own instance.
        if (!this.adrIngesterPromise) {
            this.adrIngesterPromise = (async () => {
                const memoryStore = await MemoryStoreFactory.getMemoryStore(this.workspaceRoot);
                const pipeline = new MemoryIngestionPipeline(
                    memoryStore,
                    new ValidationPipeline(),
                    new DeduplicationService(memoryStore),
                    new ConflictResolutionService(memoryStore),
                    new PromotionService(new InMemoryEphemeralMemoryRepository()),
                    new TimelineEventEmitter(new InMemoryTimelineStore())
                );
                this.adrIngester = new AdrIngester(pipeline);
                return this.adrIngester;
            })();
        }
        return this.adrIngesterPromise;
    }
    public getDiagnostics(): IndexDiagnostics {
        return { ...this.lastDiagnostics };
    }

    /**
     * Clears the entire index and rebuilds from scratch.
     * Used by the "Re-sync Index" command and sidebar button.
     */
    async forceFullReindex(): Promise<void> {
        if (this.isIndexing) {
            this.context.notifyWarning('RepoGuide: Indexing is already in progress.');
            return;
        }

        this.statusBar.setIndexing();
        this.context.logger.info('Starting full re-index...');

        try {
            await this.storagePipeline.init(this.workspaceRoot);
            // await this.factStore.init(this.workspaceRoot);
            await this.bm25Store.init();
            await this.logicalUnitBm25Store.init();
            await this.hashTracker.init();
            await this.manifestStore.init();

            // Captured before anything is touched, so commitRebuild() below can tell
            // a genuinely-empty repo apart from a reindex that silently produced zero
            // chunks (e.g. every embedding call failed) despite having real data before.
            const previousChunkCount = await this.store.getChunkCount();
            const previousBm25Count = await this.bm25Store.getChunkCount();

            // These stores are cleared in place up front -- unchanged from before, and a
            // smaller, disclosed residual risk (see PR/CHANGELOG): they're not the chunk-level
            // stores that were found to go empty, so they don't get the generation-swap below.
            await this.storagePipeline.clearAll();
            // await this.factStore.clearAll();
            await this.logicalUnitBm25Store.clearAll();
            await this.pageRankGraphBuilder.clearAll();
            await this.annotationEngine.clearAll();
            clearFileHashes();
            this.symbolIndex.clear();
            this.hashTracker.clear();
            await this.hashTracker.save();
            this.manifestStore.clear();
            await this.manifestStore.save();
            this.qaCache?.clear();

            // Lance and BM25 (the chunk-level "hybrid retrieval" stores) build into a
            // fresh, inactive generation instead of clearing in place. If fullIndex()
            // throws, or completes but produces no chunks despite previously having
            // some, the previous, real chunk data stays live and queryable rather than
            // being replaced by an empty index.
            await this.store.beginRebuild();
            await this.bm25Store.beginRebuild();
            try {
                await this.fullIndex();
                const lanceCommitted = await this.store.commitRebuild(previousChunkCount);
                const bm25Committed = await this.bm25Store.commitRebuild(previousBm25Count);
                if (!lanceCommitted || !bm25Committed) {
                    throw new Error(
                        `Reindex produced no chunks (had ${previousChunkCount} Lance / ${previousBm25Count} BM25 chunks before) -- keeping the previous chunk index intact instead of replacing it with an empty one.`
                    );
                }
            } catch (e) {
                await this.store.abortRebuild();
                await this.bm25Store.abortRebuild();
                throw e;
            }
        } catch (e) {
            this.context.logger.error(`Force full re-index failed: ${e}`);
            this.statusBar.setError('Re-index failed');
            throw e;
        }
    }

    /**
     * Indexes all walkable files in the workspace from scratch.
     * Does NOT clear the store first, and does NOT re-init bm25Store/store --
     * forceFullReindex() handles that (including staging the Lance/BM25 rebuild
     * generation via beginRebuild(); a redundant bm25Store.init() here would
     * silently repoint writes back at the live generation mid-rebuild).
     */
    async fullIndex(): Promise<void> {
        if (this.isIndexing) {
            this.context.logger.appendLine('[Warn] Full index skipped -- already indexing.');
            return;
        }

        this.isIndexing = true;
        this.statusBar.setIndexing();
        const log = this.context.logger;
        log.stageStart('vector_indexing');

        try {
            await this.storagePipeline.init(this.workspaceRoot);
            // await this.factStore.init(this.workspaceRoot);
            await this.logicalUnitBm25Store.init();
            await this.pageRankGraphBuilder.init();
            await this.hashTracker.init();
            await this.manifestStore.init();
            this.manifestStore.clear();
            const excludePatterns = this.context.getConfig<string[]>('excludePatterns', []);
            const maxIndexedFiles = this.context.getConfig<number>('maxIndexedFiles', DEFAULT_MAX_FILES);
            const walkResult = await walkFiles(this.workspaceRoot, excludePatterns, maxIndexedFiles);
            const { filePaths, truncated, totalDiscovered } = walkResult;
            if (truncated) {
                this.context.logger.appendLine(`[Warn] Index budget reached: indexing ${filePaths.length} of ${totalDiscovered} discovered files. Set repoguide.maxIndexedFiles to raise the cap.`);
            }
            let totalChunks = 0;
            const logicalDiagnostics = createLogicalUnitDiagnostics();
            let totalFacts = 0;

            let skippedChunks = 0;

            const embedWithRetry = async (text: string, retries = 1): Promise<number[]> => {
                try {
                    return await embedText(this.context, text);
                } catch (e) {
                    if (retries > 0) {
                        await new Promise(r => setTimeout(r, 2000));
                        return embedWithRetry(text, retries - 1);
                    }
                    throw e;
                }
            };

            const configuredConcurrency = this.context.getConfig<number>('indexingConcurrency', 0);
            const concurrency = Math.max(1, configuredConcurrency > 0 ? configuredConcurrency : Math.min(os.cpus().length, 4));
            let nextFileIndex = 0;
            let completedFiles = 0;

            const processFile = async (filePath: string): Promise<void> => {
                try {
                    const rawContent = await fs.promises.readFile(filePath, 'utf-8');
                    const stat = await fs.promises.stat(filePath);
                    const language = detectLanguage(filePath);
                    if (!language) {
                        return;
                    }
                    // Redact .env value sides before this content can reach an
                    // embedding call, an LLM prompt, or any on-disk store -- see
                    // dotenvRedactor.ts. rawContent is kept ONLY for change-detection
                    // hashing below (setFileHash/manifestStore), so re-editing just a
                    // secret's VALUE still correctly triggers re-indexing.
                    const content = language === 'dotenv' ? redactDotenvContent(rawContent) : rawContent;

                    const logicalUnits = await this.extractionCoordinator.extractFile(filePath, content, this.workspaceRoot);

                    let factsForFileCount = 0;
                    if (logicalUnits.length > 0) {
                        await this.storagePipeline.upsertUnits(logicalUnits);
                        const factsForFile: FactRecord[] = [];
                        for (const u of logicalUnits) {
                            factsForFile.push(...extractFacts(u));
                        }
                        await this.storagePipeline.upsertFacts(factsForFile);
                        factsForFileCount = factsForFile.length;
                        totalFacts += factsForFile.length;
                        updateLogicalUnitDiagnostics(logicalDiagnostics, logicalUnits);
                    }

                    const ingester = await this.getAdrIngester();
                    if (ingester.isAdrFile(filePath, this.workspaceRoot)) {
                        await ingester.processFile(filePath, content, 'local-repo', this.workspaceRoot);
                    }

                    const rawChunks = astChunk(filePath, content, language, this.context.logger);
                    const codeChunks: CodeChunk[] = [];

                    // Extract and index symbols
                    const symbols = extractSymbols(filePath, content, language);
                    if (symbols.length > 0) {
                        this.symbolIndex.addSymbols(symbols);
                    }

                    for (const chunk of rawChunks) {
                        if (chunk.text.trim().length < MIN_CHUNK_CHARS) {
                            continue;
                        }
                        const id = chunkId(filePath, chunk.startLine, hashText(chunk.text));
                        const hash = hashText(chunk.text);
                        let vector: number[] = [];
                        try {
                            vector = await embedWithRetry(chunk.text);
                        } catch (e) {
                            this.context.logger.appendLine(`[Error] Embedding chunk from ${filePath}:${chunk.startLine}: ${e}`);
                            log.warn(`Embedding failed for ${filePath}:${chunk.startLine}`);
                            skippedChunks++;
                            continue;
                        }

                        codeChunks.push({
                            id, filePath, language,
                            startLine: chunk.startLine, endLine: chunk.endLine,
                            text: chunk.text, vector, hash
                        });
                    }

                    if (codeChunks.length > 0) {
                        try {
                            await this.store.insertChunks(codeChunks);
                            await this.bm25Store.insertChunks(codeChunks);
                            totalChunks += codeChunks.length;
                        } catch (e) {
                            this.context.logger.appendLine(`[Error] Inserting chunks for ${filePath}: ${e}`);
                        }
                    }

                    // Record file-level hash for git watcher
                    setFileHash(filePath, hashFileContent(rawContent));

                    // Cache identifiers for PageRank
                    await this.pageRankGraphBuilder.updateFile(filePath, content, language);

                    const relPath = this.toRepoRelativePath(filePath);
                    this.manifestStore.setEntry(relPath, {
                        relativePath: relPath,
                        size: stat.size,
                        mtimeMs: stat.mtimeMs,
                        contentHash: hashFileContent(rawContent),
                        indexedAt: new Date().toISOString(),
                        language,
                        role: logicalUnits.length > 0 ? logicalUnits[0].role : 'unknown',
                        unitCount: logicalUnits.length,
                        factCount: factsForFileCount,
                        parseDiagnostics: []
                    });
                } catch (e) {
                    this.context.logger.appendLine(`[Error] Processing file ${filePath}: ${e}`);
                }
            };

            const worker = async (): Promise<void> => {
                while (nextFileIndex < filePaths.length) {
                    const filePath = filePaths[nextFileIndex++];
                    await processFile(filePath);
                    completedFiles++;
                    this.statusBar.setIndexingProgress(completedFiles, filePaths.length);
                }
            };

            const workerCount = Math.min(concurrency, filePaths.length);
            await Promise.all(Array.from({ length: workerCount }, () => worker()));

            await this.manifestStore.save();

            const allLogicalUnits = await this.logicalUnitStore.getAll();
            await this.logicalUnitBm25Store.clearAll();
            await this.logicalUnitBm25Store.indexUnits(allLogicalUnits);
            this.context.logger.appendLine(`[Info] Logical unit BM25 indexed: ${this.logicalUnitBm25Store.getIndexedCount()} units.`);

            const programGraph = await this.programGraphStore.build(
                this.logicalUnitStore,
                this.factStore,
                this.workspaceRoot
            );
            this.context.logger.appendLine(`[Info] Program graph built: ${programGraph.nodeCount} nodes, ${programGraph.edgeCount} edges.`);

            this.statusBar.setReady(totalChunks);
            
            if (this.symbolIndex.getStats().totalSymbols > 0) {
                await this.symbolIndex.save(this.repoguideDir);
            }

            // Build PageRank graph
            try {
                await this.pageRankGraphBuilder.buildGraph(filePaths);
                
                // Run community summary generation in background
                setTimeout(async () => {
                    try {
                        await this.communityClustering.clusterAndSummarize();
                    } catch (e) {
                        this.context.logger.appendLine(`[Warn] Community clustering failed: ${e}`);
                    }
                }, 10000);
            } catch (e) {
                this.context.logger.appendLine(`[Error] PageRank graph building failed: ${e}`);
            }

            if (skippedChunks > 0) {
                this.context.logger.appendLine(`[Warn] ${skippedChunks} chunks failed to embed and were excluded from the index.`);
            }

            log.stageComplete('vector_indexing', { total: totalChunks });
            this.context.logger.appendLine(`[Info] Logical units indexed: ${logicalDiagnostics.total}. Roles=${formatCounts(logicalDiagnostics.roles)} Types=${formatCounts(logicalDiagnostics.types)} Parse=${formatCounts(logicalDiagnostics.parseStatus)} Methods=${formatCounts(logicalDiagnostics.extractionMethods)}`);
            log.artifactWritten({ artifactName: 'symbols.json', stats: { symbols: this.symbolIndex.getStats().totalSymbols } });

            // Output true post-index stats directly from the store to confirm health
            const finalChunkCount = await this.store.getChunkCount();
            const finalFilePaths = await this.store.getAllFilePaths();
            const symStats = this.symbolIndex.getStats();
            const embeddingModel = getProfile().embeddingModel;
            this.lastDiagnostics = {
                logicalUnitCount: logicalDiagnostics.total,
                factCount: totalFacts,
                chunkCount: finalChunkCount,
                fileCount: finalFilePaths.length,
                truncated,
                totalDiscovered
            };
            await saveMeta(this.repoguideDir, {
                lastFullIndexAt: new Date().toISOString(),
                lastSyncAt: new Date().toISOString(),
                chunkCount: finalChunkCount,
                fileCount: finalFilePaths.length,
                embeddingModel,
                truncated,
                totalDiscovered
            });
            this.context.logger.appendLine(`[Info] Full index complete: Embedded and pushed ${totalChunks} new chunks.`);
            this.context.logger.appendLine(`[Info] Index Health Check: Store contains exactly ${finalChunkCount} chunks. Symbols map tracked ${symStats.totalSymbols} symbols across ${symStats.totalFiles} files.`);

            if (this.comprehensionJobRunner) {
                setTimeout(() => {
                    this.comprehensionJobRunner!.run(this.workspaceRoot)
                        .catch(e => this.context.logger.appendLine(`[Warn] Comprehension error: ${e}`));
                }, 5000);
            }

            // Run file annotations in background after indexing
            // Collect files that need annotation based on hash changes
            const filesToAnnotate: Array<{ filePath: string; content: string }> = [];
            for (const fp of filePaths) {
                try {
                    const content = await fs.promises.readFile(fp, 'utf-8');
                    if (this.hashTracker.hasChanged(fp, content)) {
                        filesToAnnotate.push({ filePath: fp, content });
                    }
                } catch { /* skip unreadable files */ }
            }

            if (filesToAnnotate.length > 0) {
                this.context.logger.appendLine(`[Info] Queuing ${filesToAnnotate.length} files for annotation...`);
                // Run in background, don't block indexing
                setTimeout(async () => {
                    try {
                        await this.annotationEngine.annotateFiles(filesToAnnotate, 3);
                        // Update hashes for all annotated files
                        for (const f of filesToAnnotate) {
                            this.hashTracker.updateHash(f.filePath, f.content);
                        }
                        await this.hashTracker.save();
                        this.context.logger.appendLine(`[Info] Annotation complete: ${filesToAnnotate.length} files annotated.`);
                    } catch (e) {
                        this.context.logger.appendLine(`[Warn] Background annotation error: ${e}`);
                    }
                }, 2000);
            }

            if (this.qaGenerator) {
                setTimeout(() => {
                    this.qaGenerator!.generateAll(this.workspaceRoot).catch(e =>
                        this.context.logger.appendLine(`[Warn] Q&A pre-generation error: ${e}`)
                    );
                }, 30000);
            }
        } finally {
            this.isIndexing = false;
        }
    }

    /**
     * Incrementally indexes all files that have changed or are new,
     * and deletes files that are removed, based on the manifest.
     */
    async reindexChanged(): Promise<void> {
        if (this.isIndexing) {
            this.context.logger.appendLine('[Warn] Incremental index skipped -- already indexing.');
            return;
        }

        this.isIndexing = true;
        this.statusBar.setIndexing();
        const log = this.context.logger;
        log.info('Starting incremental re-index...');

        try {
            await this.manifestStore.init();
            const excludePatterns = this.context.getConfig<string[]>('excludePatterns', []);
            const maxIndexedFiles = this.context.getConfig<number>('maxIndexedFiles', DEFAULT_MAX_FILES);
            const { filePaths, truncated, totalDiscovered } = await walkFiles(this.workspaceRoot, excludePatterns, maxIndexedFiles);
            if (truncated) {
                this.context.logger.appendLine(`[Warn] Index budget reached: reconciling ${filePaths.length} of ${totalDiscovered} discovered files. Set repoguide.maxIndexedFiles to raise the cap.`);
            }
            this.lastDiagnostics.truncated = truncated;
            this.lastDiagnostics.totalDiscovered = totalDiscovered;
            const currentFiles = new Set<string>();

            // 1a. Scan phase (parallelized): decide which files changed. Read-only
            // aside from per-key manifest refreshes, so safe under concurrency --
            // unlike incrementalUpdate() below, nothing here touches the shared
            // isIndexing reentrancy flag.
            const filesNeedingUpdate: string[] = [];
            const configuredConcurrency = this.context.getConfig<number>('indexingConcurrency', 0);
            const scanConcurrency = Math.max(1, configuredConcurrency > 0 ? configuredConcurrency : Math.min(os.cpus().length, 4));
            let nextScanIndex = 0;
            let scannedCount = 0;

            const scanFile = async (filePath: string): Promise<void> => {
                const relPath = this.toRepoRelativePath(filePath);
                currentFiles.add(relPath);
                try {
                    const stat = await fs.promises.stat(filePath);
                    const manifestEntry = this.manifestStore.getEntry(relPath);

                    let needsUpdate = false;
                    if (!manifestEntry) {
                        needsUpdate = true; // new file
                    } else if (stat.mtimeMs !== manifestEntry.mtimeMs || stat.size !== manifestEntry.size) {
                        // Check content hash to be sure
                        const content = await fs.promises.readFile(filePath, 'utf-8');
                        const hash = hashFileContent(content);
                        if (hash !== manifestEntry.contentHash) {
                            needsUpdate = true;
                        } else {
                            // Update manifest mtime to match even though content didn't change
                            manifestEntry.mtimeMs = stat.mtimeMs;
                            this.manifestStore.setEntry(relPath, manifestEntry);
                        }
                    }

                    if (needsUpdate) {
                        filesNeedingUpdate.push(filePath);
                    }
                } catch (e) {
                    log.error(`Error checking file ${filePath}: ${e}`);
                }
            };

            const scanWorker = async (): Promise<void> => {
                while (nextScanIndex < filePaths.length) {
                    const filePath = filePaths[nextScanIndex++];
                    await scanFile(filePath);
                    scannedCount++;
                    this.statusBar.setIndexingProgress(scannedCount, filePaths.length);
                }
            };

            const scanWorkerCount = Math.min(scanConcurrency, filePaths.length);
            await Promise.all(Array.from({ length: scanWorkerCount }, () => scanWorker()));

            // 1b. Apply updates sequentially. incrementalUpdate() toggles the shared
            // isIndexing flag as a reentrancy guard against file-watcher-triggered
            // updates firing mid-sweep; running these concurrently would race that flag.
            for (const filePath of filesNeedingUpdate) {
                const relPath = this.toRepoRelativePath(filePath);
                log.info(`Incrementally updating: ${relPath}`);
                this.isIndexing = false;
                await this.incrementalUpdate(filePath);
                this.isIndexing = true;
            }

            // 2. Process deleted files
            const allManifestPaths = this.manifestStore.getAllPaths();
            for (const relPath of allManifestPaths) {
                if (!currentFiles.has(relPath)) {
                    log.info(`Deleting removed file: ${relPath}`);
                    const filePath = path.join(this.workspaceRoot, relPath);
                    this.isIndexing = false;
                    await this.deleteFile(filePath);
                    this.isIndexing = true;
                }
            }

            await this.manifestStore.save();
        } finally {
            this.isIndexing = false;
            this.statusBar.setReady(await this.store.getChunkCount());
        }
    }

    /**
     * Incrementally updates the index for a single file.
     * Compares new chunks against existing ones by hash to avoid
     * unnecessary embedding calls:
     *   - Unchanged chunks (same id, same hash) -> skip
     *   - Changed chunks (same id, different hash) -> delete old, embed and insert new
     *   - New chunks (id not in store) -> embed and insert
     *   - Removed chunks (id in store but not in new parse) -> delete
     *
     * Also updates the file-level hash cache for git watcher.
     */
    async incrementalUpdate(filePath: string): Promise<void> {
        if (this.isIndexing) {
            this.context.logger.appendLine(`[Info] Incremental update deferred for ${filePath} — full index in progress.`);
            return;
        }
        while (this.activeUpdates.has(filePath)) {
            await new Promise(r => setTimeout(r, 100));
        }

        this.activeUpdates.add(filePath);
        try {
            await this.bm25Store.init();
            await this.storagePipeline.init(this.workspaceRoot);
            // await this.factStore.init(this.workspaceRoot);
            await this.pageRankGraphBuilder.init();
            // Get existing chunks for this file from the store
            const existingChunks = await this.store.getChunksByFile(filePath);
            const existingMap = new Map<string, CodeChunk>();
            for (const chunk of existingChunks) {
                existingMap.set(chunk.id, chunk);
            }

            // Try to read and parse the current file content
            let rawContent = '';
            let content = '';
            let language: string | null = null;
            try {
                rawContent = await fs.promises.readFile(filePath, 'utf-8');
                language = detectLanguage(filePath);
                // Redact .env value sides before this content can reach an
                // embedding call, an LLM prompt, or any on-disk store -- see
                // dotenvRedactor.ts. rawContent is kept ONLY for change-detection
                // hashing below (setFileHash/manifestStore).
                content = language === 'dotenv' ? redactDotenvContent(rawContent) : rawContent;
            } catch (e) {
                // File might have been deleted between the event and now
            }

            if (!language) {
                // File is not parseable or does not exist -- remove all chunks
                if (existingChunks.length > 0) {
                    await this.store.deleteChunksByFile(filePath);
                    await this.bm25Store.deleteChunksByIds(existingChunks.map(c => c.id));
                }
                const relPath = this.toRepoRelativePath(filePath);
                await this.storagePipeline.deleteFile(relPath);
                // await this.factStore.deleteFile(relPath);
                await this.pageRankGraphBuilder.removeFile(filePath);
                const ingester = await this.getAdrIngester();
                if (ingester.isAdrFile(filePath, this.workspaceRoot)) {
                    await ingester.processDelete(filePath, 'local-repo', this.workspaceRoot);
                }
                deleteFileHash(filePath);
                this.manifestStore.removeEntry(relPath);
                await this.manifestStore.save();
                await updateSyncTime(this.repoguideDir);
                const allPaths = await this.store.getAllFilePaths();
                await this.pageRankGraphBuilder.buildGraph(allPaths);
                this.statusBar.setSynced();
                return;
            }

            const stat = await fs.promises.stat(filePath);
            const rawChunks = astChunk(filePath, content, language, this.context.logger);
            const logicalUnits = await this.extractionCoordinator.extractFile(filePath, content, this.workspaceRoot);

            if (logicalUnits.length > 0) {
                const fileFacts: FactRecord[] = [];
                for (const u of logicalUnits) {
                    fileFacts.push(...extractFacts(u));
                }
                await this.storagePipeline.upsertUnits(logicalUnits);
                await this.storagePipeline.upsertFacts(fileFacts);
            } else {
                await this.storagePipeline.deleteFile(this.toRepoRelativePath(filePath));
                // await this.factStore.deleteFile(this.toRepoRelativePath(filePath));
            }
            const ingester = await this.getAdrIngester();
            if (ingester.isAdrFile(filePath, this.workspaceRoot)) {
                await ingester.processFile(filePath, content, 'local-repo', this.workspaceRoot);
            }
            const newCodeChunks: CodeChunk[] = [];
            const idsSeen = new Set<string>();

            this.symbolIndex.removeSymbolsByFile(filePath);
            const symbols = extractSymbols(filePath, content, language);
            if (symbols.length > 0) {
                this.symbolIndex.addSymbols(symbols);
            }

            for (const chunk of rawChunks) {
                if (chunk.text.trim().length < MIN_CHUNK_CHARS) {
                    continue;
                }
                const id = chunkId(filePath, chunk.startLine, hashText(chunk.text));
                const hash = hashText(chunk.text);
                idsSeen.add(id);

                const existing = existingMap.get(id);
                if (existing) {
                    if (existing.hash === hash) {
                        // Chunk unchanged -- skip entirely (no embedding needed)
                        continue;
                    }
                    // Chunk changed -- delete old version
                    await this.store.deleteChunkById(id);
                    await this.bm25Store.deleteChunkById(id);
                    try {
                        const vector = await embedText(this.context, chunk.text);
                        newCodeChunks.push({
                            id, filePath, language,
                            startLine: chunk.startLine, endLine: chunk.endLine,
                            text: chunk.text, vector, hash
                        });
                    } catch (e) {
                        this.context.logger.appendLine(`[Error] Embedding changed chunk ${filePath}:${chunk.startLine}: ${e}`);
                    }
                } else {
                    // New chunk -- embed and insert
                    try {
                        const vector = await embedText(this.context, chunk.text);
                        newCodeChunks.push({
                            id, filePath, language,
                            startLine: chunk.startLine, endLine: chunk.endLine,
                            text: chunk.text, vector, hash
                        });
                    } catch (e) {
                        this.context.logger.appendLine(`[Error] Embedding new chunk ${filePath}:${chunk.startLine}: ${e}`);
                    }
                }
            }

            // Remove chunks that no longer exist in the parsed output
            const toDeleteIds: string[] = [];
            for (const existingId of existingMap.keys()) {
                if (!idsSeen.has(existingId)) {
                    await this.store.deleteChunkById(existingId);
                    toDeleteIds.push(existingId);
                }
            }
            if (toDeleteIds.length > 0) {
                await this.bm25Store.deleteChunksByIds(toDeleteIds);
            }

            // Insert all new/changed chunks in one batch
            if (newCodeChunks.length > 0) {
                try {
                    await this.store.insertChunks(newCodeChunks);
                    await this.bm25Store.insertChunks(newCodeChunks);
                } catch (e) {
                    this.context.logger.appendLine(`[Error] Incremental insert for ${filePath}: ${e}`);
                }
            }

            // Update file-level hash for git watcher
            setFileHash(filePath, hashFileContent(rawContent));

            await this.symbolIndex.save(this.repoguideDir);
            
            await this.pageRankGraphBuilder.updateFile(filePath, content, language);
            const allPaths = await this.store.getAllFilePaths();
            await this.pageRankGraphBuilder.buildGraph(allPaths);
            
            setTimeout(async () => {
                try {
                    await this.communityClustering.clusterAndSummarize();
                } catch (e) {
                    this.context.logger.appendLine(`[Warn] Community clustering failed: ${e}`);
                }
            }, 5000);

            this.context.logger.appendLine(
                `[Info] Symbol index saved: ${this.symbolIndex.getStats().totalSymbols} symbols.`
            );
            if (this.comprehensionEngine) {
                await this.comprehensionEngine.handleFileChange(filePath);
            }

            // Annotate file if its hash changed
            if (this.hashTracker.hasChanged(filePath, content)) {
                try {
                    await this.annotationEngine.annotateFile(filePath, content);
                    this.hashTracker.updateHash(filePath, content);
                    await this.hashTracker.save();
                } catch (e) {
                    this.context.logger.appendLine(`[Warn] Annotation failed for ${filePath}: ${e}`);
                }
            }

            const relPath = this.toRepoRelativePath(filePath);
            this.manifestStore.setEntry(relPath, {
                relativePath: relPath,
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                contentHash: hashFileContent(rawContent),
                indexedAt: new Date().toISOString(),
                language,
                role: logicalUnits.length > 0 ? logicalUnits[0].role : 'unknown',
                unitCount: logicalUnits.length,
                factCount: 0,
                parseDiagnostics: []
            });
            await this.manifestStore.save();

            await updateSyncTime(this.repoguideDir);
            this.statusBar.setSynced();
        } catch (e) {
            this.context.logger.appendLine(`[Error] Incremental update failed for ${filePath}: ${e}`);
        } finally {
            this.activeUpdates.delete(filePath);
        }
    }

    /**
     * Removes all chunks for a file path from the store.
     * Used by watchers when a file is deleted.
     */
    async deleteFile(filePath: string): Promise<void> {
        if (this.isIndexing) {
            this.context.logger.appendLine(`[Info] Delete deferred for ${filePath} — full index in progress.`);
            return;
        }
        try {
            await this.bm25Store.init();
            await this.storagePipeline.init(this.workspaceRoot);
            await this.pageRankGraphBuilder.init();
            const existingChunks = await this.store.getChunksByFile(filePath);
            await this.store.deleteChunksByFile(filePath);
            const relPath = this.toRepoRelativePath(filePath);
            await this.storagePipeline.deleteFile(relPath);
            if (existingChunks.length > 0) {
                await this.bm25Store.deleteChunksByIds(existingChunks.map(c => c.id));
            }
            const ingester = await this.getAdrIngester();
            if (ingester.isAdrFile(filePath, this.workspaceRoot)) {
                await ingester.processDelete(filePath, 'local-repo', this.workspaceRoot);
            }
            deleteFileHash(filePath);
            this.manifestStore.removeEntry(relPath);
            await this.manifestStore.save();
            
            this.symbolIndex.removeSymbolsByFile(filePath);
            await this.symbolIndex.save(this.repoguideDir);
            
            await this.pageRankGraphBuilder.removeFile(filePath);
            const allPaths = await this.store.getAllFilePaths();
            await this.pageRankGraphBuilder.buildGraph(allPaths);
            
            setTimeout(async () => {
                try {
                    await this.communityClustering.clusterAndSummarize();
                } catch (e) {
                    this.context.logger.appendLine(`[Warn] Community clustering failed: ${e}`);
                }
            }, 5000);
            
            if (this.comprehensionEngine) {
                await this.comprehensionEngine.handleFileChange(filePath);
            }

            // Remove annotation hash tracking for deleted file
            this.hashTracker.removeFile(filePath);
            await this.hashTracker.save();

            await updateSyncTime(this.repoguideDir);
            this.statusBar.setSynced();
        } catch (e) {
            this.context.logger.appendLine(`[Error] Failed to delete chunks for ${filePath}: ${e}`);
        }
    }

    private toRepoRelativePath(filePath: string): string {
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.workspaceRoot, filePath);
        return path.relative(this.workspaceRoot, absolutePath).replace(/\\/g, '/');
    }
}

function createLogicalUnitDiagnostics(): {
    total: number;
    roles: Record<string, number>;
    types: Record<string, number>;
    parseStatus: Record<string, number>;
    extractionMethods: Record<string, number>;
} {
    return {
        total: 0,
        roles: {},
        types: {},
        parseStatus: {},
        extractionMethods: {}
    };
}

function updateLogicalUnitDiagnostics(
    diagnostics: ReturnType<typeof createLogicalUnitDiagnostics>,
    units: LogicalUnit[]
): void {
    diagnostics.total += units.length;
    for (const unit of units) {
        increment(diagnostics.roles, unit.role);
        increment(diagnostics.types, unit.type);
        increment(diagnostics.parseStatus, unit.parseStatus);
        increment(diagnostics.extractionMethods, unit.extractionMethod);
    }
}

function increment(counts: Record<string, number>, key: string): void {
    counts[key] = (counts[key] ?? 0) + 1;
}

function formatCounts(counts: Record<string, number>): string {
    return Object.entries(counts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}:${value}`)
        .join(',');
}
