import * as fs from 'fs';
import * as path from 'path';
import * as moduleObj from 'module';

function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = {
        workspace: {
            workspaceFolders: [],
            getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback })
        },
        window: {
            createOutputChannel: () => ({ appendLine: console.error, show: () => undefined, dispose: () => undefined })
        },
        Uri: {
            file: (fsPath: string) => ({ fsPath }),
            joinPath: (base: any, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) })
        }
    };
    moduleObj.Module.prototype.require = function patchedRequire(id: string) {
        if (id === 'vscode') return shim;
        return originalRequire.apply(this, arguments as any);
    };
}
installVscodeShim();

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool
} from '@modelcontextprotocol/sdk/types.js';

import { ComprehensionEngine } from '../comprehension/comprehensionEngine.js';
import { QueryDispatcher } from '../query/queryDispatcher.js';
import { ConversationHistory } from '../query/conversationHistory.js';
import { LogicalUnitBm25Store } from '../store/logicalUnitBm25Store.js';
import { IntentClassifier } from '../query/intentClassifier.js';
import { HybridRetrievalFusion } from '../query/hybridRetrievalFusion.js';
import { HybridRetrievalProvider } from '../query/hybridRetrievalProvider.js';
import { RetrievalOrchestrator } from '../query/retrievalOrchestrator.js';
import { ExecutionPlanner } from '../query/executionPlanner.js';
import { Bm25Store } from '../store/bm25Store.js';
import { ImportGraphSearcher } from '../comprehension/importGraphSearcher.js';
import { SymbolIndex } from '../indexing/symbolIndex.js';
import { LanceStore } from '../store/lanceStore.js';
import { LogicalUnitStore } from '../store/logicalUnitStore.js';
import { FactStore } from '../store/factStore.js';
import { ProgramGraphStore } from '../store/programGraphStore.js';
import { IndexManifestStore } from '../indexing/indexManifest.js';
import { getProfile } from '../config/performanceConfig.js';
import { FileAnnotationEngine } from '../comprehension/fileAnnotationEngine.js';
import { Logger, RepositoryContext } from '../context/repositoryContext.js';
import { DatabaseSync } from 'node:sqlite';
import { RepositoryBrainStore } from '../query/repositoryBrainStore.js';
import { RepositoryBrain } from '../query/repositoryBrain.js';
import { RepositoryBrainProvider } from '../query/repositoryBrainProvider.js';
import { RepositoryBrainOrchestrator, BrainBuilders } from '../orchestrator/repositoryBrainOrchestrator.js';
import { OrchestratorStore } from '../orchestrator/orchestratorStore.js';
import { AuthorExpertiseBuilder } from '../ownership/authorExpertiseBuilder.js';
import { AuthorExpertiseStore } from '../ownership/authorExpertiseStore.js';
import { LogicalCouplingBuilder } from '../evolution/logicalCouplingBuilder.js';
import { LogicalCouplingStore } from '../evolution/logicalCouplingStore.js';
import { DriftBuilder } from '../drift/driftBuilder.js';
import { KnowledgeHotspotBuilder } from '../hotspots/knowledgeHotspotBuilder.js';
import { KnowledgeValidityBuilder } from '../validity/knowledgeValidityBuilder.js';
import { KnowledgeValidityStore } from '../validity/knowledgeValidityStore.js';
import { EvolutionBuilder } from '../evolution/evolutionBuilder.js';
import { EvolutionStore } from '../evolution/evolutionStore.js';
import { TestCoverageBuilder } from '../coverage/testCoverageBuilder.js';
import { TestCoverageStore } from '../coverage/testCoverageStore.js';
import { DecisionOutcomeBuilder } from '../outcomes/decisionOutcomeBuilder.js';
import { DecisionOutcomeStore } from '../outcomes/decisionOutcomeStore.js';
import { CausalReasoningBuilder } from '../causal/causalReasoningBuilder.js';
import { CausalReasoningStore } from '../causal/causalReasoningStore.js';
import { IncidentBuilder } from '../incidents/incidentBuilder.js';
import { IncidentEventStore } from '../incidents/incidentEventStore.js';
import { IncidentIntelligenceBuilder } from '../incidents/incidentIntelligenceBuilder.js';
import { IncidentIntelligenceStore } from '../incidents/incidentIntelligenceStore.js';
import { ChangeImpactBuilder } from '../changeImpact/changeImpactBuilder.js';
import { ChangeImpactStore } from '../changeImpact/changeImpactStore.js';
import { PredictionAccountabilityBuilder } from '../accountability/predictionAccountabilityBuilder.js';
import { PredictionAccountabilityStore } from '../accountability/predictionAccountabilityStore.js';

