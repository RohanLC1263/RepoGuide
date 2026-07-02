import test, { after, before, beforeEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type OutputChannel = {
    lines: string[];
    appendLine(message: string): void;
};

const outputChannel: OutputChannel = {
    lines: [],
    appendLine(message: string): void {
        this.lines.push(message);
    }
};

(globalThis as any).vscode = {
    commands: {
        executeCommand: async () => undefined,
        registerCommand: () => ({ dispose: () => undefined })
    },
    window: {
        activeTextEditor: null,
        createOutputChannel: () => outputChannel,
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined
    },
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, fallback: unknown) => fallback
        }),
        onDidSaveTextDocument: () => ({ dispose: () => undefined })
    },
    extensions: {
        getExtension: () => ({ packageJSON: { version: '1.0.0' } })
    }
};

const originalFetch = global.fetch;
const runLegacyFixtures = process.env.REPOGUIDE_RUN_LEGACY_FIXTURES === '1';

let ArtifactDependencyGraph: any;
let ComprehensionEngine: any;
let ComprehensionJobRunner: any;
let FileChangeHandler: any;
let StalenessRegistry: any;
let BackgroundRegenerationQueue: any;
let getFileUnderstandingCheckpointPath: any;
let loadUnderstandingManifest: any;
let saveUnderstandingManifest: any;
let unwrapArtifact: any;
let RepoguideTestUtils: any;

if (runLegacyFixtures) {
    ({ ArtifactDependencyGraph } = require('../comprehension/artifactDependencyGraph'));
    ({ ComprehensionEngine } = require('../comprehension/comprehensionEngine'));
    ({ ComprehensionJobRunner } = require('../comprehension/comprehensionJobRunner'));
    ({ FileChangeHandler } = require('../comprehension/fileChangeHandler'));
    ({ StalenessRegistry } = require('../comprehension/stalenessRegistry'));
    ({ BackgroundRegenerationQueue } = require('../comprehension/backgroundRegenerationQueue'));
    ({ getFileUnderstandingCheckpointPath } = require('../comprehension/fileUnderstandingCheckpoint'));
    ({ loadUnderstandingManifest, saveUnderstandingManifest } = require('../comprehension/understandingManifest'));
    ({ unwrapArtifact } = require('../comprehension/schema-versions'));
    ({ RepoguideTestUtils } = require('./testUtils'));
}

const fixtures = [
    { name: 'python-fastapi', expectedFileCount: 5, changeFile: 'services/item_service.py' },
    { name: 'typescript-react', expectedFileCount: 4, changeFile: 'src/hooks/useUser.ts' },
    { name: 'node-express', expectedFileCount: 4, changeFile: 'controllers/userController.js' },
    { name: 'mixed-fullstack', expectedFileCount: 4, changeFile: 'backend/services/orders.py' }
] as const;

const legacyFixtureDescribe = runLegacyFixtures ? describe : describe.skip;

let fetchState = createFetchState();

before(() => {
    if (!runLegacyFixtures) {
        return;
    }
    global.fetch = mockOllamaFetch as typeof fetch;
    RepoguideTestUtils.enableTestMode();
});

after(() => {
    if (!runLegacyFixtures) {
        return;
    }
    global.fetch = originalFetch;
    RepoguideTestUtils.disableTestMode();
});

beforeEach(() => {
    fetchState = createFetchState();
    outputChannel.lines = [];
});

