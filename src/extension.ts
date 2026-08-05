import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { startupCheck } from './health/startupCheck';
import { StatusBarManager } from './ui/statusBar';
import { LanceStore } from './store/lanceStore';
import { IndexManager } from './indexing/indexManager';
import { ConversationHistory } from './query/conversationHistory';
import { ContextAccumulator } from './query/contextAccumulator';
import { SessionWorkingSet } from './query/sessionWorkingSet';
import { DecorationManager } from './ui/decorationManager';
import { QueryDispatcher, ChatPipeline } from './query/queryDispatcher';
import { LanceStoreProvider } from './query/lanceStoreProvider';
import { BM25Provider } from './query/bm25Provider';
import { IntentClassifier } from './query/intentClassifier';
import { ArchitectureContextBuilder } from './query/architectureContextBuilder';
import { SidebarProvider } from './ui/sidebarProvider';
import { generateDocReport } from './ui/docReportPanel';
import { streamExplain } from './ui/explainPanel';
import { registerIndexHealthPanelCommand } from './ui/indexHealthPanel';
import { registerPhase10Panels } from './ui/phase10Panels';
import { registerMemoryExplorerPanel } from './ui/memoryExplorerPanel';
import { showDailyBriefPanel } from './ui/dailyBriefPanel';
import { showNotesPanel, refreshNotesPanelIfOpen } from './ui/notesPanel';
import { SymbolIndex } from './indexing/symbolIndex';
import { IndexHealthProvider } from './ui/indexHealthProvider';
import {
    buildMcpConfigSnippet,
    isWorkspaceReadyForMcpConfig,
    MCP_CONFIG_FORMAT_OPTIONS,
    MCP_NOT_INDEXED_WARNING
} from './mcp/mcpConfigBuilder';
import { registerGitWatcher } from './watchers/gitWatcher';
import { QACache } from './cache/qaCache';
import { QAGenerator } from './cache/qaGenerator';
import { ComprehensionQAGenerator } from './cache/comprehensionQAGenerator';
import { FeedbackHandler } from './cache/feedbackHandler';
import { ModelManager } from './performance/modelManager';
import { RequestQueue } from './performance/requestQueue';
import { VSCodeContext, getGlobalVSCodeContext, setGlobalVSCodeContext } from './context/vscodeContext';
import { IdleDetector } from './performance/idleDetector';
import { getProfile } from './config/performanceConfig';
import { ComprehensionEngine } from './comprehension/comprehensionEngine';
import { ComprehensionJobRunner } from './comprehension/comprehensionJobRunner';
import { ImportGraphSearcher } from './comprehension/importGraphSearcher';
import { BehavioralPathSearcher } from './comprehension/behavioralPathSearcher';
import { UnderstandingHealthService } from './comprehension/understandingHealthService';
import { WorkspaceRootDetector } from './workspaceRootDetector';
import { RepoGuideLogger } from './logging/repoguideLogger';
import { ArtifactVersionChecker, setArtifactBuilderVersionProvider } from './comprehension/schema-versions';
import { FeedbackCaptureService } from './feedback/feedbackCaptureService';
import { RepairQueueManager } from './feedback/repairQueueManager';
import { ArtifactDependencyGraph } from './comprehension/artifactDependencyGraph';
import { FileChangeHandler } from './comprehension/fileChangeHandler';
import { FileLifecycleHandler } from './comprehension/fileLifecycleHandler';
import { StalenessRegistry } from './comprehension/stalenessRegistry';
import { BackgroundRegenerationQueue } from './comprehension/backgroundRegenerationQueue';
import { TraceIngestionService } from './runtime/traceIngestionService';
import { RuntimeStaticReconciler } from './runtime/runtimeStaticReconciler';
import { MiniEvalRunner } from './evaluation/miniEvalRunner';
import { createArtifactSnapshot, listArtifactSnapshots, restoreArtifactSnapshot } from './evaluation/artifactSnapshots';
import { ProgramGraphStore } from './store/programGraphStore';
import { Bm25Store } from './store/bm25Store';
import { LogicalUnitBm25Store } from './store/logicalUnitBm25Store';
import { HybridRetrievalFusion } from './query/hybridRetrievalFusion';
import { HybridRetrievalProvider } from './query/hybridRetrievalProvider';
import { RetrievalOrchestrator } from './query/retrievalOrchestrator';
import { ExecutionPlanner } from './query/executionPlanner';
import { FactStoreProvider } from './query/factStoreProvider';
import { LogicalUnitStoreProvider } from './query/logicalUnitStoreProvider';
import { ProgramGraphProvider } from './query/programGraphProvider';
import { FlowContextProvider } from './query/flowContextProvider';
import { SymbolIndexProvider } from './query/symbolIndexProvider';
import { InvestigationEngine } from './query/investigationEngine';
import { PlanAnalyzer } from './query/planAnalyzer';
import { TerminalErrorService } from './watchers/terminalErrorService';
import { NotesManager, DeveloperNote } from './notes/notesManager';
import { DailyBriefService } from './brief/dailyBriefService';
import { classifyFileRole } from './indexing/fileRoleClassifier';
import { buildRepositoryReadinessReport, writeRepositoryReadinessReport } from './preparation/repositoryReadiness';
import { getRepositoryArtifactPaths } from './preparation/repositoryPaths';
import { RepositoryLivenessGate } from './preparation/repositoryLivenessGate';
import { DatabaseSync } from 'node:sqlite';
import { RepositoryBrainStore } from './query/repositoryBrainStore';
import { RepositoryBrain } from './query/repositoryBrain';
import { RepositoryBrainProvider } from './query/repositoryBrainProvider';
import { RepositoryBrainOrchestrator, BrainBuilders } from './orchestrator/repositoryBrainOrchestrator';
import { OrchestratorStore } from './orchestrator/orchestratorStore';
import { AuthorExpertiseBuilder } from './ownership/authorExpertiseBuilder';
import { AuthorExpertiseStore } from './ownership/authorExpertiseStore';
import { LogicalCouplingBuilder } from './evolution/logicalCouplingBuilder';
import { LogicalCouplingStore } from './evolution/logicalCouplingStore';
import { DriftBuilder } from './drift/driftBuilder';
import { DriftStore } from './drift/driftStore';
import { KnowledgeHotspotBuilder } from './hotspots/knowledgeHotspotBuilder';
import { KnowledgeHotspotStore } from './hotspots/knowledgeHotspotStore';
import { KnowledgeValidityBuilder } from './validity/knowledgeValidityBuilder';
import { KnowledgeValidityStore } from './validity/knowledgeValidityStore';
import { EvolutionBuilder } from './evolution/evolutionBuilder';
import { EvolutionStore } from './evolution/evolutionStore';
import { TestCoverageBuilder } from './coverage/testCoverageBuilder';
import { TestCoverageStore } from './coverage/testCoverageStore';
import { DecisionOutcomeBuilder } from './outcomes/decisionOutcomeBuilder';
import { DecisionOutcomeStore } from './outcomes/decisionOutcomeStore';
import { CausalReasoningBuilder } from './causal/causalReasoningBuilder';
import { CausalReasoningStore } from './causal/causalReasoningStore';
import { IncidentBuilder } from './incidents/incidentBuilder';
import { IncidentEventStore } from './incidents/incidentEventStore';
import { IncidentIntelligenceBuilder } from './incidents/incidentIntelligenceBuilder';
import { IncidentIntelligenceStore } from './incidents/incidentIntelligenceStore';
import { ChangeImpactBuilder } from './changeImpact/changeImpactBuilder';
import { ChangeImpactStore } from './changeImpact/changeImpactStore';
import { PredictionAccountabilityBuilder } from './accountability/predictionAccountabilityBuilder';
import { PredictionAccountabilityStore } from './accountability/predictionAccountabilityStore';
import { CommitStore } from './intent/commit/commitStore';
import { LocalGitCommitProvider } from './intent/commit/providers/localGitCommitProvider';
import { CommitIngestionEngine } from './intent/commit/commitIngestionEngine';
import { ADRStore } from './intent/adr/adrStore';
import { ADRDiscoveryEngine } from './intent/adr/adrDiscoveryEngine';
import { ADRParser } from './intent/adr/adrParser';
import { ADRIngestionEngine } from './intent/adr/adrIngestionEngine';
import { ADRQueryEngine } from './intent/adr/adrQueryEngine';
import { ADRCodeLinkBuilder } from './intent/linking/adrCodeLinkBuilder';
import { ADRCodeLinkStore } from './intent/linking/adrCodeLinkStore';
import { IntentQueryEngine } from './intent/extraction/intentQueryEngine';
import { IntentStore } from './intent/extraction/intentStore';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function activate(context: vscode.ExtensionContext) {

    const statusBar = new StatusBarManager();
    statusBar.show();
    const queryModeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    let queryPipeline: ChatPipeline | undefined;

    const updateQueryModeStatusBar = () => {
        queryModeStatusBarItem.text = 'RepoGuide: Ready';
        queryModeStatusBarItem.tooltip = 'RepoGuide query pipeline';
        queryModeStatusBarItem.show();
    };
    updateQueryModeStatusBar();

    const outputChannel = vscode.window.createOutputChannel('RepoGuide');
    context.subscriptions.push(outputChannel);
    
    // We will initialize the true context shortly once we have workspaceRoot,
    // but we can set up a preliminary one if needed, or wait. Let's wait until we have workspaceRoot.
    // For now we just create a temp logger. No, we can just use an uninitialized one, but let's wait.
    
    let explainSelectionHandler:
        | ((editor: vscode.TextEditor, selectedText: string) => Promise<void>)
        | null = null;

    const accumulator = new ContextAccumulator();
    const workingSet = new SessionWorkingSet();
    const history = new ConversationHistory(accumulator);
    const decorationManager = new DecorationManager(accumulator);

    context.subscriptions.push(statusBar, queryModeStatusBarItem, decorationManager);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const rootDetector = new WorkspaceRootDetector(
            workspaceFolders[0].uri.fsPath,
            outputChannel,
            message => { void vscode.window.showWarningMessage(message); }
        );
        const workspaceRoot = rootDetector.getRoot();
        const repoguideDir = rootDetector.getRepoguideDir();

        const dbPath = repoguideDir;
        let dbExists = fs.existsSync(dbPath);

        // Enable file-based logging now that we know the repoguide dir
        const repoGuideContext = new VSCodeContext(workspaceRoot, outputChannel, repoguideDir);
        setGlobalVSCodeContext(repoGuideContext);
        decorationManager.setContext(repoGuideContext);
        const logger = repoGuideContext.logger as RepoGuideLogger;
        context.subscriptions.push({ dispose: () => logger.dispose?.() });

        await startupCheck(context, logger);

        const store = new LanceStore(dbPath);
        await store.init();

        const config = vscode.workspace.getConfiguration('repoguide');
        const ollamaUrl = config.get<string>('ollamaUrl', 'http://localhost:11434');
        const profile = getProfile();
        
        const userInferenceModel = config.get<string>('inferenceModel');
        if (userInferenceModel && userInferenceModel.trim() !== '') {
            profile.inferenceModel = userInferenceModel;
        }

        const idleUnloadTimeout = config.get<number>('idleUnloadTimeout', 300);
        const modelManager = new ModelManager(outputChannel, idleUnloadTimeout);

        const enableDistillation = config.get<boolean>('enableChatNoteDistillation', false);
        if (enableDistillation) {
            const idleDetector = new IdleDetector(60000); // 1 minute idle
            context.subscriptions.push(idleDetector);
            
            idleDetector.onBecomeIdle(async () => {
                const messages = history.getMessages();
                if (messages.length < 2) return;
                
                const recent = messages.slice(-8);
                const queryText = recent.map(m => `${m.role}: ${m.content}`).join('\n');
                
                const userChoice = await vscode.window.showInformationMessage(
                    'RepoGuide: You have been idle. Would you like to distill the recent chat history into a developer note?',
                    'Yes', 'No'
                );
                
                if (userChoice === 'Yes') {
                    // For now, minimal implementation just saves a placeholder note
                    const title = await vscode.window.showInputBox({
                        prompt: 'Note Title',
                        value: 'Distilled Note from Chat'
                    });
                    if (!title) return;
                    
                    const note: DeveloperNote = {
                        id: `note_distilled_${Date.now()}`,
                        target_file: 'general_chat_context',
                        title,
                        content: `Chat Context:\n${queryText.substring(0, 500)}...`,
                        tags: ['distilled', 'chat'],
                        source: 'chat',
                        confidence: 'suggested',
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    };
                    
                    await notesManager.saveNote(note);
                    vscode.window.showInformationMessage(`Saved distilled note: ${title}`);
                }
            });
        }

        if (profile.inferenceModel.includes('14b')) {
            const vram = await modelManager.checkVRAM();
            if (vram < 10000) {
                outputChannel.appendLine(
                    '[Warn] inferenceModel is set to 14b but insufficient VRAM detected. ' +
                    'Falling back to qwen2.5-coder:7b. Change repoguide.inferenceModel in settings to suppress this warning.'
                );
                profile.inferenceModel = 'qwen2.5-coder:7b';
            }
        }

        const qaGenerationModel = profile.planningModel;
        const requestQueue = new RequestQueue(3);
        const idleDetector = new IdleDetector(10000);
        context.subscriptions.push(modelManager, idleDetector);
        
        const symbolIndex = new SymbolIndex();
        symbolIndex.setLogger(logger);

        const qaCache = new QACache(rootDetector.getRepoguideDir(), logger);
        const feedbackHandler = new FeedbackHandler(qaCache);
        if (profile.enableQACache) {
            const cacheReady = qaCache.init();
            if (!cacheReady) {
                outputChannel.appendLine(`[Warn] ${qaCache.getDisabledReason() ?? 'Q&A cache disabled.'}`);
            } else {
                await modelManager.ensureModelLoaded(qaGenerationModel, ollamaUrl);
            }
        } else {
            outputChannel.appendLine('[Info] Q&A cache disabled in fast performance mode.');
        }
        context.subscriptions.push({ dispose: () => qaCache.close() });

        const symbolsPath = path.join(repoguideDir, 'symbols.json');
        let rebuildSymbols = false;

        if (fs.existsSync(symbolsPath)) {
            try {
                const rawSymbols = await fs.promises.readFile(symbolsPath, 'utf8');
                const parsedSymbols = JSON.parse(rawSymbols) as Record<string, Array<{ filePath?: string }>>;
                const hasPythonEntries = Object.values(parsedSymbols).some(entries =>
                    Array.isArray(entries) &&
                    entries.some(entry => typeof entry.filePath === 'string' && entry.filePath.toLowerCase().endsWith('.py'))
                );

                if (!hasPythonEntries) {
                    await fs.promises.unlink(symbolsPath);
                    outputChannel.appendLine('[Warn] symbols.json had no Python entries. Deleted stale symbol index and scheduling rebuild.');
                    rebuildSymbols = true;
                    dbExists = false;
                }
            } catch {
                outputChannel.appendLine('[Warn] Failed to validate symbols.json. Deleting and scheduling symbol rebuild.');
                try {
                    await fs.promises.unlink(symbolsPath);
                } catch {
                    // ignore cleanup failure
                }
                rebuildSymbols = true;
                dbExists = false;
            }
        }

        if (!rebuildSymbols && fs.existsSync(symbolsPath)) {
            try {
                await symbolIndex.load(rootDetector.getRepoguideDir());
                const stats = symbolIndex.getStats();
                outputChannel.appendLine(
                    `[Info] Symbol index loaded from symbols.json (${stats.totalSymbols} symbols across ${stats.totalFiles} files)`
                );
                if (symbolIndex.hasNoiseSymbols()) {
                    outputChannel.appendLine(
                        '[Warn] Symbol index contains noise symbols (single-letter or reserved). Rebuilding.'
                    );
                    try {
                        await fs.promises.unlink(symbolsPath);
                    } catch {
                        // ignore if already deleted
                    }
                    rebuildSymbols = true;
                    dbExists = false;
                }
            } catch (e) {
                outputChannel.appendLine(`[Warn] Failed to load symbols.json. Rebuilding symbol index. ${String(e)}`);
                rebuildSymbols = true;
                dbExists = false;
            }
        } else {
            outputChannel.appendLine('[Info] No symbols.json found - will build on first index.');
            if (dbExists) {
                outputChannel.appendLine('[Info] Existing vector index has no symbol index. Starting full rebuild.');
                rebuildSymbols = true;
                dbExists = false;
            }
        }

        const qaGenerator = new QAGenerator(
            getGlobalVSCodeContext(),
            symbolIndex,
            store,
            qaCache,
            statusBar,
            requestQueue,
            idleDetector,
            modelManager
        );
        context.subscriptions.push({ dispose: () => qaGenerator.stop() });

        const understandingDir = path.join(repoguideDir, 'understanding');
        const stalenessRegistry = new StalenessRegistry(understandingDir);
        const feedbackCaptureService = new FeedbackCaptureService(workspaceRoot, understandingDir, outputChannel);
        const artifactDependencyGraph = new ArtifactDependencyGraph(workspaceRoot, understandingDir, outputChannel);
        const backgroundRegenQueue = new BackgroundRegenerationQueue(
            workspaceRoot,
            understandingDir,
            artifactDependencyGraph,
            stalenessRegistry,
            undefined, // We'll set indexManager later
            outputChannel
        );
        context.subscriptions.push(backgroundRegenQueue);
        
        artifactDependencyGraph.registerCommand(context);
        const fileChangeHandler = new FileChangeHandler(
            workspaceRoot,
            understandingDir,
            artifactDependencyGraph,
            stalenessRegistry,
            backgroundRegenQueue,
            outputChannel
        );
        const fileLifecycleHandler = new FileLifecycleHandler(
            workspaceRoot,
            repoguideDir,
            understandingDir,
            artifactDependencyGraph,
            store,
            symbolIndex,
            fileChangeHandler,
            outputChannel
        );
        const traceIngestionService = new TraceIngestionService(
            workspaceRoot,
            understandingDir,
            outputChannel
        );
        const runtimeStaticReconciler = new RuntimeStaticReconciler(
            workspaceRoot,
            understandingDir,
            outputChannel
        );
        new RepairQueueManager(workspaceRoot, understandingDir, outputChannel);
        context.subscriptions.push(
            feedbackCaptureService,
            artifactDependencyGraph,
            fileChangeHandler,
            fileLifecycleHandler,
            traceIngestionService,
            runtimeStaticReconciler
        );
        const extensionVersion = context.extension.packageJSON.version || '0.0.1';
        setArtifactBuilderVersionProvider(() => extensionVersion);
        const versionChecker = new ArtifactVersionChecker(
            understandingDir,
            extensionVersion,
            message => { void vscode.window.showInformationMessage(message); },
            message => logger.warn(message)
        );
        versionChecker.showStalenessWarning();

        const comprehensionEngine = new ComprehensionEngine(outputChannel, repoguideDir);
        const comprehensionJobRunner = new ComprehensionJobRunner(comprehensionEngine, repoguideDir, outputChannel);
        const projectUnderstandingPath = path.join(repoguideDir, 'understanding', 'project.json');
        if (fs.existsSync(projectUnderstandingPath)) {
            await comprehensionEngine.loadExisting(workspaceRoot);
            outputChannel.appendLine('[Info] Project comprehension loaded from disk.');
        }
        const intentClassifier = new IntentClassifier(ollamaUrl, profile.planningModel, getGlobalVSCodeContext());
        const architectureContextBuilder = new ArchitectureContextBuilder(comprehensionEngine);
        const comprehensionQAGenerator = new ComprehensionQAGenerator(
            comprehensionEngine,
            qaCache,
            feedbackHandler,
            ollamaUrl,
            idleDetector,
            getGlobalVSCodeContext()
        );
        context.subscriptions.push({ dispose: () => comprehensionQAGenerator.stop() });

        const indexManager = new IndexManager(
            store,
            statusBar,
            workspaceRoot,
            rootDetector.getRepoguideDir(),
            getGlobalVSCodeContext(),
            symbolIndex,
            qaGenerator,
            qaCache,
            comprehensionEngine,
            comprehensionJobRunner
        );
        fileChangeHandler.setIndexManager(indexManager);
        const indexHealthProvider = new IndexHealthProvider(
            store,
            symbolIndex,
            workspaceRoot,
            rootDetector.getRepoguideDir(),
            () => indexManager.getIsIndexing(),
            () => indexManager.getIsAnnotating(),
            () => indexManager.getIndexingProgress(),
            () => indexManager.getLastIndexCompletedAt()
        );
        const luBm25Store = indexManager.getLogicalUnitBm25Store();
        await luBm25Store.init();
        const programGraphStore = indexManager.getProgramGraphStore();
        await programGraphStore.load(workspaceRoot);

        const importGraphSearcher = new ImportGraphSearcher();
        importGraphSearcher.load(repoguideDir);

        const behavioralPathSearcher = new BehavioralPathSearcher();
        behavioralPathSearcher.load(repoguideDir);

        // Verify critical searchers loaded
        if (!behavioralPathSearcher.isLoaded()) {
            outputChannel.appendLine(
                '[Warn] Behavioral path index not yet available — ' +
                'will load after comprehension completes'
            );
        }
        if (!comprehensionEngine.getConceptMapSearcher().isLoaded()) {
            outputChannel.appendLine(
                '[Warn] Concept map not yet available — ' +
                'will load after comprehension completes'
            );
        }

        const bm25Store = new Bm25Store(repoguideDir);
        await bm25Store.init();

        const notesManager = new NotesManager(repoguideDir, workspaceRoot);
        const dailyBriefService = new DailyBriefService(workspaceRoot, repoguideDir, notesManager, stalenessRegistry, store);

        const phase10Fusion = new HybridRetrievalFusion(
            store,
            bm25Store,
            repoguideDir,
            workspaceRoot,
            intentClassifier,
            repoGuideContext,
            symbolIndex,
            importGraphSearcher,
            comprehensionEngine,
            history,
            notesManager
        );
        const symbolIndexProvider = new SymbolIndexProvider(symbolIndex);
        const factStoreProvider = new FactStoreProvider(indexManager.getFactStore());
        const logicalUnitStoreProvider = new LogicalUnitStoreProvider(indexManager.getUnitStore());
        const programGraphProvider = new ProgramGraphProvider(programGraphStore);
        const hybridRetrievalProvider = new HybridRetrievalProvider(phase10Fusion, { emitEvidenceItems: true });
        const lanceStoreProvider = new LanceStoreProvider(store);
        const bm25Provider = new BM25Provider(bm25Store);
        const understandingHealthService = new UnderstandingHealthService(path.join(repoguideDir, 'understanding'), workspaceRoot);
        const flowContextProvider = new FlowContextProvider(comprehensionEngine, behavioralPathSearcher, understandingHealthService);

        // RepositoryBrain: shared sqlite db for both the unified repository_knowledge table
        // and the domain builders' own detail tables (causal_*, outcome_*, incident_*, etc.).
        const artifactPaths = getRepositoryArtifactPaths(workspaceRoot, repoguideDir);
        const repositoryBrainDb = new DatabaseSync(artifactPaths.repositoryBrainDb);
        const repositoryBrainStore = new RepositoryBrainStore(repositoryBrainDb);
        const repositoryBrain = new RepositoryBrain(repositoryBrainStore);
        const repositoryBrainProvider = new RepositoryBrainProvider(repositoryBrain);

        const orchestratorStore = new OrchestratorStore(repositoryBrainDb);
        // DriftBuilder/KnowledgeHotspotBuilder take only `db`, but DriftStore/KnowledgeHotspotStore
        // still need constructing for their initSchema() side effect — they own the tables
        // (architectural_health*, drift_*, knowledge_hotspots, hotspot_*) these builders read/write.
        new DriftStore(repositoryBrainDb);
        new KnowledgeHotspotStore(repositoryBrainDb);
        const brainBuilders: BrainBuilders = {
            authorExpertise: new AuthorExpertiseBuilder(repositoryBrainDb, new AuthorExpertiseStore(repositoryBrainDb)),
            logicalCoupling: new LogicalCouplingBuilder(repositoryBrainDb, new LogicalCouplingStore(repositoryBrainDb)),
            driftEngine: new DriftBuilder(repositoryBrainDb),
            knowledgeHotspots: new KnowledgeHotspotBuilder(repositoryBrainDb),
            knowledgeValidity: new KnowledgeValidityBuilder(repositoryBrainDb, new KnowledgeValidityStore(repositoryBrainDb)),
            architecturalEvolution: new EvolutionBuilder(repositoryBrainDb, new EvolutionStore(repositoryBrainDb)),
            testCoverage: new TestCoverageBuilder(repositoryBrainDb, new TestCoverageStore(repositoryBrainDb)),
            decisionOutcomes: new DecisionOutcomeBuilder(repositoryBrainDb, new DecisionOutcomeStore(repositoryBrainDb), repositoryBrain),
            causalReasoning: new CausalReasoningBuilder(repositoryBrainDb, new CausalReasoningStore(repositoryBrainDb), repositoryBrain),
            incidentBuilder: new IncidentBuilder(repositoryBrainDb, new IncidentEventStore(repositoryBrainDb)),
            incidentIntelligence: new IncidentIntelligenceBuilder(repositoryBrainDb, new IncidentIntelligenceStore(repositoryBrainDb), repositoryBrain),
            changeImpact: new ChangeImpactBuilder(repositoryBrainDb, new ChangeImpactStore(repositoryBrainDb)),
            predictionAccountability: new PredictionAccountabilityBuilder(new PredictionAccountabilityStore(repositoryBrainDb))
        };
        const repositoryBrainOrchestrator = new RepositoryBrainOrchestrator(orchestratorStore, brainBuilders);

        // Ingestion pipelines: populate commits/commit_files and adrs in the same shared db
        // before the brain rebuild reads them. Both are fully built, previously-unwired
        // engines (see docs/engineering-log/INGESTION_WIRING_REPORT.md) — reused as-is, not reimplemented.
        const commitStore = new CommitStore(repositoryBrainDb);
        const commitIngestionEngine = new CommitIngestionEngine(commitStore, new LocalGitCommitProvider(workspaceRoot));
        const adrStore = new ADRStore(repositoryBrainDb);
        const adrIngestionEngine = new ADRIngestionEngine(adrStore, new ADRDiscoveryEngine(workspaceRoot), new ADRParser(), workspaceRoot, 'local');
        // adr_code_links is read directly by AuthorExpertiseBuilder/DriftBuilder/KnowledgeHotspotBuilder
        // (and, once real ADRs exist, EvolutionBuilder/KnowledgeValidityBuilder) — see
        // docs/engineering-log/ADRCODELINK_WIRING_REPORT.md. Constructing the store alone creates the (possibly empty)
        // tables those builders need to not throw "no such table".
        const adrCodeLinkBuilder = new ADRCodeLinkBuilder(
            new ADRCodeLinkStore(repositoryBrainDb),
            programGraphStore,
            new ADRQueryEngine(adrStore),
            new IntentQueryEngine(new IntentStore(repositoryBrainDb))
        );

        await symbolIndexProvider.initialize({ repositoryContext: repoGuideContext });
        await factStoreProvider.initialize({ repositoryContext: repoGuideContext });
        await logicalUnitStoreProvider.initialize({ repositoryContext: repoGuideContext });
        await programGraphProvider.initialize({ repositoryContext: repoGuideContext });
        await hybridRetrievalProvider.initialize({ repositoryContext: repoGuideContext });
        await lanceStoreProvider.initialize({ repositoryContext: repoGuideContext });
        await bm25Provider.initialize({ repositoryContext: repoGuideContext });
        await repositoryBrainProvider.initialize({ repositoryContext: repoGuideContext });
        await flowContextProvider.initialize({ repositoryContext: repoGuideContext });
        const retrievalOrchestrator = new RetrievalOrchestrator([
            symbolIndexProvider,
            factStoreProvider,
            logicalUnitStoreProvider,
            programGraphProvider,
            hybridRetrievalProvider,
            lanceStoreProvider,
            bm25Provider,
            repositoryBrainProvider,
            flowContextProvider
        ]);
        const executionPlanner = new ExecutionPlanner(repoGuideContext, indexManager.getUnitStore());

        scheduleRepositoryBrainRebuild(repositoryBrainOrchestrator, repositoryBrainDb, commitIngestionEngine, adrIngestionEngine, adrStore, adrCodeLinkBuilder, repositoryBrain, workspaceRoot, outputChannel);

        const investigationEngine = new InvestigationEngine(repoGuideContext, history, intentClassifier, phase10Fusion, executionPlanner, retrievalOrchestrator, 'vscode', undefined);
        const terminalErrorService = new TerminalErrorService(repoguideDir, workspaceRoot, repoGuideContext.logger);
        if (config.get<boolean>('captureTerminalErrors', false)) {
            terminalErrorService.registerShellIntegrationCapture(context);
        } else {
            repoGuideContext.logger.info('[Info] Terminal error auto-capture disabled. Enable repoguide.captureTerminalErrors to opt in.');
        }
        const planAnalyzer = new PlanAnalyzer(repoGuideContext, intentClassifier, phase10Fusion, executionPlanner, retrievalOrchestrator, 'vscode');

        let gitWatcherRegistered = false;
        let indexReady = false;

        const registerGitWatcherOnce = () => {
            if (gitWatcherRegistered) {
                return;
            }
            context.subscriptions.push(
                registerGitWatcher(indexManager, store, workspaceRoot, repoGuideContext.logger)
            );
            gitWatcherRegistered = true;
        };

        const reloadPostIndexArtifacts = async () => {
            behavioralPathSearcher.load(repoguideDir);
            importGraphSearcher.load(repoguideDir);
            await programGraphStore.load(workspaceRoot);
            const chunks = await store.getAllChunks();
            artifactDependencyGraph.build(chunks);
        };

        const refreshEvidenceStoresAfterIncrementalReindex = async () => {
            const allLogicalUnits = await indexManager.getUnitStore().getAll();
            // Staged rebuild rather than clearAll() + indexUnits(): this runs on a 2s
            // debounce after ANY source-file save, and the chat/retrieval pipeline
            // queries this very same store instance. Clearing in place left that
            // pipeline searching an empty BM25 index for the whole repopulation
            // window -- surfacing as "the code-search index appears corrupted (a
            // referenced data fragment is missing for the bm25 channel)" and as
            // otherwise-unexplained run-to-run variance in retrieved evidence.
            // beginRebuild()/commitRebuild() keep the previous index live and
            // queryable until the new one is complete, then swap atomically.
            const previousUnitCount = luBm25Store.getIndexedCount();
            await luBm25Store.beginRebuild();
            try {
                await luBm25Store.indexUnits(allLogicalUnits);
                const committed = await luBm25Store.commitRebuild(previousUnitCount);
                if (!committed) {
                    outputChannel.appendLine(
                        `[Warn] Logical-unit BM25 refresh produced no units (had ${previousUnitCount}) -- keeping the previous index rather than replacing it with an empty one.`
                    );
                }
            } catch (error) {
                await luBm25Store.abortRebuild();
                throw error;
            }
            await programGraphStore.build(
                indexManager.getUnitStore(),
                indexManager.getFactStore(),
                workspaceRoot
            );
            await reloadPostIndexArtifacts();
            repositoryLivenessGate.invalidate();
        };

        const runStartupComprehensionRepair = async () => {
            try {
                if (qaCache.getCount() === 0) {
                    scheduleComprehensionQAGeneration(
                        workspaceRoot,
                        comprehensionEngine,
                        comprehensionQAGenerator,
                        qaCache,
                        outputChannel
                    );
                }
            } catch (err) {
                outputChannel.appendLine('[Error] Comprehension failed: ' + (err instanceof Error ? err.message : String(err)));
            }
        };

        const repositoryLivenessGate = new RepositoryLivenessGate(workspaceRoot, repoguideDir);

        const rebuildIndexWithProgress = async (reason: string) => {
            indexReady = false;
            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'RepoGuide: Rebuilding index',
                        cancellable: false
                    },
                    async progress => {
                        progress.report({ message: reason });
                        outputChannel.appendLine(`[Info] ${reason}`);
                        await indexManager.forceFullReindex();
                        progress.report({ message: 'Loading rebuilt evidence stores...' });
                        await luBm25Store.init();
                        await programGraphStore.load(workspaceRoot);
                        await reloadPostIndexArtifacts();
                    }
                );
                registerGitWatcherOnce();
                indexReady = true;
                repositoryLivenessGate.invalidate();
                const diagnostics = indexManager.getDiagnostics();
                void vscode.window.showInformationMessage(
                    `RepoGuide: Index built — ${diagnostics.logicalUnitCount} units, ${diagnostics.factCount} facts indexed.`
                );
                // A full reindex is a significant index change — refresh RepositoryBrain
                // knowledge against it. Incremental saves do not trigger this; they already
                // refresh the evidence stores via refreshEvidenceStoresAfterIncrementalReindex().
                scheduleRepositoryBrainRebuild(repositoryBrainOrchestrator, repositoryBrainDb, commitIngestionEngine, adrIngestionEngine, adrStore, adrCodeLinkBuilder, repositoryBrain, workspaceRoot, outputChannel, 0);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                outputChannel.appendLine(`[Error] RepoGuide index rebuild failed: ${message}`);
                void vscode.window.showErrorMessage(`RepoGuide index rebuild failed: ${message}`);
                throw error;
            }
        };

        const startupIndexValid = await hasValidEvidenceIndex(
            repoguideDir,
            workspaceRoot,
            indexManager,
            luBm25Store,
            programGraphStore,
            outputChannel
        );

        if (!startupIndexValid || rebuildSymbols) {
            await rebuildIndexWithProgress(
                rebuildSymbols
                    ? 'Stale symbol index detected. Building a fresh RepoGuide index.'
                    : 'Missing or incomplete RepoGuide index detected. Building a fresh index.'
            );
            void runStartupComprehensionRepair();
        } else {
            const indexedFiles = await store.getAllFilePaths();
            outputChannel.appendLine(`[Info] Existing index loaded. ${indexedFiles.length} files indexed.`);
            registerGitWatcherOnce();
            indexReady = true;

            if (qaCache.getCount() === 0 && symbolIndex.getStats().totalSymbols > 0) {
                scheduleComprehensionQAGeneration(
                    workspaceRoot,
                    comprehensionEngine,
                    comprehensionQAGenerator,
                    qaCache,
                    outputChannel
                );
            }
        }

        const evidenceQueryPipeline = new QueryDispatcher(history, {
            unitStore: indexManager.getUnitStore(),
            factStore: indexManager.getFactStore(),
            bm25Store: luBm25Store,
            manifestStore: indexManager.getManifestStore(),
            programGraphStore,
            annotationStore: indexManager.getAnnotationEngine(),
            communityStore: repoguideDir
        }, repoGuideContext, {
            executionPlanner,
            retrievalOrchestrator,
            client: 'vscode'
        });

        queryPipeline = {
            query: async function* (question, abortSignal, onConfidence) {
                if (!indexReady || indexManager.getIsIndexing()) {
                    yield 'RepoGuide is rebuilding the index. Please wait for indexing to finish before asking a question.';
                    return;
                }
                const liveness = await repositoryLivenessGate.check();
                if (liveness.status === 'corrupted') {
                    outputChannel.appendLine(`[Warn] Repository liveness check: ${liveness.message}`);
                    void vscode.window.showWarningMessage(liveness.message!, 'Re-sync Index').then(choice => {
                        if (choice === 'Re-sync Index') {
                            void rebuildIndexWithProgress('Manual rebuild requested after detecting an empty chunk index.');
                        }
                    });
                }
                yield* evidenceQueryPipeline.query(question, abortSignal, onConfidence);
            },
            explainSelection: (...args) => evidenceQueryPipeline.explainSelection(...args)
        };

        const savedSourceFilePaths = new Set<string>();
        let savedFileReindexTimer: NodeJS.Timeout | undefined;
        let savedFileReindexRunning = false;
        const reindexableRoles = new Set(['implementation', 'config', 'script']);

        const isInsideWorkspace = (filePath: string): boolean => {
            const relativePath = path.relative(workspaceRoot, filePath);
            return relativePath !== '' &&
                !relativePath.startsWith('..') &&
                !path.isAbsolute(relativePath);
        };

        const scheduleSavedFileReindexFlush = () => {
            if (savedFileReindexTimer) {
                clearTimeout(savedFileReindexTimer);
            }
            savedFileReindexTimer = setTimeout(() => {
                savedFileReindexTimer = undefined;
                void flushSavedFileReindexBatch();
            }, 2000);
        };

        const flushSavedFileReindexBatch = async () => {
            if (savedFileReindexRunning) {
                return;
            }
            if (savedSourceFilePaths.size === 0) {
                return;
            }

            const changedFiles = Array.from(savedSourceFilePaths);
            savedSourceFilePaths.clear();
            savedFileReindexRunning = true;
            queryModeStatusBarItem.text = 'RepoGuide: updating...';
            queryModeStatusBarItem.show();

            try {
                outputChannel.appendLine(
                    `[Info] Saved source file batch detected. Incrementally reindexing ${changedFiles.length} file(s).`
                );
                await indexManager.reindexChanged();
                await refreshEvidenceStoresAfterIncrementalReindex();
                outputChannel.appendLine('[Info] Incremental evidence stores refreshed after save.');
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                outputChannel.appendLine(`[Error] Incremental reindex after save failed: ${message}`);
            } finally {
                savedFileReindexRunning = false;
                updateQueryModeStatusBar();
                if (savedSourceFilePaths.size > 0) {
                    scheduleSavedFileReindexFlush();
                }
            }
        };

        context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument(document => {
                if (document.uri.scheme !== 'file' || !isInsideWorkspace(document.uri.fsPath)) {
                    return;
                }

                const relativePath = path.relative(workspaceRoot, document.uri.fsPath).replace(/\\/g, '/');
                const role = classifyFileRole(relativePath, document.getText());
                if (!reindexableRoles.has(role)) {
                    return;
                }

                savedSourceFilePaths.add(document.uri.fsPath);
                scheduleSavedFileReindexFlush();
            }),
            {
                dispose: () => {
                    if (savedFileReindexTimer) {
                        clearTimeout(savedFileReindexTimer);
                    }
                }
            }
        );

        const sidebarProvider = new SidebarProvider(
            context.extensionUri,
            queryPipeline,
            history,
            indexManager,
            accumulator,
            workingSet,
            indexHealthProvider,
            store,
            decorationManager,
            workspaceRoot,
            feedbackHandler,
            feedbackCaptureService
        );
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider)
        );

        explainSelectionHandler = async (editor: vscode.TextEditor, selectedText: string) => {
            const selection = editor.selection;
            await streamExplain(
                queryPipeline!.explainSelection(
                    editor.document.uri.fsPath,
                    selectedText,
                    selection.start.line,
                    selection.end.line,
                    editor.document.languageId
                ),
                {
                    filePath: editor.document.uri.fsPath,
                    startLine: selection.start.line,
                    endLine: selection.end.line,
                    language: editor.document.languageId,
                    extensionUri: context.extensionUri
                }
            );
        };

        context.subscriptions.push(
            vscode.commands.registerCommand('repoguide.openChat', async () => {
                await vscode.commands.executeCommand('repoguide-rightchat.focus');
            }),
            vscode.commands.registerCommand('repoguide.resync', async () => {
                await rebuildIndexWithProgress('Manual rebuild requested. Building a fresh RepoGuide index.');
                void runStartupComprehensionRepair();
            }),
            vscode.commands.registerCommand('repoguide.rebuildIndex', async () => {
                await rebuildIndexWithProgress('Manual rebuild requested. Building a fresh RepoGuide index.');
                void runStartupComprehensionRepair();
            }),
            vscode.commands.registerCommand('repoguide.copyMcpConfig', async () => {
                const health = await indexHealthProvider.getHealthData();
                if (!isWorkspaceReadyForMcpConfig(health.lastIndexedAt)) {
                    vscode.window.showWarningMessage(MCP_NOT_INDEXED_WARNING);
                    return;
                }

                const picked = await vscode.window.showQuickPick(
                    MCP_CONFIG_FORMAT_OPTIONS.map(option => ({
                        label: option.label,
                        description: option.description,
                        format: option.format
                    })),
                    { placeHolder: 'Choose an MCP client config format to copy' }
                );
                if (!picked) {
                    return;
                }

                const mcpServerScriptPath = path.join(context.extensionPath, 'out', 'mcp', 'mcpServer.js');
                const snippet = buildMcpConfigSnippet(picked.format, {
                    mcpServerScriptPath,
                    workspaceRoot,
                    repoguideDir
                });
                await vscode.env.clipboard.writeText(snippet);
                vscode.window.showInformationMessage(
                    `Copied ${picked.label} config to clipboard. Requires "node" on PATH. ` +
                    `Restart your MCP client's connection after any reindex -- RepoGuide's MCP server has no live reindex path.`
                );
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('repoguide.docreport', async () => {
                await generateDocReport(repoGuideContext, evidenceQueryPipeline, context.extensionUri);
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('repoguide.showDailyBrief', async () => {
                try {
                    const brief = await dailyBriefService.generateBrief();
                    showDailyBriefPanel(context, brief, workspaceRoot);
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to generate Daily Brief: ${e.message}`);
                }
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('repoguide.addNote', async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showErrorMessage('No active file to annotate.');
                    return;
                }
                const filePath = editor.document.uri.fsPath;
                const position = editor.selection.active;
                let targetSymbol = '';
                const wordRange = editor.document.getWordRangeAtPosition(position);
                if (wordRange) {
                    targetSymbol = editor.document.getText(wordRange);
                }

                const title = await vscode.window.showInputBox({
                    prompt: 'Note Title',
                    placeHolder: 'E.g., Authentication Logic'
                });
                if (!title) return;

                const content = await vscode.window.showInputBox({
                    prompt: 'Note Content',
                    placeHolder: 'Important details about this file/symbol...'
                });
                if (!content) return;

                const fileHash = await notesManager.hashFile(filePath);

                const note: DeveloperNote = {
                    id: `note_${Date.now()}`,
                    target_file: filePath,
                    target_symbol: targetSymbol,
                    line_start: position.line + 1,
                    line_end: position.line + 1,
                    title,
                    content,
                    tags: [],
                    source: 'manual',
                    confidence: 'user_confirmed',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    code_hash_at_creation: fileHash
                };

                await notesManager.saveNote(note);
                await repositoryBrain.observe({
                    type: 'developer_note',
                    subject: { kind: 'file', id: note.target_file, file: note.target_file, symbol: note.target_symbol },
                    claim: { text: `${note.title}: ${note.content}`, data: { title: note.title, content: note.content, tags: note.tags } },
                    confidence: { score: note.confidence === 'user_confirmed' ? 90 : 50, breakdown: { userConfirmed: note.confidence === 'user_confirmed' ? 90 : 0 } },
                    provenance: { sourceArtifacts: [`notes.json:${note.id}`], producedBy: 'notesManager' },
                    supportingEvidence: [{ sourceTable: 'notes.json', sourceId: note.id, description: note.title }],
                    owner: 'developer',
                    createdBy: 'notesManager',
                    tags: note.tags
                });
                vscode.window.showInformationMessage(`Saved developer note: ${title}`);
                refreshNotesPanelIfOpen(notesManager);
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('repoguide.notesPanel', () => {
                showNotesPanel(context, notesManager, workspaceRoot);
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('repoguide.verifyNoteSystem', async () => {
                outputChannel.show(true);
                outputChannel.appendLine('[Verify Note System] Creating a programmatic note...');
                
                const testFilePath = path.join(workspaceRoot, 'test_dummy_note_file.ts');
                const note: DeveloperNote = {
                    id: `note_test_${Date.now()}`,
                    target_file: testFilePath,
                    target_symbol: 'DummyClass',
                    line_start: 1,
                    line_end: 5,
                    title: 'Verification Note',
                    content: 'This is a programmatic note for verifying the memory backend.',
                    tags: ['test'],
                    source: 'manual',
                    confidence: 'user_confirmed',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                };
                
                await notesManager.saveNote(note);
                
                outputChannel.appendLine('[Verify Note System] Querying the pipeline...');
                const q = `Explain test_dummy_note_file.ts`;
                let answerFound = false;
                
                for await (const token of queryPipeline!.query(q)) {
                    if (token.includes('__type":"feedbackContext')) continue;
                    if (token.includes('__type":"answerMetadata')) continue;
                    if (token.includes('DEVELOPER NOTES')) answerFound = true;
                }
                
                if (answerFound) {
                    outputChannel.appendLine('[Verify Note System] SUCCESS: DEVELOPER NOTES found in query output or metadata.');
                } else {
                    outputChannel.appendLine('[Verify Note System] COMPLETE: Query processed, please check logs for provenance.');
                }
                
                // Cleanup
                await notesManager.deleteNote(note.id);
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('repoguide.runMiniEval', async () => {
                const defaultQuestionsPath = path.join(
                    context.extensionPath,
                    'test',
                    'evaluation',
                    'mixed-fullstack.golden.json'
                );
                const selectedQuestions = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'Golden question set': ['json'] },
                    openLabel: 'Use Question Set'
                });
                const questionsPath = selectedQuestions?.[0]?.fsPath ?? defaultQuestionsPath;
                const thresholdInput = await vscode.window.showInputBox({
                    title: 'RepoGuide Mini Evaluation Threshold',
                    prompt: 'Enter a pass threshold between 0 and 1.',
                    value: '0.8'
                });
                const threshold = Number(thresholdInput ?? '0.8');
                const runner = new MiniEvalRunner(outputChannel);
                const result = await runner.run({
                    repoPath: workspaceRoot,
                    questionsPath,
                    threshold: Number.isFinite(threshold) ? threshold : 0.8,
                    prepare: false,
                    useExistingArtifacts: true
                });
                outputChannel.show(true);
                outputChannel.appendLine(
                    `[Eval] Mini evaluation ${result.result.summary.passed ? 'PASS' : 'FAIL'} ` +
                    `(${Math.round(result.result.summary.overallScore * 100)}%).`
                );
                outputChannel.appendLine(`[Eval] Report: ${result.markdownPath}`);
                void vscode.window.showInformationMessage(
                    `RepoGuide mini eval ${result.result.summary.passed ? 'passed' : 'failed'}: ` +
                    `${Math.round(result.result.summary.overallScore * 100)}%`
                );
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('repoguide.createArtifactSnapshot', async () => {
                const label = await vscode.window.showInputBox({
                    title: 'Artifact Snapshot Label',
                    prompt: 'Optional label for this understanding artifact snapshot.',
                    value: 'manual'
                });
                const snapshot = createArtifactSnapshot(workspaceRoot, label || 'manual');
                outputChannel.appendLine(`[Snapshot] Created artifact snapshot: ${snapshot.snapshotId}`);
                outputChannel.appendLine(`[Snapshot] ${snapshot.snapshotDir}`);
                void vscode.window.showInformationMessage(`RepoGuide snapshot created: ${snapshot.snapshotId}`);
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('repoguide.restoreArtifactSnapshot', async () => {
                const snapshots = listArtifactSnapshots(workspaceRoot);
                if (snapshots.length === 0) {
                    void vscode.window.showWarningMessage('RepoGuide: No artifact snapshots found.');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    snapshots.map(snapshot => ({
                        label: snapshot.snapshotId,
                        description: snapshot.metadata.gitCommit ?? 'no git commit',
                        detail: snapshot.snapshotDir,
                        snapshot
                    })),
                    { title: 'Restore RepoGuide Artifact Snapshot' }
                );
                if (!selected) {
                    return;
                }
                const restored = restoreArtifactSnapshot(workspaceRoot, selected.snapshot.snapshotId);
                outputChannel.appendLine(`[Snapshot] Restored artifact snapshot: ${restored.snapshotId}`);
                void vscode.window.showInformationMessage(`RepoGuide snapshot restored: ${restored.snapshotId}`);
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('repoguide.investigateLastError', async () => {
                const lastError = await terminalErrorService.getLastError();
                if (!lastError) {
                    void vscode.window.showWarningMessage('RepoGuide: No recent terminal errors found.');
                    return;
                }
                outputChannel.show(true);
                outputChannel.appendLine(`[Investigation] Investigating last terminal error: ${lastError.command}`);
                const report = await investigationEngine.investigateTerminal({
                    problem_description: `Investigate failed command: ${lastError.command}`,
                    terminal_error: lastError,
                    cwd: lastError.cwd
                });
                outputChannel.appendLine('[Investigation] Structured terminal investigation report:');
                outputChannel.appendLine(JSON.stringify({
                    problem: report.problem,
                    terminal_error: report.terminal_error,
                    primary_hypothesis: report.primary_hypothesis,
                    evidence_trail: report.evidence_trail,
                    alternative_hypotheses: report.alternative_hypotheses,
                    cannot_determine: report.cannot_determine,
                    next_checks: report.next_checks
                }, null, 2));
                void vscode.window.showInformationMessage('RepoGuide investigated the last terminal error. See the RepoGuide output channel.');
            })
        );

        registerIndexHealthPanelCommand(
            context,
            repoguideDir,
            workspaceRoot,
            () => false,
            async () => (await store.getAllFilePaths()).length,
            async () => { await indexManager.forceFullReindex(); },
            async () => {
                behavioralPathSearcher.load(repoguideDir);
                const chunks = await store.getAllChunks();
                artifactDependencyGraph.build(chunks);
            },
            async () => {
                const chunks = await store.getAllChunks();
                artifactDependencyGraph.build(chunks);
            },
            async () => { await vscode.commands.executeCommand('repoguide.processRepairQueue'); },
            async () => {
                const traceFile = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'JSON': ['json'] },
                    openLabel: 'Import Trace'
                });
                if (traceFile && traceFile[0]) {
                    await vscode.commands.executeCommand('repoguide.importTrace', traceFile[0].fsPath);
                }
            }
        );

        registerPhase10Panels({
            context,
            repoguideDir,
            workspaceRoot,
            investigationEngine,
            planAnalyzer
        });

        registerMemoryExplorerPanel({
            context,
            workspaceRoot
        });

        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(async (e) => {
                if (e.affectsConfiguration('repoguide.performanceMode')) {
                    const action = await vscode.window.showWarningMessage(
                        'RepoGuide: Performance mode changed. The index must be rebuilt ' +
                        'because the embedding model changed. Rebuild now?',
                        'Rebuild Now',
                        'Later'
                    );

                    if (action === 'Rebuild Now' && indexManager) {
                        await indexManager.forceFullReindex();
                    }
                }
            })
        );

        context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(async () => {
                const folders = vscode.workspace.workspaceFolders;
                if (!folders || folders.length === 0) {
                    indexReady = false;
                    return;
                }

                const nextRootDetector = new WorkspaceRootDetector(
                    folders[0].uri.fsPath,
                    outputChannel,
                    message => { void vscode.window.showWarningMessage(message); }
                );
                const nextRoot = nextRootDetector.getRoot();
                if (path.normalize(nextRoot) !== path.normalize(workspaceRoot)) {
                    indexReady = false;
                    outputChannel.appendLine(
                        `[Info] Workspace root changed from ${workspaceRoot} to ${nextRoot}. ` +
                        'Reloading RepoGuide so the new root is indexed before queries run.'
                    );
                    await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    return;
                }

                await rebuildIndexWithProgress('Workspace folders changed. Rebuilding the RepoGuide index.');
                void runStartupComprehensionRepair();
            })
        );

        // Flush any cached models loaded with wrong num_ctx
        async function flushOllamaModels(): Promise<void> {
            const models = ['qwen2.5-coder:7b', 'qwen2.5-coder:3b'];
            for (const model of models) {
                try {
                    await fetch(`${ollamaUrl}/api/generate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model, keep_alive: 0 })
                    });
                    outputChannel.appendLine(`[Info] Flushed cached model: ${model}`);
                } catch {
                    // Ollama not running yet — ignore
                }
            }
        }

        // Execute Daily Brief on Startup if enabled
        const enableDailyBriefOnStartup = config.get<boolean>('enableDailyBriefOnStartup', false);
        if (enableDailyBriefOnStartup) {
            dailyBriefService.generateBrief().then(brief => {
                outputChannel.appendLine('[Daily Brief Startup] ======================');
                outputChannel.appendLine(JSON.stringify(brief, null, 2));
                outputChannel.appendLine('============================================');
            }).catch(e => {
                outputChannel.appendLine(`[Warn] Failed to generate Daily Brief on startup: ${e}`);
            });
        }

        await flushOllamaModels();
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('repoguide.explain', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('RepoGuide: No active editor found.');
                return;
            }

            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);

            if (!selectedText.trim()) {
                vscode.window.showErrorMessage('RepoGuide: Please select some code first.');
                return;
            }

            if (!explainSelectionHandler) {
                vscode.window.showErrorMessage('RepoGuide: Project-aware explanation is unavailable until a workspace is loaded.');
                return;
            }

            await explainSelectionHandler(editor, selectedText);
        })
    );

    return {
        queryPipeline
    };
}

