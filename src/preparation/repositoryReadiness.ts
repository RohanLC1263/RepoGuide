import * as fs from 'fs';
import * as path from 'path';
import { RepositoryArtifactPaths, getRepositoryArtifactPaths } from './repositoryPaths';
import { LanceStore } from '../store/lanceStore';
import { Bm25Store } from '../store/bm25Store';
import { LogicalUnitBm25Store } from '../store/logicalUnitBm25Store';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { FactStore } from '../store/factStore';
import { SymbolIndex } from '../indexing/symbolIndex';
import { ProgramGraphStore } from '../store/programGraphStore';
import { IndexManifestStore } from '../indexing/indexManifest';

export type ReadinessStatus = 'READY' | 'PARTIAL' | 'EMPTY' | 'FAILED';

export interface ArtifactHealth {
    name: string;
    path: string;
    required: boolean;
    exists: boolean;
    populated: boolean;
    recordCount: number;
    version: string;
    freshness: 'fresh' | 'stale' | 'unknown';
    buildTimestamp?: string;
    status: ReadinessStatus;
    diagnostics: string[];
}

export interface ProviderReadiness {
    providerId: string;
    status: ReadinessStatus;
    backingArtifacts: string[];
    diagnostics: string[];
}

export interface RepositoryReadinessReport {
    schemaVersion: '1.0';
    workspaceRoot: string;
    repoguideDir: string;
    generatedAt: string;
    status: ReadinessStatus;
    artifacts: ArtifactHealth[];
    providers: ProviderReadiness[];
    summary: {
        requiredArtifacts: number;
        readyRequiredArtifacts: number;
        failedRequiredArtifacts: number;
        emptyRequiredArtifacts: number;
        readyProviders: number;
        totalProviders: number;
    };
    diagnostics: string[];
}

export async function buildRepositoryReadinessReport(
    workspaceRoot: string,
    repoguideDir?: string
): Promise<RepositoryReadinessReport> {
    const paths = getRepositoryArtifactPaths(workspaceRoot, repoguideDir);
    const artifacts: ArtifactHealth[] = [
        await inspectLogicalUnits(paths),
        await inspectFacts(paths),
        await inspectSymbols(paths),
        await inspectProgramGraph(paths),
        await inspectBm25(paths),
        await inspectLogicalUnitBm25(paths),
        await inspectLance(paths),
        await inspectManifest(paths),
        await inspectRepositoryBrain(paths),
        await inspectUnderstanding(paths)
    ];
    const providers = buildProviderReadiness(artifacts);
    const required = artifacts.filter(artifact => artifact.required);
    const failedRequired = required.filter(artifact => artifact.status === 'FAILED').length;
    const emptyRequired = required.filter(artifact => artifact.status === 'EMPTY').length;
    const readyRequired = required.filter(artifact => artifact.status === 'READY').length;
    const status = failedRequired > 0
        ? 'FAILED'
        : emptyRequired > 0
            ? 'EMPTY'
            : readyRequired === required.length
                ? 'READY'
                : 'PARTIAL';
    const diagnostics = [
        ...artifacts.flatMap(artifact => artifact.diagnostics.map(message => `${artifact.name}: ${message}`)),
        ...providers.flatMap(provider => provider.diagnostics.map(message => `${provider.providerId}: ${message}`))
    ];

    return {
        schemaVersion: '1.0',
        workspaceRoot: paths.workspaceRoot,
        repoguideDir: paths.repoguideDir,
        generatedAt: new Date().toISOString(),
        status,
        artifacts,
        providers,
        summary: {
            requiredArtifacts: required.length,
            readyRequiredArtifacts: readyRequired,
            failedRequiredArtifacts: failedRequired,
            emptyRequiredArtifacts: emptyRequired,
            readyProviders: providers.filter(provider => provider.status === 'READY').length,
            totalProviders: providers.length
        },
        diagnostics
    };
}

export async function writeRepositoryReadinessReport(report: RepositoryReadinessReport): Promise<void> {
    const paths = getRepositoryArtifactPaths(report.workspaceRoot, report.repoguideDir);
    await fs.promises.mkdir(path.dirname(paths.preparationReport), { recursive: true });
    await fs.promises.writeFile(paths.preparationReport, JSON.stringify(report, null, 2), 'utf8');
}

