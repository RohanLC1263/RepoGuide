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
            createOutputChannel: () => ({ appendLine: console.log, show: () => undefined, dispose: () => undefined })
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

import * as vscode from 'vscode';
import { ComprehensionEngine } from '../comprehension/comprehensionEngine';
import { QueryDispatcher } from '../query/queryDispatcher';
import { ExecutionPlanner } from '../query/executionPlanner';
import { RetrievalOrchestrator } from '../query/retrievalOrchestrator';
import { SymbolIndexProvider } from '../query/symbolIndexProvider';
import { FactStoreProvider } from '../query/factStoreProvider';
import { LogicalUnitStoreProvider } from '../query/logicalUnitStoreProvider';
import { ProgramGraphProvider } from '../query/programGraphProvider';
import { FlowContextProvider } from '../query/flowContextProvider';
import { HybridRetrievalProvider } from '../query/hybridRetrievalProvider';
import { BehavioralPathSearcher } from '../comprehension/behavioralPathSearcher';
import { UnderstandingHealthService } from '../comprehension/understandingHealthService';
import { EvidenceQueryTelemetrySnapshot } from '../query/evidenceQueryTelemetry';
import { ConversationHistory } from '../query/conversationHistory';
import { LogicalUnitBm25Store } from '../store/logicalUnitBm25Store';
import { IntentClassifier } from '../query/intentClassifier';
import { HybridRetrievalFusion } from '../query/hybridRetrievalFusion';
import { Bm25Store } from '../store/bm25Store';
import { parseAllLocations } from '../query/responseParser';
import { ImportGraphSearcher } from '../comprehension/importGraphSearcher';
import { SymbolIndex } from '../indexing/symbolIndex';

import { LanceStore } from '../store/lanceStore';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { FactStore } from '../store/factStore';
import { ProgramGraphStore } from '../store/programGraphStore';
import { IndexManifestStore } from '../indexing/indexManifest';
import { getProfile } from '../config/performanceConfig';
import { resolveOllamaUrl, vscodeConfigReader } from '../health/ollamaUrlSafety';
import { FileAnnotationEngine } from '../comprehension/fileAnnotationEngine';
import { Logger, RepositoryContext } from '../context/repositoryContext';
import {
    CapturedContext,
    EvalControlEvents,
    GoldenQuestion,
    PipelineQuestionOutput
} from './types';
import { emptyCapturedContext } from './scorers';

export interface HarnessRunResult {
    output: PipelineQuestionOutput;
    shadowOutput?: PipelineQuestionOutput;
}

type OutputLogger = { appendLine(message: string): void };

export interface QueryPipelineHarnessOptions {
    workspaceRoot: string;
    repoguideDir: string;
    outputChannel?: OutputLogger;
}

export class QueryPipelineHarness {
    private store: LanceStore;
    private symbolIndex: SymbolIndex;
    private unitStore: LogicalUnitStore;
    private factStore: FactStore;
    private comprehensionEngine: ComprehensionEngine;
    private importGraphSearcher: ImportGraphSearcher;
    private queryDispatcher: QueryDispatcher | null = null;
    private history: ConversationHistory | null = null;
    private currentTelemetry: EvidenceQueryTelemetrySnapshot | undefined;
    private context: RepositoryContext;

    constructor(private readonly options: QueryPipelineHarnessOptions) {
        this.store = new LanceStore(options.repoguideDir);
        this.unitStore = new LogicalUnitStore(options.repoguideDir);
        this.factStore = new FactStore(options.repoguideDir);
        this.symbolIndex = new SymbolIndex();
        this.comprehensionEngine = new ComprehensionEngine(options.outputChannel as vscode.OutputChannel, options.repoguideDir);
        this.importGraphSearcher = new ImportGraphSearcher();

        const mockLogger: Logger = {
            appendLine: (msg) => this.options.outputChannel?.appendLine(msg),
            debug: (msg) => this.options.outputChannel?.appendLine(msg),
            info: (msg) => this.options.outputChannel?.appendLine(msg),
            warn: (msg) => this.options.outputChannel?.appendLine(msg),
            error: (msg) => this.options.outputChannel?.appendLine(msg),
            stageStart: () => {},
            stageProgress: () => {},
            stageComplete: () => {},
            stageFailed: () => {},
            artifactWritten: () => {},
            queryLog: () => {},
            repairLog: () => {}
        };
        
        this.context = {
            workspaceRoot: options.workspaceRoot,
            repoguideDataDir: options.repoguideDir,
            getConfig: <T>(key: string, defaultValue?: T) => {
                // Pinned, not opted into: this now matches the shipped default, and is
                // stated explicitly so a future change to that default cannot silently
                // make the measurement path non-reproducible. Without the reset, an answer
                // depends on whichever question was asked before it and two runs of this
                // suite are not comparable -- the exact failure this harness rules out.
                if (key === 'determinism.resetModelBeforeSynthesis') return true as unknown as T;
                // Selected per eval arm so the reranker comparison can be driven from
                // the command line without editing settings between runs.
                if (key === 'retrieval.reranker') {
                    return (process.env.REPOGUIDE_RERANKER ?? 'bge') as unknown as T;
                }
                return defaultValue as T;
            },
            asRelativePath: (p: string) => path.relative(options.workspaceRoot, p),
            logger: mockLogger,
            notifyInfo: async () => {},
            notifyWarning: async () => {},
            notifyError: async () => {}
        };
    }