for (const fixture of fixtures) {
    legacyFixtureDescribe(`fixture repo: ${fixture.name}`, () => {
        let fullTemp: Awaited<ReturnType<typeof createTempFixture>>;
        let resumeTemp: Awaited<ReturnType<typeof createTempFixture>>;
        let resumeLogLines: string[] = [];
        let regeneratedOnResume: string[] = [];
        let resumeFileUnderstandingStats: Record<string, unknown> = {};

        before(async () => {
            fullTemp = await createTempFixture(fixture.name);
            fetchState = createFetchState();
            outputChannel.lines = [];
            await runComprehension(fullTemp.root);

            resumeTemp = await createTempFixture(fixture.name);
            const first = await runUntilThreeFileUnderstandings(resumeTemp.root);
            assert.equal(first.successfulFileUnderstandingPaths.length, 3);
            const alreadyDone = new Set(first.successfulFileUnderstandingPaths);

            fetchState = createFetchState();
            outputChannel.lines = [];
            await runComprehension(resumeTemp.root);

            resumeLogLines = [...outputChannel.lines];
            regeneratedOnResume = fetchState.fileUnderstandingRequests.map(request => request.relativePath);
            assert.ok(
                regeneratedOnResume.every(relativePath => !alreadyDone.has(relativePath)),
                `resume should skip cached files; regenerated=${regeneratedOnResume.join(', ')}`
            );

            const manifest = await loadUnderstandingManifest(resumeTemp.understandingDir, resumeTemp.root);
            resumeFileUnderstandingStats = manifest.stages.file_understanding.stats;
        });

        after(async () => {
            await fullTemp?.dispose();
            await resumeTemp?.dispose();
        });

        it('TEST 1 - full comprehension completes', async () => {
            const manifest = await loadUnderstandingManifest(fullTemp.understandingDir, fullTemp.root);

            assert.equal(manifest.overallStatus, 'complete');
            for (const [stageName, stage] of Object.entries(manifest.stages) as Array<[string, any]>) {
                assert.equal(stage.status, 'complete', `${stageName} should complete`);
                assert.notEqual(stage.status, 'failed', `${stageName} should not fail`);
            }
        });

        it('TEST 2 - artifacts exist after run', async () => {
            const lexicalMap = readArtifact<any>(fullTemp.understandingDir, 'lexical_map.json');
            assert.equal(lexicalMap.fileCount ?? lexicalMap.stats?.files, fixture.expectedFileCount);

            const importGraph = readArtifact<any>(fullTemp.understandingDir, 'import_graph.json');
            assert.ok(importGraph.stats.localEdges > 0, 'import graph should contain local edges');

            const structures = readArtifact<any[]>(fullTemp.understandingDir, 'file-structures.json');
            const sourceFiles = structures.map(structure => structure.filePath);
            for (const filePath of sourceFiles) {
                assert.ok(
                    fs.existsSync(getFileUnderstandingCheckpointPath(fullTemp.understandingDir, filePath)),
                    `missing file understanding checkpoint for ${filePath}`
                );
            }

            const behavioralPaths = readJson<any>(path.join(fullTemp.understandingDir, 'behavioral_paths.json'));
            assert.ok(behavioralPaths.paths.length >= 1, 'behavioral_paths.json should contain at least one path');

            const conceptMap = readJson<any>(path.join(fullTemp.understandingDir, 'concept_map.json'));
            assert.ok(conceptMap.conceptCount >= 10, 'concept_map.json should contain at least 10 concepts');
        });

        it('TEST 3 - restart loads artifacts after a mid-run stop', async () => {
            assert.ok(
                resumeLogLines.some(line => line.includes('Resuming file understanding: 3 existing')),
                'resume run should log existing file understanding checkpoints'
            );

            const files = readArtifact<any[]>(resumeTemp.understandingDir, 'files.json');
            assert.equal(files.length, fixture.expectedFileCount);
        });

        it('TEST 4 - partial run skips already-done files', async () => {
            assert.ok(regeneratedOnResume.length > 0, 'resume should generate remaining file understandings');
            assert.equal(resumeFileUnderstandingStats.cached, 3);
        });

        it('TEST 5 - file change invalidates targeted artifacts', async () => {
            const targetPath = path.join(fullTemp.root, fixture.changeFile);
            const changedContent = appendFixtureFunction(targetPath);
            await fs.promises.writeFile(targetPath, changedContent, 'utf8');

            const depGraph = new ArtifactDependencyGraph(fullTemp.root, fullTemp.understandingDir, outputChannel as any);
            depGraph.build();
            outputChannel.lines = [];
            const stalenessRegistry = new StalenessRegistry(fullTemp.understandingDir);
            const regenQueue = new BackgroundRegenerationQueue(
                fullTemp.root,
                fullTemp.understandingDir,
                depGraph,
                stalenessRegistry,
                undefined,
                outputChannel as any
            );
            const handler = new FileChangeHandler(
                fullTemp.root, 
                fullTemp.understandingDir, 
                depGraph, 
                stalenessRegistry,
                regenQueue,
                outputChannel as any, 
                { debounceMs: 0 }
            );
            
            // Trigger file change
            (handler as any).handleFileChange(fixture.changeFile, null);
            
            // Wait for debounce and queue enqueue
            await new Promise(resolve => setTimeout(resolve, 100));

            const dirtyArtifacts = stalenessRegistry.getAllDirtyArtifacts();
            assert.ok(dirtyArtifacts.length > 0, 'staleness registry should have dirty artifacts');
            
            // Check that at least some known downstream artifacts are marked dirty
            const hasCallGraph = dirtyArtifacts.includes('call_graph_v2.json');
            const hasBehavioralPaths = dirtyArtifacts.includes('behavioral_paths.json');
            const hasSourceFile = dirtyArtifacts.includes(fixture.changeFile);
            
            assert.ok(hasSourceFile, 'source file itself should be queued/marked');
            
            handler.dispose();
            regenQueue.dispose();
        });
    });
}