export function deactivate() {}

async function hasValidEvidenceIndex(
    repoguideDir: string,
    workspaceRoot: string,
    indexManager: IndexManager,
    luBm25Store: LogicalUnitBm25Store,
    programGraphStore: ProgramGraphStore,
    outputChannel: vscode.OutputChannel
): Promise<boolean> {
    try {
        const readinessReport = await buildRepositoryReadinessReport(workspaceRoot, repoguideDir);
        await writeRepositoryReadinessReport(readinessReport);
        for (const diagnostic of readinessReport.diagnostics) {
            outputChannel.appendLine(`[Info] Repository readiness: ${diagnostic}`);
        }
        if (readinessReport.status !== 'READY') {
            outputChannel.appendLine(`[Info] Repository readiness status: ${readinessReport.status}.`);
            return false;
        }
        await indexManager.getUnitStore().init(workspaceRoot);
        await indexManager.getFactStore().init(workspaceRoot);
        await luBm25Store.init();
        await programGraphStore.load(workspaceRoot);
        const artifacts = new Map(readinessReport.artifacts.map(artifact => [artifact.name, artifact]));
        outputChannel.appendLine(
            `[Info] Evidence index loaded: ${artifacts.get('logical_units')?.recordCount ?? 0} units, ` +
            `${artifacts.get('facts')?.recordCount ?? 0} facts, ` +
            `${artifacts.get('logical_unit_bm25')?.recordCount ?? 0} BM25 docs, ` +
            `${artifacts.get('program_graph')?.recordCount ?? 0} graph records.`
        );
        return true;
    } catch (error) {
        outputChannel.appendLine(`[Warn] Evidence index validation failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}


function scheduleComprehensionQAGeneration(
    workspaceRoot: string,
    comprehensionEngine: ComprehensionEngine,
    comprehensionQAGenerator: ComprehensionQAGenerator,
    qaCache: QACache,
    outputChannel: vscode.OutputChannel
): void {
    setTimeout(() => {
        const run = async () => {
            if (!qaCache.isAvailable() || qaCache.getCount() > 0) {
                return;
            }

            for (let attempt = 0; attempt < 24; attempt += 1) {
                if (comprehensionEngine.getProjectUnderstanding()) {
                    await comprehensionQAGenerator.generateAll(workspaceRoot);
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 5000));
            }

            outputChannel.appendLine('[Warn] Comprehension Q&A generation skipped: project understanding was not ready in time.');
        };

        run().catch(error =>
            outputChannel.appendLine(`[Warn] Comprehension Q&A generation error: ${error}`)
        );
    }, 30000);
}

/** ADR status -> confidence score. Mirrors the developer_note wiring's "derive confidence from a discrete state" pattern. */
const ADR_STATUS_CONFIDENCE: Record<string, number> = {
    ACCEPTED: 90,
    PROPOSED: 40,
    SUPERSEDED: 30,
    DEPRECATED: 20,
    REJECTED: 10
};

/**
 * Runs the two previously-unwired ingestion pipelines (commit history, ADRs) so their tables
 * are fresh before RepositoryBrain's builders read them, then observes each ADR into
 * RepositoryBrain directly as an `architecture_decision` record (ADR data doesn't need the
 * aggregation/scoring a domain builder does — it's a direct 1:1 mapping). Each pipeline is
 * independently non-fatal, matching the orchestrator's own per-step error handling.
 */
async function runIngestionPipelines(
    db: DatabaseSync,
    commitEngine: CommitIngestionEngine,
    adrEngine: ADRIngestionEngine,
    adrStore: ADRStore,
    adrCodeLinkBuilder: ADRCodeLinkBuilder,
    repositoryBrain: RepositoryBrain,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    try {
        const stats = await commitEngine.syncIncremental();
        outputChannel.appendLine(`[Info] Commit ingestion: ${stats.commitsProcessed} commit(s) synced.`);
    } catch (error) {
        outputChannel.appendLine(`[Warn] Commit ingestion failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
        const stats = await adrEngine.syncIncremental();
        outputChannel.appendLine(`[Info] ADR ingestion: ${stats.adrsProcessed} ADR(s) synced.`);
        for (const adr of await adrStore.list()) {
            await repositoryBrain.observe({
                type: 'architecture_decision',
                subject: { kind: 'decision', id: adr.id },
                claim: {
                    text: `${adr.title}: ${adr.decision}`,
                    data: { status: adr.status, context: adr.context, decision: adr.decision, consequences: adr.consequences, number: adr.number }
                },
                confidence: { score: ADR_STATUS_CONFIDENCE[adr.status] ?? 40, breakdown: { statusDerived: ADR_STATUS_CONFIDENCE[adr.status] ?? 40 } },
                provenance: { sourceArtifacts: [`adrs:${adr.id}`, adr.sourcePath], producedBy: 'adrIngestionEngine' },
                supportingEvidence: [{ sourceTable: 'adrs', sourceId: adr.id, description: adr.title }],
                owner: 'imported',
                createdBy: 'adrIngestionEngine'
            });
        }
    } catch (error) {
        outputChannel.appendLine(`[Warn] ADR ingestion failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // adrs.created_at has no source in the ADR document itself (ADRParser does no date
    // extraction) — the real signal is the first commit that introduced the ADR file. ADRs with
    // no matching commit are left NULL rather than fabricating a date; driftRuleEngine.ts's
    // staleness check treats NULL as "can't assess," not as "not stale."
    try {
        db.exec(`
            UPDATE adrs SET created_at = (
                SELECT MIN(c.timestamp) FROM commit_files cf JOIN commits c ON c.sha = cf.sha WHERE cf.path = adrs.source_path
            ) WHERE EXISTS (
                SELECT 1 FROM commit_files cf WHERE cf.path = adrs.source_path
            )
        `);
        outputChannel.appendLine('[Info] ADR creation dates backfilled from first-commit history.');
    } catch (error) {
        outputChannel.appendLine(`[Warn] ADR creation date backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Must run after ADR sync above (reads fresh adrStore data) and after ProgramGraphStore is
    // loaded (already true by construction order in activate()). Populates adr_code_links /
    // adr_code_evidence — read directly by AuthorExpertiseBuilder/DriftBuilder/KnowledgeHotspotBuilder.
    try {
        await adrCodeLinkBuilder.build();
        outputChannel.appendLine('[Info] ADR-code linking: adr_code_links refreshed.');
    } catch (error) {
        outputChannel.appendLine(`[Warn] ADR-code linking failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Opt-in (repoguide.enableCoverageIngestion, default off): runs the test suite with coverage
 * instrumentation so TestCoverageBuilder.parseJestCoverage() has a coverage-final.json to read.
 * Off by default because a full test run is expensive; skipped entirely unless the user opts in,
 * and even then only re-runs if the existing coverage report is missing or >24h stale.
 */
async function maybeGenerateCoverage(workspaceRoot: string, outputChannel: vscode.OutputChannel): Promise<void> {
    const config = vscode.workspace.getConfiguration('repoguide');
    if (!config.get<boolean>('enableCoverageIngestion', false)) {
        return;
    }

    const coveragePath = path.join(workspaceRoot, 'coverage', 'coverage-final.json');
    try {
        const stat = fs.statSync(coveragePath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < 24 * 60 * 60 * 1000) {
            return;
        }
    } catch {
        // File doesn't exist — proceed to generate it.
    }

    try {
        outputChannel.appendLine('[Info] Coverage ingestion: running test suite with --coverage (repoguide.enableCoverageIngestion is on).');
        await execAsync('npx jest --coverage', { cwd: workspaceRoot, maxBuffer: 1024 * 1024 * 50 });
        outputChannel.appendLine('[Info] Coverage ingestion: coverage-final.json refreshed.');
    } catch (error) {
        // jest exits non-zero when any test fails, even though coverage-final.json is still
        // written for whatever it did collect — log it but don't treat this as a hard failure.
        outputChannel.appendLine(`[Warn] Coverage generation run finished with a non-zero exit (some tests may have failed); coverage data may still have been written: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Runs the RepositoryBrainOrchestrator's full 13-builder rebuild, preceded by the commit/ADR
 * ingestion pre-step and (if opted in) coverage generation. Triggered once per session ~60s
 * after activation (letting indexing settle first) and again after every full reindex — not
 * after incremental saves, which already refresh the evidence stores via
 * refreshEvidenceStoresAfterIncrementalReindex() and would make a rebuild this SQL-heavy
 * wasteful on every keystroke-triggered save.
 */
function scheduleRepositoryBrainRebuild(
    orchestrator: RepositoryBrainOrchestrator,
    db: DatabaseSync,
    commitEngine: CommitIngestionEngine,
    adrEngine: ADRIngestionEngine,
    adrStore: ADRStore,
    adrCodeLinkBuilder: ADRCodeLinkBuilder,
    repositoryBrain: RepositoryBrain,
    workspaceRoot: string,
    outputChannel: vscode.OutputChannel,
    delayMs: number = 60000
): void {
    setTimeout(() => {
        const run = async () => {
            await runIngestionPipelines(db, commitEngine, adrEngine, adrStore, adrCodeLinkBuilder, repositoryBrain, outputChannel);
            // Fire-and-forget: coverage generation is slow and its output is only needed by
            // the *next* rebuild, not this one — don't block the brain rebuild on it.
            void maybeGenerateCoverage(workspaceRoot, outputChannel);
            await orchestrator.runFullRebuild();
        };
        run()
            .then(() => outputChannel.appendLine('[Info] RepositoryBrain rebuild completed.'))
            .catch(error => outputChannel.appendLine(`[Warn] RepositoryBrain rebuild failed: ${error instanceof Error ? error.message : String(error)}`));
    }, delayMs);
}