    async init(): Promise<void> {
        await this.store.init();
        await this.unitStore.init(this.options.workspaceRoot);
        await this.factStore.init(this.options.workspaceRoot);
        // this.symbolIndex.setLogger(this.context.logger);
        const symbolsPath = path.join(this.options.repoguideDir, 'symbols.json');
        if (fs.existsSync(symbolsPath)) {
            await this.symbolIndex.load(this.options.repoguideDir);
        }
        await this.comprehensionEngine.loadExisting(this.options.workspaceRoot);
        this.importGraphSearcher.load(this.options.repoguideDir);

        const history = new ConversationHistory();
        this.history = history;
        const config = vscode.workspace.getConfiguration('repoguide');
        const ollamaUrl = resolveOllamaUrl(vscodeConfigReader(config));
        const profile = getProfile();
        const intentClassifier = new IntentClassifier(ollamaUrl, profile.planningModel, this.context);

        const bm25Store = new Bm25Store(this.options.repoguideDir);
        await bm25Store.init();

        const luBm25Store = new LogicalUnitBm25Store(this.options.repoguideDir);
        await luBm25Store.init();

        const programGraphStore = new ProgramGraphStore();
        await programGraphStore.load(this.options.workspaceRoot);

        const manifestStore = new IndexManifestStore(this.options.repoguideDir);
        await manifestStore.init();

        const canonicalFusion = new HybridRetrievalFusion(
            this.store,
            bm25Store,
            this.options.repoguideDir,
            this.options.workspaceRoot,
            intentClassifier,
            this.context,
            this.symbolIndex,
            this.importGraphSearcher,
            this.comprehensionEngine,
            history
        );
        const symbolIndexProvider = new SymbolIndexProvider(this.symbolIndex);
        const factStoreProvider = new FactStoreProvider(this.factStore);
        const logicalUnitStoreProvider = new LogicalUnitStoreProvider(this.unitStore);
        const programGraphProvider = new ProgramGraphProvider(programGraphStore);
        const hybridRetrievalProvider = new HybridRetrievalProvider(canonicalFusion, { emitEvidenceItems: true });
        const behavioralPathSearcher = new BehavioralPathSearcher();
        behavioralPathSearcher.load(this.options.repoguideDir);
        const understandingHealthService = new UnderstandingHealthService(path.join(this.options.repoguideDir, 'understanding'), this.options.workspaceRoot);
        const flowContextProvider = new FlowContextProvider(this.comprehensionEngine, behavioralPathSearcher, understandingHealthService);
        await symbolIndexProvider.initialize({ repositoryContext: this.context });
        await factStoreProvider.initialize({ repositoryContext: this.context });
        await logicalUnitStoreProvider.initialize({ repositoryContext: this.context });
        await programGraphProvider.initialize({ repositoryContext: this.context });
        await hybridRetrievalProvider.initialize({ repositoryContext: this.context });
        await flowContextProvider.initialize({ repositoryContext: this.context });
        const retrievalOrchestrator = new RetrievalOrchestrator([
            symbolIndexProvider,
            factStoreProvider,
            logicalUnitStoreProvider,
            programGraphProvider,
            hybridRetrievalProvider,
            flowContextProvider
        ]);
        const executionPlanner = new ExecutionPlanner(this.context, this.unitStore);

        this.queryDispatcher = new QueryDispatcher(history, {
            unitStore: this.unitStore,
            factStore: this.factStore,
            bm25Store: luBm25Store,
            manifestStore: manifestStore,
            programGraphStore: programGraphStore,
            annotationStore: new FileAnnotationEngine(this.options.repoguideDir, this.options.workspaceRoot, this.context),
            communityStore: this.options.repoguideDir
        }, this.context, {
            executionPlanner,
            retrievalOrchestrator,
            client: 'internal',
            emitEvaluationContext: true,
            telemetrySink: snapshot => { this.currentTelemetry = snapshot; }
        });
    }