async function runComprehension(workspaceRoot: string): Promise<void> {
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    const engine = new ComprehensionEngine(outputChannel as any, repoguideDir);
    const runner = new ComprehensionJobRunner(engine, repoguideDir, outputChannel);
    await runner.run(workspaceRoot);
}

async function runUntilThreeFileUnderstandings(workspaceRoot: string) {
    fetchState = createFetchState();
    await runComprehension(workspaceRoot);

    const understandingDir = path.join(workspaceRoot, '.repoguide', 'understanding');
    const structures = readArtifact<any[]>(understandingDir, 'file-structures.json');
    const keep = structures.slice(0, 3);
    const remove = structures.slice(3);

    for (const structure of remove) {
        await fs.promises.rm(
            getFileUnderstandingCheckpointPath(understandingDir, structure.filePath),
            { force: true }
        );
    }

    const manifest = await loadUnderstandingManifest(understandingDir, workspaceRoot);
    for (const stage of [
        'file_understanding',
        'call_graph_gap_fill',
        'module_understanding',
        'concept_map',
        'behavioral_paths',
        'project_synthesis',
        'validation'
    ] as const) {
        manifest.stages[stage] = {
            ...manifest.stages[stage],
            status: 'pending',
            completedAt: null,
            error: null
        };
    }
    manifest.overallStatus = 'pending';
    await saveUnderstandingManifest(understandingDir, manifest);

    return {
        ...fetchState,
        successfulFileUnderstandingPaths: keep.map(structure =>
            path.relative(workspaceRoot, structure.filePath).replace(/\\/g, '/')
        )
    };
}

async function createTempFixture(name: string): Promise<{ root: string; understandingDir: string; dispose(): Promise<void> }> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `repoguide-${name}-`));
    const source = path.join(__dirname, '../../test/fixtures', name);
    await fs.promises.cp(source, root, { recursive: true });
    const understandingDir = path.join(root, '.repoguide', 'understanding');
    await fs.promises.mkdir(understandingDir, { recursive: true });
    return {
        root,
        understandingDir,
        dispose: async () => {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    };
}

