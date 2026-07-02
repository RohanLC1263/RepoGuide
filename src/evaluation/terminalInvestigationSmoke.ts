import * as assert from 'assert';
import * as moduleObj from 'module';
import { preprocessError } from '../query/errorPreprocessor';
import { CodeChunk, SymbolEntry } from '../store/storeTypes';

installVscodeShim();

function chunk(id: string, filePath: string, startLine: number, text: string): CodeChunk {
    return {
        id,
        filePath,
        language: filePath.endsWith('.json') ? 'json' : 'typescript',
        startLine,
        endLine: startLine + 20,
        text,
        vector: [],
        hash: 'hash'
    };
}

const tsError = [
    'src/query/foo.ts(12,7): error TS2322: Type string is not assignable to type number.',
    'Found 1 error in src/query/foo.ts:12'
].join('\n');
const tsPreprocessed = preprocessError(tsError, 'npm run compile failed');
assert.equal(tsPreprocessed.error_type, 'typescript_compiler');
assert.ok(tsPreprocessed.anchors.some(anchor => anchor.type === 'file' && anchor.value === 'src/query/foo.ts' && anchor.line === 12));
assert.ok(tsPreprocessed.preferred_annotation_signals.includes('configuration'));

const moduleError = [
    "Error: Cannot find module 'left-pad'",
    'Require stack:',
    '- C:/repo/src/index.ts'
].join('\n');
const modulePreprocessed = preprocessError(moduleError);
assert.equal(modulePreprocessed.error_type, 'node_module_resolution');
assert.ok(modulePreprocessed.anchors.some(anchor => anchor.type === 'package' && anchor.value === 'left-pad'));

const stackError = [
    'TypeError: Cannot read properties of undefined (reading \'map\')',
    '    at buildThing (src/query/buildThing.ts:44:13)',
    '    at Object.run (src/query/run.ts:9:2)'
].join('\n');
const stackPreprocessed = preprocessError(stackError);
assert.equal(stackPreprocessed.error_type, 'stack_trace');
assert.ok(stackPreprocessed.anchors.some(anchor => anchor.type === 'file' && anchor.value === 'src/query/buildThing.ts' && anchor.line === 44));
assert.ok(stackPreprocessed.anchors.some(anchor => anchor.type === 'symbol' && anchor.value === 'buildThing'));

const fakeChunks = [
    chunk('foo:0', 'C:/repo/src/query/foo.ts', 0, 'export function foo(value: number) { return value + 1; }'),
    chunk('pkg:0', 'C:/repo/package.json', 0, '{"dependencies":{"left-pad":"1.3.0"},"scripts":{"compile":"tsc -p ."}}'),
    chunk('build:40', 'C:/repo/src/query/buildThing.ts', 40, 'export function buildThing(input?: string[]) { return input.map(Boolean); }')
];

const fakeHybrid = {
    getChunksForEvidenceFile: async (filePath: string): Promise<CodeChunk[]> => {
        const normalized = filePath.replace(/\\/g, '/').toLowerCase();
        return fakeChunks.filter(item => {
            const candidate = item.filePath.replace(/\\/g, '/').toLowerCase();
            return candidate.endsWith(normalized) || candidate.endsWith('/' + normalized) || candidate.endsWith('/' + normalized.split('/').pop());
        });
    },
    lookupSymbolEvidence: (symbol: string): SymbolEntry[] => {
        if (symbol === 'buildThing') {
            return [{ name: 'buildThing', filePath: 'C:/repo/src/query/buildThing.ts', startLine: 41, endLine: 45, kind: 'function' }];
        }
        return [];
    },
    findPackageOrConfigFiles: async (_anchor: string): Promise<string[]> => ['C:/repo/package.json'],
    searchBm25Evidence: async (query: string): Promise<CodeChunk[]> => {
        const lower = query.toLowerCase();
        return fakeChunks.filter(item => item.text.toLowerCase().includes('map') || lower.includes('foo') || item.filePath.endsWith('package.json'));
    },
    retrieveContext: async () => ({
        chunks: fakeChunks.map((item, index) => ({ chunk: item, score: 1 - index * 0.1, rank: index + 1 })),
        annotations: [{
            file: 'src/query/foo.ts',
            hash: 'hash',
            generated_at: new Date().toISOString(),
            confidence: 'high',
            what: 'Builds typed query helpers and can surface TypeScript compile errors.',
            role: 'utility',
            key_symbols: ['foo'],
            depends_on: [],
            signals: ['error_boundary', 'configuration']
        }],
        communities: []
    })
};

