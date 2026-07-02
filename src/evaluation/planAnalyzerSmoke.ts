import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as moduleObj from 'module';
import { AnnotationRole, FileAnnotation } from '../comprehension/fileAnnotationEngine';

installVscodeShim();

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});

async function main(): Promise<void> {
    const repo = path.resolve('eval_repos/axios');
    const repoguideDir = path.join(repo, '.repoguide');
    if (!fs.existsSync(repoguideDir)) {
        throw new Error(`RepoGuide artifacts not found: ${repoguideDir}`);
    }

    await seedAxiosAnnotations(repo, repoguideDir);
    const planPath = await writeMockPlan(repoguideDir);
    const pdfPlanPath = await writeCorruptPdfPlan(repoguideDir);

    const { LanceStore } = await import('../store/lanceStore.js');
    const { Bm25Store } = await import('../store/bm25Store.js');
    const { SymbolIndex } = await import('../indexing/symbolIndex.js');
    const { ComprehensionEngine } = await import('../comprehension/comprehensionEngine.js');
    const { ImportGraphSearcher } = await import('../comprehension/importGraphSearcher.js');
    const { IntentClassifier } = await import('../query/intentClassifier.js');
    const { ConversationHistory } = await import('../query/conversationHistory.js');
    const { HybridRetrievalFusion } = await import('../query/hybridRetrievalFusion.js');
    const { PlanAnalyzer } = await import('../query/planAnalyzer.js');
    const { getProfile } = await import('../config/performanceConfig.js');

    const mockContext = { 
        logger: { info: console.log, debug: console.log, warn: console.log, error: console.error },
        getConfig: (key: string) => {
            if (key === 'ollamaUrl') return 'http://localhost:11434';
            return undefined;
        },
        asRelativePath: (p: string) => p,
        workspaceRoot: 'C:/repo',
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
    await comprehensionEngine.loadExisting(repo);
    const importGraphSearcher = new ImportGraphSearcher();
    importGraphSearcher.load(repoguideDir);
    const profile = getProfile();
    const intentClassifier = new IntentClassifier('http://localhost:11434', profile.planningModel, mockContext);
    const hybrid = new HybridRetrievalFusion(
        store,
        bm25Store,
        repoguideDir,
        repo,
        intentClassifier,
        mockContext,
        symbolIndex,
        importGraphSearcher,
        comprehensionEngine,
        new ConversationHistory()
    );

    const analyzer = new PlanAnalyzer(mockContext, intentClassifier, hybrid);
    const report = await analyzer.analyze(planPath, repo);
    const reportPath = path.join(repoguideDir, 'plan_analysis.json');
    const persisted = JSON.parse(await fs.promises.readFile(reportPath, 'utf8'));

    assertSchema(persisted);
    assertSummary(persisted);
    assertImplemented(persisted, 'network interceptor'); // Semantic synonym case
    assertImplemented(persisted, 'header');
    
    // Check vague item
    const vagueItem = persisted.items.find((item: any) => String(item.name).toLowerCase().includes('data process'));
    if (vagueItem && vagueItem.status === 'implemented') {
        throw new Error(`Expected vague item 'Data Process' to NOT be implemented, got ${vagueItem.status}`);
    }

    assertRealMatches(persisted);

    // Test PDF warning
    const pdfReport = await analyzer.analyze(pdfPlanPath, repo);
    if (!pdfReport.warnings || pdfReport.warnings.length === 0) {
        throw new Error('Expected warnings for corrupt PDF plan.');
    }
    console.log(`[Smoke] PDF parser warning received as expected: ${pdfReport.warnings[0]}`);

    await cleanupSeededAnnotations(repoguideDir);

    console.log('\n=== Plan Analyzer Smoke Result ===');
    console.log(`Report path: ${reportPath}`);
    console.log(JSON.stringify(report, null, 2));
}

async function cleanupSeededAnnotations(repoguideDir: string): Promise<void> {
    const annotationsDir = path.join(repoguideDir, 'annotations');
    if (!fs.existsSync(annotationsDir)) return;
    const files = await fs.promises.readdir(annotationsDir);
    for (const file of files) {
        if (file.startsWith('phase9-') && file.endsWith('.json')) {
            await fs.promises.writeFile(path.join(annotationsDir, file), '{}', 'utf8');
        }
    }
}

async function writeMockPlan(repoguideDir: string): Promise<string> {
    // using .txt to test alternative extensions
    const planPath = path.join(repoguideDir, 'phase9_mock_plan.txt');
    const content = [
        '# Axios Feature Implementation Plan',
        '',
        '- HTTP Request Dispatching: Dispatch configured requests through transform, cancellation, and adapter execution.',
        '- Header Management Utility: Normalize, parse, set, and serialize request and response headers.',
        '- Network Interceptor Service: Register and execute request and response interceptor chains around dispatch.', // Semantic synonym for Interceptors
        '- Adapter Selection: Select the correct runtime adapter such as xhr, http, or fetch.',
        '- URL Building: Combine base URL, request URL, and query params into the final request URI.',
        '- Cancellation Support: Cancel in-flight requests through cancel tokens and abort signals.',
        '- Data Process: Do things with data.' // Vague item that shouldn't match strongly
    ].join('\n');
    await fs.promises.writeFile(planPath, content, 'utf8');
    return planPath;
}

async function writeCorruptPdfPlan(repoguideDir: string): Promise<string> {
    const planPath = path.join(repoguideDir, 'corrupt_plan.pdf');
    // Just text, so pdf-parse throws an error
    await fs.promises.writeFile(planPath, 'This is not a real PDF file, just a mock for testing.', 'utf8');
    return planPath;
}

async function seedAxiosAnnotations(repo: string, repoguideDir: string): Promise<void> {
    const annotationsDir = path.join(repoguideDir, 'annotations');
    await fs.promises.mkdir(annotationsDir, { recursive: true });
    const annotations: Array<Omit<FileAnnotation, 'hash' | 'generated_at'>> = [
        {
            file: 'lib/core/dispatchRequest.js',
            confidence: 'high',
            what: 'Dispatches Axios requests through transforms, cancellation checks, and the selected adapter.',
            role: 'service',
            key_symbols: ['dispatchRequest'],
            depends_on: ['throwIfCancellationRequested', 'transformData', 'adapters'],
            signals: ['async_pattern', 'external_call']
        },
        {
            file: 'lib/core/AxiosHeaders.js',
            confidence: 'high',
            what: 'Normalizes, parses, sets, and serializes Axios request and response headers.',
            role: 'utility',
            key_symbols: ['AxiosHeaders'],
            depends_on: ['normalizeHeader', 'parseHeaders'],
            signals: ['mutates_state']
        },
        {
            file: 'lib/core/InterceptorManager.js',
            confidence: 'high',
            what: 'Registers and manages request and response interceptor handlers for Axios chains.',
            role: 'service',
            key_symbols: ['InterceptorManager', 'use', 'eject', 'forEach'],
            depends_on: [],
            signals: ['mutates_state']
        },
        {
            file: 'lib/adapters/adapters.js',
            confidence: 'high',
            what: 'Selects and resolves the configured Axios adapter for the current runtime.',
            role: 'service',
            key_symbols: ['getAdapter', 'adapters'],
            depends_on: ['xhrAdapter', 'httpAdapter', 'fetchAdapter'],
            signals: ['external_call']
        },
        {
            file: 'lib/helpers/buildURL.js',
            confidence: 'high',
            what: 'Builds request URLs by serializing query params and appending them to the base URL.',
            role: 'utility',
            key_symbols: ['buildURL'],
            depends_on: ['AxiosURLSearchParams', 'encode'],
            signals: []
        },
        {
            file: 'lib/cancel/CancelToken.js',
            confidence: 'high',
            what: 'Provides cancel tokens that notify listeners and cancel in-flight Axios requests.',
            role: 'service',
            key_symbols: ['CancelToken', 'source'],
            depends_on: ['CanceledError'],
            signals: ['async_pattern', 'error_boundary']
        }
    ];

    for (const annotation of annotations) {
        const hash = crypto.createHash('sha256').update(annotation.file).digest('hex');
        const full: FileAnnotation = {
            ...annotation,
            hash,
            generated_at: new Date().toISOString()
        };
        await fs.promises.writeFile(path.join(annotationsDir, `phase9-${hash}.json`), JSON.stringify(full, null, 2), 'utf8');
    }
}

function assertSchema(report: any): void {
    const topKeys = Object.keys(report).sort();
    const expectedTop = ['items', 'parsed_at', 'plan_file', 'summary'].sort();
    // It might also have warnings. So let's allow it.
    if (!expectedTop.every(k => topKeys.includes(k))) {
        throw new Error(`Report top-level keys mismatch: ${topKeys.join(', ')}`);
    }
    if (typeof report.plan_file !== 'string' || typeof report.parsed_at !== 'string' || !Array.isArray(report.items)) {
        throw new Error('Report has invalid top-level field types.');
    }
    for (const item of report.items) {
        const keys = Object.keys(item).sort();
        const expected = ['id', 'name', 'description', 'expected_role', 'status', 'matched_files', 'match_confidence', 'deviation_note', 'evidence'].sort();
        if (!expected.every(k => keys.includes(k))) {
            throw new Error(`Item keys mismatch: ${keys.join(', ')}`);
        }
        if (!['implemented', 'partial', 'different', 'missing', 'unclear'].includes(item.status)) {
            throw new Error(`Invalid status: ${item.status}`);
        }
        if (!Array.isArray(item.matched_files)) {
            throw new Error('matched_files must be an array.');
        }
        if (!Array.isArray(item.evidence)) {
            throw new Error('evidence must be an array.');
        }
    }
    const summaryKeys = Object.keys(report.summary).sort();
    const expectedSummary = ['total_items', 'implemented', 'partial', 'different', 'missing', 'unclear', 'unplanned_files', 'unplanned_files_definition', 'completion_percentage'].sort();
    if (JSON.stringify(summaryKeys) !== JSON.stringify(expectedSummary)) {
        throw new Error(`Summary keys mismatch: ${summaryKeys.join(', ')}`);
    }
}

function assertSummary(report: any): void {
    const total = report.items.length;
    const implemented = report.items.filter((item: any) => item.status === 'implemented').length;
    const partial = report.items.filter((item: any) => item.status === 'partial').length;
    const different = report.items.filter((item: any) => item.status === 'different').length;
    const missing = report.items.filter((item: any) => item.status === 'missing').length;
    const unclear = report.items.filter((item: any) => item.status === 'unclear').length;
    if (
        report.summary.total_items !== total ||
        report.summary.implemented !== implemented ||
        report.summary.partial !== partial ||
        report.summary.different !== different ||
        report.summary.missing !== missing ||
        report.summary.unclear !== unclear
    ) {
        throw new Error('Summary totals do not match item statuses.');
    }
}

function assertImplemented(report: any, namePattern: string): void {
    const item = report.items.find((entry: any) => String(entry.name).toLowerCase().includes(namePattern));
    if (!item) {
        throw new Error(`Missing plan item matching ${namePattern}`);
    }
    if (item.status !== 'implemented') {
        throw new Error(`Expected ${item.name} to be implemented, got ${item.status}`);
    }
}

function assertRealMatches(report: any): void {
    for (const item of report.items) {
        if (item.status !== 'missing' && item.matched_files.length === 0) {
            throw new Error(`${item.name} is ${item.status} but has no matched files.`);
        }
    }
    const allMatches = report.items.flatMap((item: any) => item.matched_files);
    if (!allMatches.some((file: string) => file.includes('InterceptorManager.js'))) {
        throw new Error('Expected InterceptorManager.js in matched files.');
    }
    if (!allMatches.some((file: string) => file.includes('AxiosHeaders.js'))) {
        throw new Error('Expected AxiosHeaders.js in matched files.');
    }
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