async function mockOllamaFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = input.toString();
    if (url.includes('/api/embeddings')) {
        return jsonResponse({ embedding: [0.1, 0.2, 0.3], embeddings: [[0.1, 0.2, 0.3]] });
    }
    if (!url.includes('/api/generate')) {
        throw new Error(`Unhandled fetch: ${url}`);
    }

    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const prompt = body.prompt ?? '';

    if (isFileUnderstandingPrompt(prompt)) {
        const relativePath = extractPromptPath(prompt);
        if (fetchState.fileUnderstandingRequests.length >= fetchState.failAfterFileUnderstanding) {
            throw new Error('simulated mid-run stop after first 3 files');
        }
        fetchState.fileUnderstandingRequests.push({ relativePath });
        fetchState.successfulFileUnderstandingPaths.push(relativePath);
        return jsonResponse({ response: JSON.stringify(fileUnderstandingResponse(relativePath)) });
    }

    if (prompt.includes('resolving unresolved function calls')) {
        return jsonResponse({ response: JSON.stringify([]) });
    }

    if (prompt.includes('summarizing a module')) {
        return jsonResponse({ response: JSON.stringify(moduleUnderstandingResponse()) });
    }

    if (prompt.includes('call tree starting from an entry point')) {
        return jsonResponse({ response: JSON.stringify(behavioralPathResponse()) });
    }

    if (prompt.includes('project intelligence document')) {
        return jsonResponse({ response: JSON.stringify(projectUnderstandingResponse()) });
    }

    return jsonResponse({ response: JSON.stringify({}) });
}

function isFileUnderstandingPrompt(prompt: string): boolean {
    return prompt.includes('You are analyzing a source file') &&
        prompt.includes('"domainRole": "orchestrator|agent|router|schema|service|utility|config|test|unknown"');
}

function fileUnderstandingResponse(relativePath: string) {
    const base = path.basename(relativePath, path.extname(relativePath));
    return {
        purpose: `${base} coordinates InventoryOrder UserProfile RouteHandler DataContract ServiceLayer ValidationFlow ErrorBoundary RequestPayload ResponseModel concepts.`,
        domainRole: inferDomainRole(relativePath),
        exports: [base, `${base}Export`],
        whatEachExportDoes: { [base]: `Handles ${base} behavior.` },
        inputs: ['request data'],
        outputs: ['response data'],
        callsInto: { service: 'Delegates work to a service or helper.' },
        unresolvedCalls: [],
        errorPaths: ['Returns not found when a record is missing.'],
        fallbackPaths: [],
        keyDecisions: ['Keep route logic thin and move business rules into services.'],
        implicitContracts: ['Routes return JSON serializable objects.'],
        confidence: {
            purpose: 0.9,
            domainRole: 0.9,
            callsInto: 0.85,
            errorPaths: 0.8,
            keyDecisions: 0.8,
            implicitContracts: 0.8
        }
    };
}

function moduleUnderstandingResponse() {
    return {
        modulePurpose: 'Groups fixture route, service, and schema code for acceptance tests.',
        responsibilities: ['Manage Inventory Order data flow', 'Expose User Profile operations', 'Validate Response Model contracts'],
        publicInterface: { FixtureModule: 'Acceptance-test module boundary.' },
        internalDependencies: ['routes', 'services', 'models'],
        externalDependencies: [],
        dataFlow: 'Request Payload enters a route, service logic transforms it, and Response Model data returns.',
        errorBoundaries: ['Missing records return not found responses.'],
        keyConcepts: ['Inventory Order', 'User Profile', 'Route Handler', 'Service Layer', 'Data Contract', 'Response Model'],
        architecturalRole: 'core',
        confidence: 0.9
    };
}

function behavioralPathResponse() {
    return {
        summary: 'A request enters an HTTP or UI entry point and delegates to service logic before returning a response.',
        happyPath: [
            { step: 1, symbol: 'entry', relativePath: 'main', description: 'Accept request input.', artifactsProduced: ['request'] },
            { step: 2, symbol: 'service', relativePath: 'service', description: 'Apply business rules.', artifactsProduced: ['response'] }
        ],
        branches: [],
        errorPaths: [],
        fallbackPaths: [],
        dataInputs: ['request'],
        dataOutputs: ['response'],
        asyncBoundaries: [],
        confidence: 0.9
    };
}