import { FactStoreProvider } from '../query/factStoreProvider.js';
import { LogicalUnitStoreProvider } from '../query/logicalUnitStoreProvider.js';
import { ProgramGraphProvider } from '../query/programGraphProvider.js';
import { SymbolIndexProvider } from '../query/symbolIndexProvider.js';
import { LanceStoreProvider } from '../query/lanceStoreProvider.js';
import { BM25Provider } from '../query/bm25Provider.js';
import { getRepositoryArtifactPaths } from '../preparation/repositoryPaths.js';
import { assertRepositoryReady, buildRepositoryReadinessReport, writeRepositoryReadinessReport } from '../preparation/repositoryReadiness.js';

async function main() {
    // 1. Parse arguments
    const args = process.argv.slice(2);
    let workspaceRoot = '';
    let repoguideDir = '';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--workspaceRoot' && i + 1 < args.length) {
            workspaceRoot = args[++i];
        } else if (args[i] === '--repoguideDir' && i + 1 < args.length) {
            repoguideDir = args[++i];
        }
    }

    if (!workspaceRoot || !repoguideDir) {
        console.error('Usage: node mcpServer.js --workspaceRoot <path> --repoguideDir <path>');
        process.exit(1);
    }

    // 2. Mock Logger and Context
    const mcpLogger: Logger = {
        appendLine: (msg) => console.error(`[RepoGuide] ${msg}`),
        debug: (msg) => console.error(`[RepoGuide DEBUG] ${msg}`),
        info: (msg) => console.error(`[RepoGuide INFO] ${msg}`),
        warn: (msg) => console.error(`[RepoGuide WARN] ${msg}`),
        error: (msg) => console.error(`[RepoGuide ERROR] ${msg}`),
        stageStart: () => {},
        stageProgress: () => {},
        stageComplete: () => {},
        stageFailed: () => {},
        artifactWritten: () => {},
        queryLog: () => {},
        repairLog: () => {}
    };

    const context: RepositoryContext = {
        workspaceRoot: workspaceRoot,
        repoguideDataDir: repoguideDir,
        getConfig: <T>(key: string, defaultValue?: T) => {
            if (key === 'queryArchitecture') return 'evidence' as any;
            return defaultValue as T;
        },
        asRelativePath: (p: string) => path.relative(workspaceRoot, p),
        logger: mcpLogger,
        notifyInfo: async () => {},
        notifyWarning: async () => {},
        notifyError: async () => {}
    };

    // 3. Initialize Stores & Searchers
    mcpLogger.info('Initializing RepoGuide data stores...');
    const artifactPaths = getRepositoryArtifactPaths(workspaceRoot, repoguideDir);
    const readinessReport = await buildRepositoryReadinessReport(workspaceRoot, repoguideDir);
    await writeRepositoryReadinessReport(readinessReport);
    assertRepositoryReady(readinessReport);
    
    const store = new LanceStore(artifactPaths.lanceDbDir);
    await store.init();

    const unitStore = new LogicalUnitStore(repoguideDir);
    await unitStore.init(workspaceRoot);

    const factStore = new FactStore(repoguideDir);
    await factStore.init(workspaceRoot);

    const symbolIndex = new SymbolIndex();
    symbolIndex.setLogger(mcpLogger);
    const symbolsPath = path.join(repoguideDir, 'symbols.json');
    if (fs.existsSync(symbolsPath)) {
        await symbolIndex.load(repoguideDir);
    }

    // OutputChannel for comprehensionEngine is expected to have appendLine
    const mockOutputChannel = {
        name: 'RepoGuide',
        append: () => {},
        appendLine: (msg: string) => mcpLogger.info(msg),
        replace: () => {},
        clear: () => {},
        show: () => {},
        hide: () => {},
        dispose: () => {}
    };
    const comprehensionEngine = new ComprehensionEngine(mockOutputChannel as any, repoguideDir);
    await comprehensionEngine.loadExisting(workspaceRoot);

    const importGraphSearcher = new ImportGraphSearcher();
    importGraphSearcher.load(repoguideDir);

    const history = new ConversationHistory();
    const ollamaUrl = 'http://localhost:11434';
    const profile = getProfile();
    const intentClassifier = new IntentClassifier(ollamaUrl, profile.planningModel, context);

    const bm25Store = new Bm25Store(repoguideDir);
    await bm25Store.init();

    const luBm25Store = new LogicalUnitBm25Store(repoguideDir);
    await luBm25Store.init();

    const canonicalFusion = new HybridRetrievalFusion(
        store,
        bm25Store,
        repoguideDir,
        workspaceRoot,
        intentClassifier,
        context,
        symbolIndex,
        importGraphSearcher,
        comprehensionEngine,
        history
    );
    const programGraphStore = new ProgramGraphStore();
    await programGraphStore.load(workspaceRoot);

    const symbolIndexProvider = new SymbolIndexProvider(symbolIndex);
    const factStoreProvider = new FactStoreProvider(factStore);
    const logicalUnitStoreProvider = new LogicalUnitStoreProvider(unitStore);
    const programGraphProvider = new ProgramGraphProvider(programGraphStore);
    const hybridRetrievalProvider = new HybridRetrievalProvider(canonicalFusion, { emitEvidenceItems: true });

    // RepositoryBrain: shared sqlite db for both the unified repository_knowledge table and
    // the domain builders' own detail tables. MCP is a facade over the canonical engine (Part 5):
    // it queries the store the VS Code extension's background rebuild already populated, and
    // only kicks off a rebuild itself, fire-and-forget, if one has never completed.
    const repositoryBrainDb = new DatabaseSync(artifactPaths.repositoryBrainDb);
    const repositoryBrainStore = new RepositoryBrainStore(repositoryBrainDb);
    const repositoryBrain = new RepositoryBrain(repositoryBrainStore);
    const repositoryBrainProvider = new RepositoryBrainProvider(repositoryBrain);

    const orchestratorStore = new OrchestratorStore(repositoryBrainDb);
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
    if (!orchestratorStore.getState()) {
        mcpLogger.info('No prior RepositoryBrain rebuild found; kicking off a background rebuild.');
        void repositoryBrainOrchestrator.runFullRebuild().catch(error =>
            mcpLogger.error(`RepositoryBrain background rebuild failed: ${error instanceof Error ? error.message : String(error)}`)
        );
    }

    const lanceStoreProvider = new LanceStoreProvider(store);
    const bm25Provider = new BM25Provider(bm25Store);
    await symbolIndexProvider.initialize({ repositoryContext: context });
    await factStoreProvider.initialize({ repositoryContext: context });
    await logicalUnitStoreProvider.initialize({ repositoryContext: context });
    await programGraphProvider.initialize({ repositoryContext: context });
    await hybridRetrievalProvider.initialize({ repositoryContext: context });
    await repositoryBrainProvider.initialize({ repositoryContext: context });
    await lanceStoreProvider.initialize({ repositoryContext: context });
    await bm25Provider.initialize({ repositoryContext: context });
    const retrievalOrchestrator = new RetrievalOrchestrator([
        symbolIndexProvider,
        factStoreProvider,
        logicalUnitStoreProvider,
        programGraphProvider,
        hybridRetrievalProvider,
        repositoryBrainProvider,
        lanceStoreProvider,
        bm25Provider
    ]);
    const executionPlanner = new ExecutionPlanner(context);

    const manifestStore = new IndexManifestStore(repoguideDir);
    await manifestStore.init();

    const queryDispatcher = new QueryDispatcher(history, {
        unitStore,
        factStore,
        bm25Store: luBm25Store,
        manifestStore,
        programGraphStore,
        annotationStore: new FileAnnotationEngine(repoguideDir, workspaceRoot, context),
        communityStore: repoguideDir
    }, context, {
        executionPlanner,
        retrievalOrchestrator,
        client: 'mcp'
    });

    mcpLogger.info('Initialization complete. Starting MCP server...');

    // 4. Set up MCP Server
    const server = new Server(
        {
            name: "repoguide",
            version: "0.0.1"
        },
        {
            capabilities: {
                tools: {}
            }
        }
    );

    const TOOLS: Tool[] = [
        {
            name: "ask_repoguide",
            description: "Ask a question about the codebase. Uses the full RepoGuide retrieval, planning, and reasoning pipeline to return a grounded answer.",
            inputSchema: {
                type: "object",
                properties: {
                    question: { type: "string", description: "The user's question about the repository." }
                },
                required: ["question"]
            }
        },
        {
            name: "retrieve_raw_evidence",
            description: "Retrieve raw code chunks, annotations, and community summaries without generating an answer.",
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "string", description: "The query to search for." },
                    seedFiles: { type: "array", items: { type: "string" }, description: "Optional seed files to prioritize." }
                },
                required: ["query"]
            }
        },
        {
            name: "get_dependents",
            description: "Find files that depend on or import a specific symbol or file.",
            inputSchema: {
                type: "object",
                properties: {
                    symbol: { type: "string", description: "The symbol to find dependents for." }
                },
                required: ["symbol"]
            }
        },
        {
            name: "get_facts",
            description: "Retrieve structured facts extracted from the codebase.",
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "string", description: "The term or query to match against facts." }
                },
                required: ["query"]
            }
        }
    ];

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return { tools: TOOLS };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
            switch (request.params.name) {
                case "ask_repoguide": {
                    const question = request.params.arguments?.question as string;
                    if (!question) throw new Error("Missing 'question' argument");

                    let confidenceData: any = null;
                    const generator = queryDispatcher.query(question, undefined, async (conf) => {
                        confidenceData = conf;
                    });
                    
                    let answer = '';
                    let metadata: any = null;

                    for await (const token of generator) {
                        const trimmed = token.trim();
                        if (trimmed.startsWith('{"__type":"healthCaveat"')) continue;
                        if (trimmed.startsWith('{"__type":"answerMetadata"')) {
                            try { metadata = JSON.parse(trimmed); } catch {}
                            continue;
                        }
                        if (trimmed.startsWith('{"__type":"answerProvenance"')) continue;
                        if (trimmed.startsWith('{"__type":"shadowContext"')) continue;
                        
                        answer += token;
                    }

                    // Parse embedded citations
                    const citations: any[] = [];
                    const cleanAnswer = answer.replace(/___CITE___(.*?)\|(.*?)\|(.*?)\|(.*?)___CITE_END___/g, (match, file, startLineStr, endLineStr, display) => {
                        const line_start = parseInt(startLineStr, 10);
                        const line_end = parseInt(endLineStr, 10);
                        citations.push({
                            file,
                            line_start: isNaN(line_start) ? undefined : line_start,
                            line_end: isNaN(line_end) ? undefined : line_end,
                            display
                        });
                        return display;
                    });

                    // Merge with file_references from metadata
                    if (metadata?.metadata?.file_references) {
                        for (const ref of metadata.metadata.file_references) {
                            if (!citations.some(c => c.file === ref.file && c.line_start === ref.line_start)) {
                                citations.push(ref);
                            }
                        }
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    answer: cleanAnswer,
                                    citations: citations,
                                    confidence: confidenceData
                                }, null, 2)
                            }
                        ]
                    };
                }

                case "retrieve_raw_evidence": {
                    // Routed through QueryDispatcher's canonical mode:'raw_evidence' path
                    // (ExecutionPlanner -> RetrievalOrchestrator, no synthesis/gate) instead
                    // of calling HybridRetrievalProvider directly — this is a strict
                    // evidence upgrade, since the orchestrator also invokes
                    // fact_store/symbol_index/program_graph providers for the same query.
                    const query = request.params.arguments?.query as string;
                    const seedFiles = (request.params.arguments?.seedFiles as string[]) ?? [];
                    if (!query) throw new Error("Missing 'query' argument");
                    const items = await queryDispatcher.retrieveRawEvidence(query, { seedFiles });

                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({ items }, null, 2)
                            }
                        ]
                    };
                }

                case "get_dependents": {
                    // Forces symbol_index + program_graph regardless of how the bare
                    // symbol string would otherwise classify — ProgramGraphStore.getDependents()
                    // (via ProgramGraphProvider) already covers caller/reader/importer/
                    // instantiator/fallback-consumer relationships, the same data
                    // ImportGraphSearcher.getBlastRadius() provided directly before.
                    const symbol = request.params.arguments?.symbol as string;
                    if (!symbol) throw new Error("Missing 'symbol' argument");

                    const items = await queryDispatcher.retrieveRawEvidence(symbol, {
                        targetSymbols: [symbol],
                        forceProviderIds: ['symbol_index', 'program_graph']
                    });
                    const matchedSymbolItem = items.find(item => item.retrieval_signal === 'graph_symbol_node') ?? items[0];
                    const dependentItems = items.filter(item =>
                        item.retrieval_signal === 'graph_caller_dependency' ||
                        item.retrieval_signal === 'graph_reader_dependency' ||
                        item.retrieval_signal === 'graph_import_dependency' ||
                        item.retrieval_signal === 'graph_instantiation_dependency' ||
                        item.retrieval_signal === 'graph_fallback_dependency'
                    );

                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    targetFile: matchedSymbolItem?.file,
                                    matchedSymbol: matchedSymbolItem,
                                    dependentFiles: Array.from(new Set(dependentItems.map(item => item.file)))
                                }, null, 2)
                            }
                        ]
                    };
                }

                case "get_facts": {
                    // Forces fact_store; FactStoreProvider.retrieve() already covers both
                    // symbol-lookup and general fact-scoring, matching this tool's prior
                    // two-step findBySymbol/findExactValue behavior.
                    const query = request.params.arguments?.query as string;
                    if (!query) throw new Error("Missing 'query' argument");

                    const items = await queryDispatcher.retrieveRawEvidence(query, {
                        forceProviderIds: ['fact_store']
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({ facts: items }, null, 2)
                            }
                        ]
                    };
                }

                default:
                    throw new Error(`Unknown tool: ${request.params.name}`);
            }
        } catch (error: any) {
            mcpLogger.error(`Error in tool ${request.params.name}: ${error.message}`);
            return {
                isError: true,
                content: [{ type: "text", text: `Error: ${error.message}` }]
            };
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    mcpLogger.info('MCP server is running and listening on stdin/stdout.');
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