export function assertRepositoryReady(report: RepositoryReadinessReport): void {
    if (report.status === 'READY') {
        return;
    }
    const blocking = report.artifacts
        .filter(artifact => artifact.required && artifact.status !== 'READY')
        .map(artifact => `${artifact.name}=${artifact.status} (${artifact.path}) count=${artifact.recordCount}`);
    throw new Error([
        'RepoGuide repository preparation is incomplete.',
        ...blocking.map(item => `- ${item}`),
        `Run the canonical preparation workflow for ${report.workspaceRoot} before querying or evaluating.`
    ].join('\n'));
}

async function inspectLogicalUnits(paths: RepositoryArtifactPaths): Promise<ArtifactHealth> {
    return inspectStore('logical_units', paths.logicalUnitsDb, true, async () => {
        const store = new LogicalUnitStore(paths.repoguideDir);
        await store.init(paths.workspaceRoot);
        return (await store.listIndexes({ limit: Number.POSITIVE_INFINITY })).length;
    });
}

async function inspectFacts(paths: RepositoryArtifactPaths): Promise<ArtifactHealth> {
    return inspectStore('facts', paths.factsDb, true, async () => {
        const store = new FactStore(paths.repoguideDir);
        await store.init(paths.workspaceRoot);
        return (await store.queryFacts({ limit: Number.POSITIVE_INFINITY })).length;
    });
}

async function inspectSymbols(paths: RepositoryArtifactPaths): Promise<ArtifactHealth> {
    return inspectStore('symbols', paths.symbols, true, async () => {
        const index = new SymbolIndex();
        await index.load(paths.repoguideDir);
        return index.getStats().totalSymbols;
    });
}

async function inspectProgramGraph(paths: RepositoryArtifactPaths): Promise<ArtifactHealth> {
    return inspectStore('program_graph', paths.programGraph, true, async () => {
        const store = new ProgramGraphStore();
        await store.load(paths.workspaceRoot);
        const stats = store.getStats();
        return stats ? stats.nodeCount + stats.edgeCount : 0;
    });
}

async function inspectBm25(paths: RepositoryArtifactPaths): Promise<ArtifactHealth> {
    return inspectStore('bm25', paths.bm25Index, true, async () => {
        const store = new Bm25Store(paths.repoguideDir);
        await store.init();
        return await store.getChunkCount();
    }, () => segmentedIndexExists(paths.bm25Index));
}

async function inspectLogicalUnitBm25(paths: RepositoryArtifactPaths): Promise<ArtifactHealth> {
    return inspectStore('logical_unit_bm25', paths.logicalUnitBm25Index, true, async () => {
        const store = new LogicalUnitBm25Store(paths.repoguideDir);
        await store.init();
        return store.getIndexedCount();
    });
}

async function inspectLance(paths: RepositoryArtifactPaths): Promise<ArtifactHealth> {
    const chunksTablePath = path.join(paths.lanceDbDir, 'chunks.lance');
    return inspectStore('lance_chunks', chunksTablePath, true, async () => {
        const store = new LanceStore(paths.lanceDbDir);
        await store.init();
        return await store.getChunkCount();
    }, () => fs.existsSync(chunksTablePath) || fs.existsSync(path.join(paths.lanceDbDir, 'chunks_alt.lance')));
}

async function inspectManifest(paths: RepositoryArtifactPaths): Promise<ArtifactHealth> {
    return inspectStore('manifest', paths.manifest, true, async () => {
        const manifest = new IndexManifestStore(paths.repoguideDir);
        await manifest.init();
        return manifest.getAllPaths().length;
    });
}

async function inspectRepositoryBrain(paths: RepositoryArtifactPaths): Promise<ArtifactHealth> {
    return inspectStore('repository_brain', paths.repositoryBrainDb, false, async () => 0);
}

async function inspectUnderstanding(paths: RepositoryArtifactPaths): Promise<ArtifactHealth> {
    return inspectStore('comprehension_artifacts', paths.understandingDir, false, async () => {
        if (!fs.existsSync(paths.understandingDir)) {
            return 0;
        }
        return (await fs.promises.readdir(paths.understandingDir)).filter(name => name.endsWith('.json')).length;
    });
}