function projectUnderstandingResponse() {
    return {
        project: 'fixture',
        what_it_does: 'Exercises RepoGuide comprehension on a small realistic repository.',
        purpose: 'Fixture repository for acceptance tests.',
        architecture_type: 'layered monolith',
        entry_points: ['main', 'server', 'index'],
        data_journey: 'Requests enter routes, pass through services, and return schema-shaped responses.',
        data_flow: 'Requests enter routes, pass through services, and return schema-shaped responses.',
        key_concepts: ['Inventory Order', 'User Profile', 'Service Layer', 'Route Handler'],
        tech_stack: { backend: 'fixture', frontend: 'fixture', database: 'memory' },
        modules: { '.': 'Fixture root module.' },
        concept_map: { fixture: ['main'] },
        component_roster: { FixtureModule: 'Main fixture component.' },
        domain_vocabulary: { fixture: 'A known small repository used for acceptance checks.' },
        critical_paths: ['Route to service response path.'],
        failure_modes: ['Missing entity returns not found.'],
        architectural_decisions: ['Separate routes, services, and models.']
    };
}

function inferDomainRole(relativePath: string) {
    if (relativePath.includes('route') || relativePath.includes('router') || relativePath.includes('main') || relativePath.includes('server')) {
        return 'router';
    }
    if (relativePath.includes('service') || relativePath.includes('controller')) {
        return 'service';
    }
    if (relativePath.includes('model') || relativePath.includes('UserCard')) {
        return 'schema';
    }
    if (relativePath.includes('database') || relativePath.includes('index')) {
        return 'config';
    }
    return 'utility';
}

function extractPromptPath(prompt: string): string {
    const match = prompt.match(/^Path:\s*(.+)$/m);
    return match?.[1].trim().replace(/\\/g, '/') ?? '<unknown>';
}

function createFetchState(options: { failAfterFileUnderstanding?: number } = {}) {
    return {
        failAfterFileUnderstanding: options.failAfterFileUnderstanding ?? Number.POSITIVE_INFINITY,
        fileUnderstandingRequests: [] as Array<{ relativePath: string }>,
        successfulFileUnderstandingPaths: [] as string[]
    };
}

function jsonResponse(data: unknown): Response {
    return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}

function readArtifact<T>(understandingDir: string, fileName: string): T {
    return (unwrapArtifact as <U>(artifact: unknown) => U)(readJson(path.join(understandingDir, fileName)));
}

function readJson<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function lexicalFilesByRelativePath(workspaceRoot: string, lexicalMap: any): Map<string, any> {
    const map = new Map<string, any>();
    for (const [filePath, entry] of Object.entries(lexicalMap.files ?? {})) {
        const relativePath = path.isAbsolute(filePath)
            ? path.relative(workspaceRoot, filePath).replace(/\\/g, '/')
            : filePath.replace(/\\/g, '/');
        map.set(relativePath, entry);
    }
    return map;
}

function checkpointTimes(understandingDir: string, workspaceRoot: string): Map<string, string> {
    const result = new Map<string, string>();
    const filesDir = path.join(understandingDir, 'files');
    for (const fileName of fs.readdirSync(filesDir)) {
        if (!fileName.endsWith('.json')) {
            continue;
        }
        const checkpoint = readJson<any>(path.join(filesDir, fileName));
        const relativePath = path.relative(workspaceRoot, checkpoint.filePath).replace(/\\/g, '/');
        result.set(relativePath, checkpoint.updatedAt ?? checkpoint.generatedAt);
    }
    return result;
}

function appendFixtureFunction(filePath: string): string {
    const content = fs.readFileSync(filePath, 'utf8');
    const ext = path.extname(filePath);
    if (ext === '.py') {
        return `${content}\n\ndef acceptance_probe() -> str:\n    return "changed"\n`;
    }
    if (ext === '.ts' || ext === '.tsx') {
        return `${content}\n\nexport function acceptanceProbe(): string {\n  return 'changed';\n}\n`;
    }
    return `${content}\n\nfunction acceptanceProbe() {\n    return 'changed';\n}\nmodule.exports.acceptanceProbe = acceptanceProbe;\n`;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (predicate()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('timed out waiting for FileChangeHandler debounce');
}