// investigateTerminal()'s anchor-driven lookups still call HybridRetrievalFusion directly
// (fakeHybrid above), but its broad catch-all search now routes through
// ExecutionPlanner -> RetrievalOrchestrator like investigate() does. Since this smoke test
// has no real stores/providers, these are minimal functional stubs: the fake planner
// returns an inert plan, and the fake orchestrator converts fakeHybrid's canned chunks into
// EvidenceItems directly rather than exercising a real provider chain.
const fakeExecutionPlanner = {
    plan: async (_request: any, _model: string) => ({
        planId: 'fake-plan', requestId: 'fake-request', query: _request.query, category: 'investigation',
        retrievalPlan: { providerIds: [] }
    })
};
const fakeRetrievalOrchestrator = {
    execute: async (_plan: any) => {
        const assembly = await fakeHybrid.retrieveContext();
        const items = assembly.chunks.map(c => ({
            id: c.chunk.id, file: c.chunk.filePath, startLine: c.chunk.startLine, endLine: c.chunk.endLine,
            role: 'implementation', type: 'hybrid_chunk', content: c.chunk.text, retrieval_signal: 'hybrid_retrieval',
            score: c.score, confidence: 0.8, extractionMethod: 'fake'
        }));
        return { items, providerResults: [], gaps: [], coverage: { required: 0, matched: 0 }, diagnostics: [], metadata: { latencyMs: 0, providersInvoked: [], providersSkipped: [], providersFailed: [] } };
    }
};

async function runInvestigationSmoke(): Promise<void> {
    const { InvestigationEngine } = await import('../query/investigationEngine.js');
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
    const engine = new InvestigationEngine(mockContext, {} as any, {} as any, fakeHybrid as any, fakeExecutionPlanner as any, fakeRetrievalOrchestrator as any, 'internal', undefined);
    const report = await engine.investigateTerminal({
        problem_description: 'Compile failed after changing foo',
        terminal_output: tsError,
        cwd: 'C:/repo'
    });

    assert.equal(report.problem, 'Compile failed after changing foo');
    assert.ok(report.primary_hypothesis.text.length > 0);
    assert.ok(report.evidence_trail.length > 0);
    assert.ok(Array.isArray(report.cannot_determine));
    assert.ok(report.cannot_determine.length > 0);
    assert.ok(report.next_checks.length > 0);
    assert.ok(report.answer.includes('RAW STRUCTURED REPORT'));

    console.log('Terminal investigation smoke PASS');
    console.log(JSON.stringify({
        ts_preprocessed: tsPreprocessed,
        module_preprocessed: modulePreprocessed,
        stack_preprocessed: stackPreprocessed,
        investigation_report: {
            problem: report.problem,
            primary_hypothesis: report.primary_hypothesis,
            evidence_count: report.evidence_trail.length,
            cannot_determine: report.cannot_determine,
            next_checks: report.next_checks
        }
    }, null, 2));
}

runInvestigationSmoke().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});

function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = {
        workspace: {
            getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback })
        },
        window: {
            createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined })
        }
    };
    moduleObj.Module.prototype.require = function patchedRequire(id: string) {
        if (id === 'vscode') {
            return shim;
        }
        return originalRequire.apply(this, arguments as any);
    };
}