async function inspectStore(
    name: string,
    artifactPath: string,
    required: boolean,
    countRecords: () => Promise<number>,
    existsCheck: () => boolean = () => fs.existsSync(artifactPath)
): Promise<ArtifactHealth> {
    const exists = existsCheck();
    const diagnostics: string[] = [];
    let recordCount = 0;
    let status: ReadinessStatus = exists ? 'EMPTY' : 'FAILED';

    try {
        if (exists) {
            recordCount = await countRecords();
            status = recordCount > 0 ? 'READY' : 'EMPTY';
        } else if (!required) {
            status = 'EMPTY';
        }
    } catch (error) {
        status = 'FAILED';
        diagnostics.push(error instanceof Error ? error.message : String(error));
    }

    if (!exists) {
        diagnostics.push('Artifact is missing.');
    } else if (recordCount === 0) {
        diagnostics.push('Artifact exists but is empty.');
    }

    return {
        name,
        path: artifactPath,
        required,
        exists,
        populated: recordCount > 0,
        recordCount,
        version: '1.0',
        freshness: exists ? 'unknown' : 'stale',
        buildTimestamp: exists ? fileMtimeIso(artifactPath) : undefined,
        status,
        diagnostics
    };
}

function buildProviderReadiness(artifacts: ArtifactHealth[]): ProviderReadiness[] {
    const byName = new Map(artifacts.map(artifact => [artifact.name, artifact]));
    const statusFor = (names: string[]): ReadinessStatus => {
        const selected = names.map(name => byName.get(name)).filter((artifact): artifact is ArtifactHealth => Boolean(artifact));
        if (selected.some(artifact => artifact.status === 'FAILED')) return 'FAILED';
        if (selected.every(artifact => artifact.status === 'READY')) return 'READY';
        if (selected.some(artifact => artifact.status === 'READY')) return 'PARTIAL';
        return 'EMPTY';
    };
    const diagnosticsFor = (names: string[]) =>
        names.flatMap(name => byName.get(name)?.diagnostics.map(message => `${name}: ${message}`) ?? []);

    return [
        provider('symbol_index', ['symbols'], statusFor, diagnosticsFor),
        provider('fact_store', ['facts'], statusFor, diagnosticsFor),
        provider('logical_unit_store', ['logical_units'], statusFor, diagnosticsFor),
        provider('program_graph', ['program_graph'], statusFor, diagnosticsFor),
        provider('hybrid_retrieval', ['lance_chunks', 'bm25'], statusFor, diagnosticsFor),
        provider('repository_brain', ['repository_brain'], statusFor, diagnosticsFor)
    ];
}

function provider(
    providerId: string,
    backingArtifacts: string[],
    statusFor: (names: string[]) => ReadinessStatus,
    diagnosticsFor: (names: string[]) => string[]
): ProviderReadiness {
    return {
        providerId,
        status: statusFor(backingArtifacts),
        backingArtifacts,
        diagnostics: diagnosticsFor(backingArtifacts)
    };
}

/**
 * Bm25Store's SegmentedMiniSearchIndex (see src/store/segmentedMiniSearchIndex.ts)
 * writes into one of two generation directories -- "<name>_segments" (generation 0)
 * or "<name>_segments_alt" (generation 1) -- and atomically flips which one is live
 * via commitRebuild(). A plain fs.existsSync() on the generation-0 path alone goes
 * FAILED/EMPTY the moment a rebuild flips to generation 1, even though the store's
 * own generation-aware init() reads the real data fine (confirmed live: CraftConnect
 * reported "bm25: FAILED (0 records)" here while an independent Bm25Store instance
 * against the same directory returned a real, non-zero document count and working
 * search results). LogicalUnitBm25Store also sits on SegmentedMiniSearchIndex but
 * never calls beginRebuild()/commitRebuild(), so it never leaves generation 0 and
 * does not need this treatment.
 */
function segmentedIndexExists(segmentsDirGen0: string): boolean {
    return fs.existsSync(segmentsDirGen0) || fs.existsSync(`${segmentsDirGen0}_alt`);
}

function fileMtimeIso(filePath: string): string | undefined {
    try {
        return fs.statSync(filePath).mtime.toISOString();
    } catch {
        return undefined;
    }
}
