import * as fs from 'fs';
import * as path from 'path';
import * as moduleObj from 'module';

interface Args {
    repo: string;
    question: string;
    help: boolean;
}

installVscodeShim();

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }

    const repoguideDir = path.join(args.repo, '.repoguide');
    if (!fs.existsSync(repoguideDir)) {
        throw new Error(`RepoGuide artifacts not found: ${repoguideDir}`);
    }

    const { LanceStore } = await import('../store/lanceStore.js');
    const { Bm25Store } = await import('../store/bm25Store.js');
    const { SymbolIndex } = await import('../indexing/symbolIndex.js');
    const { ComprehensionEngine } = await import('../comprehension/comprehensionEngine.js');
    const { ImportGraphSearcher } = await import('../comprehension/importGraphSearcher.js');
    const { IntentClassifier } = await import('../query/intentClassifier.js');
    const { ConversationHistory } = await import('../query/conversationHistory.js');
    const { HybridRetrievalFusion } = await import('../query/hybridRetrievalFusion.js');
    const { HybridRetrievalProvider } = await import('../query/hybridRetrievalProvider.js');
    const { RetrievalOrchestrator } = await import('../query/retrievalOrchestrator.js');
    const { ExecutionPlanner } = await import('../query/executionPlanner.js');
    const { InvestigationEngine } = await import('../query/investigationEngine.js');
    const { getProfile } = await import('../config/performanceConfig.js');

    const mockContext = { 
        logger: { info: console.log, debug: console.log, warn: console.log, error: console.error },
        getConfig: (key: string) => {
            if (key === 'ollamaUrl') return 'http://localhost:11434';
            return undefined;
        },
        asRelativePath: (p: string) => p,
        workspaceRoot: args.repo,
        repoguideDataDir: '.repoguide',
        notifyInfo: async () => {},
        notifyWarning: async () => {},
        notifyError: async () => {}
    } as any;
    const store = new LanceStore(repoguideDir);
    await store.init();
    const bm25Store = new Bm25Store(repoguideDir);
    await bm25Store.init();
    const symbolIndex = new SymbolIndex();
    await symbolIndex.load(repoguideDir);
    const comprehensionEngine = new ComprehensionEngine(mockContext, repoguideDir);
    await comprehensionEngine.loadExisting(args.repo);
    const importGraphSearcher = new ImportGraphSearcher();
    importGraphSearcher.load(repoguideDir);
    const profile = getProfile();
    const intentClassifier = new IntentClassifier('http://localhost:11434', profile.planningModel, mockContext);
    const history = new ConversationHistory();
    const hybrid = new HybridRetrievalFusion(
        store,
        bm25Store,
        repoguideDir,
        args.repo,
        intentClassifier,
        mockContext,
        symbolIndex,
        importGraphSearcher,
        comprehensionEngine,
        history
    );
    const hybridRetrievalProvider = new HybridRetrievalProvider(hybrid, { emitEvidenceItems: true });
    await hybridRetrievalProvider.initialize({ repositoryContext: mockContext });
    const retrievalOrchestrator = new RetrievalOrchestrator([hybridRetrievalProvider]);
    const executionPlanner = new ExecutionPlanner(mockContext);
    const engine = new InvestigationEngine(mockContext, history, intentClassifier, hybrid, executionPlanner, retrievalOrchestrator, 'internal', undefined);
    const report = await engine.investigate(args.question);

    const uniqueFiles = new Set(report.paths.flatMap(p => p.retrievedFiles));
    const hasDetectiveReport = /DETECTIVE-STYLE HYPOTHESIS REPORT/i.test(report.answer);
    const hasHypothesis = /PRIMARY HYPOTHESIS/i.test(report.answer) || /hypothesis/i.test(report.answer);
    const hasCannotDetermine = /WHAT I CANNOT DETERMINE/i.test(report.answer);
    const matchedSignals = new Set(report.paths.flatMap(p => p.matchedAnnotationSignals));

    console.log('\n=== Investigation Smoke Result ===');
    console.log(`Question: ${report.question}`);
    console.log(`Paths: ${report.paths.length}`);
    console.log(`Evidence files: ${uniqueFiles.size}`);
    console.log(`Hypotheses: ${report.hypotheses.length}`);
    console.log(`Matched annotation signals: ${Array.from(matchedSignals).join(', ') || 'none'}`);
    console.log('\n--- Structured Paths ---');
    console.log(JSON.stringify(report.paths, null, 2));
    console.log('\n--- Answer Preview ---');
    console.log(report.answer.slice(0, 4000));

    if (report.paths.length < 3) {
        throw new Error(`Expected at least 3 investigation paths, got ${report.paths.length}`);
    }
    if (uniqueFiles.size < 2) {
        throw new Error(`Expected at least 2 unique evidence files, got ${uniqueFiles.size}`);
    }
    if (!hasDetectiveReport || !hasHypothesis) {
        throw new Error('Investigation answer did not contain the required detective-style hypothesis structure.');
    }
    if (!hasCannotDetermine) {
        throw new Error('Investigation answer did not contain the required WHAT I CANNOT DETERMINE section.');
    }
    if (matchedSignals.size === 0) {
        throw new Error('Investigation did not match any annotation signals.');
    }
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        repo: path.resolve('eval_repos/axios'),
        question: 'Investigate how Axios handles request cancellation from public API call to adapter behavior.',
        help: false
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        switch (arg) {
            case '--repo':
                args.repo = path.resolve(requireValue(arg, next));
                i += 1;
                break;
            case '--question':
                args.question = requireValue(arg, next);
                i += 1;
                break;
            case '--help':
            case '-h':
                args.help = true;
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return args;
}

function requireValue(flag: string, value: string | undefined): string {
    if (!value || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

function printHelp(): void {
    console.log([
        'RepoGuide Phase 8 Investigation Smoke Test',
        '',
        'Usage:',
        '  npm run phase8:smoke -- --repo <path> --question "Investigate ..."',
        '',
        'Defaults to eval_repos/axios and a cancellation investigation question.'
    ].join('\n'));
}

function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = createVscodeShim();
    moduleObj.Module.prototype.require = function patchedRequire(id: string) {
        if (id === 'vscode') {
            return shim;
        }
        return originalRequire.apply(this, arguments as any);
    };
}

function createVscodeShim(): any {
    return {
        workspace: {
            workspaceFolders: [],
            getConfiguration: () => ({
                get: (_key: string, fallback: unknown) => fallback
            }),
            onDidSaveTextDocument: () => disposable(),
            onDidChangeConfiguration: () => disposable(),
            onDidOpenTextDocument: () => disposable(),
            createFileSystemWatcher: () => disposable()
        },
        window: {
            createOutputChannel: () => ({
                appendLine: (message: string) => console.log(message),
                show: () => undefined,
                dispose: () => undefined
            }),
            showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined,
            showErrorMessage: async (message: string) => console.error(message)
        },
        commands: {
            registerCommand: () => disposable(),
            executeCommand: async () => undefined
        },
        extensions: {
            getExtension: () => ({ packageJSON: { version: '0.0.1' } })
        },
        Uri: {
            file: (fsPath: string) => ({ fsPath }),
            joinPath: (base: any, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) })
        }
    };
}

function disposable(): { dispose(): void } {
    return { dispose: () => undefined };
}