    async runQuestion(question: GoldenQuestion, shadowEval: boolean = false): Promise<HarnessRunResult> {
        if (!this.queryDispatcher) {
            throw new Error('QueryPipelineHarness.init() must be called first.');
        }

        this.history?.clear();

        const output = await this.runHybridQuestion(question);
        let shadowOutput: PipelineQuestionOutput | undefined;

        if (shadowEval) {
            this.options.outputChannel?.appendLine(`\n[Eval] Shadow mode now records the active Hybrid output after Phase 7 cutover.`);
            shadowOutput = {
                answer: output.answer,
                controlEvents: output.controlEvents,
                capturedContext: output.capturedContext,
                confidence: output.confidence,
                rawAnswerContexts: output.rawAnswerContexts,
                telemetry: output.telemetry
            };
        }

        return { output, shadowOutput };
    }

    private async runHybridQuestion(question: GoldenQuestion): Promise<PipelineQuestionOutput> {
        if (!this.queryDispatcher) {
            throw new Error('QueryPipelineHarness.init() must be called first.');
        }

        let answer = '';
        let capturedContext: CapturedContext | undefined;
        let metadataFiles: string[] = [];
        this.currentTelemetry = undefined;
        const controlEvents: EvalControlEvents = { navigationResults: [] };

        const generator = question.type === 'explanation' && question.snippet
            ? this.queryDispatcher.explainSelection(
                resolveRepoPath(this.options.workspaceRoot, question.snippet.filePath),
                question.snippet.text ?? readSnippet(this.options.workspaceRoot, question.snippet),
                Math.max(0, question.snippet.startLine - 1),
                Math.max(0, question.snippet.endLine - 1),
                inferLanguage(question.snippet.filePath),
                undefined,
                question.question
            )
            : this.queryDispatcher.query(question.question);
            
        for await (const token of generator) {
            const trimmed = token.trim();
            if (trimmed.startsWith('{"__type":"healthCaveat"')) {
                try {
                    const caveat = JSON.parse(trimmed);
                    controlEvents.healthCaveats = controlEvents.healthCaveats ?? [];
                    controlEvents.healthCaveats.push(caveat);
                    continue;
                } catch { }
            }
            if (trimmed.startsWith('{"__type":"answerMetadata"')) {
                try {
                    const parsed = JSON.parse(trimmed);
                    metadataFiles = (parsed.metadata?.file_references ?? []).map((ref: any) => ref.file).filter(Boolean);
                } catch { }
                continue;
            }
            if (trimmed.startsWith('{"__type":"answerProvenance"')) {
                continue;
            }
            if (trimmed.startsWith('{"__type":"progressUpdate"')) {
                continue;
            }
            if (trimmed.startsWith('{"__type":"shadowContext"')) {
                try {
                    capturedContext = JSON.parse(trimmed).context;
                    continue;
                } catch { }
            }
            // Strip the trust-visibility gateStatus control token, mirroring the MCP token
            // processor (askRepoguideTokenProcessor.ts). Without this the raw
            // {"__type":"gateStatus",...} JSON leaks into the scored answer text and depresses
            // eval scores as if it were part of the model's answer.
            if (trimmed.startsWith('{"__type":"gateStatus"')) {
                continue;
            }
            answer += token;
        }

        if (!capturedContext) {
            const locations = parseAllLocations(answer);
            capturedContext = {
                ...emptyCapturedContext(),
                citedFiles: Array.from(new Set([...locations.map(location => location.filePath), ...metadataFiles]))
            };
        }

        return {
            answer,
            controlEvents,
            capturedContext: includeSnippetContext(capturedContext, this.options.workspaceRoot, question),
            confidence: null,
            rawAnswerContexts: [],
            telemetry: this.currentTelemetry
        };
    }
}

function includeSnippetContext(
    context: CapturedContext,
    workspaceRoot: string,
    question: GoldenQuestion
): CapturedContext {
    if (question.type !== 'explanation' || !question.snippet) {
        return context;
    }

    const snippetPath = resolveRepoPath(workspaceRoot, question.snippet.filePath);
    return {
        ...context,
        topCitedFiles: Array.from(new Set([snippetPath, ...context.topCitedFiles])),
        citedFiles: Array.from(new Set([snippetPath, ...context.citedFiles]))
    };
}

function readSnippet(workspaceRoot: string, snippet: { filePath: string; startLine: number; endLine: number }): string {
    const filePath = resolveRepoPath(workspaceRoot, snippet.filePath);
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const start = Math.max(0, snippet.startLine - 1);
    const end = Math.max(start, snippet.endLine - 1);
    return lines.slice(start, end + 1).join('\n');
}

function resolveRepoPath(workspaceRoot: string, filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
}

function inferLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.py') {
        return 'python';
    }
    if (ext === '.tsx' || ext === '.ts') {
        return 'typescript';
    }
    if (ext === '.jsx' || ext === '.js') {
        return 'javascript';
    }
    return ext.replace(/^\./, '') || 'text';
}
