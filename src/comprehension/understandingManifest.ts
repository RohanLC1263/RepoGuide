import * as crypto from 'crypto';
import { wrapArtifact, unwrapArtifact } from './schema-versions';
import * as fs from 'fs';
import * as path from 'path';

export const UNDERSTANDING_MANIFEST_VERSION = '1.0';

export const UNDERSTANDING_STAGES = [
    'static_analysis',
    'lexical_map',
    'import_graph',
    'type_annotation_map',
    'decorator_map',
    'inheritance_map',
    'call_graph_v1',
    'call_graph_gap_fill',
    'file_understanding',
    'module_understanding',
    'concept_map',
    'behavioral_paths',
    'project_synthesis',
    'validation'
] as const;

export type UnderstandingStageName = typeof UNDERSTANDING_STAGES[number];

export type UnderstandingStageStatus =
    | 'pending'
    | 'running'
    | 'complete'
    | 'failed'
    | 'stale';

export interface UnderstandingStageManifest {
    status: UnderstandingStageStatus;
    startedAt: string | null;
    completedAt: string | null;
    error: string | null;
    artifactPaths: string[];
    inputHash: string | null;
    stats: Record<string, unknown>;
}

export interface UnderstandingManifest {
    version: string;
    projectRoot: string;
    overallStatus: UnderstandingStageStatus;
    createdAt: string;
    updatedAt: string;
    stages: Record<UnderstandingStageName, UnderstandingStageManifest>;
}

export function getManifestPath(understandingDir: string): string {
    return path.join(understandingDir, 'manifest.json');
}

export function createUnderstandingManifest(
    projectRoot: string,
    now = new Date().toISOString()
): UnderstandingManifest {
    const stages = {} as Record<UnderstandingStageName, UnderstandingStageManifest>;
    for (const stage of UNDERSTANDING_STAGES) {
        stages[stage] = createEmptyStage();
    }

    return {
        version: UNDERSTANDING_MANIFEST_VERSION,
        projectRoot,
        overallStatus: 'pending',
        createdAt: now,
        updatedAt: now,
        stages
    };
}

export async function loadUnderstandingManifest(
    understandingDir: string,
    projectRoot: string
): Promise<UnderstandingManifest> {
    const manifestPath = getManifestPath(understandingDir);
    if (!fs.existsSync(manifestPath)) {
        return createUnderstandingManifest(projectRoot);
    }

    try {
        const raw = await fs.promises.readFile(manifestPath, 'utf8');
        const parsed = unwrapArtifact<Partial<UnderstandingManifest>>(JSON.parse(raw));
        return normalizeManifest(parsed, projectRoot);
    } catch {
        return createUnderstandingManifest(projectRoot);
    }
}

export async function saveUnderstandingManifest(
    understandingDir: string,
    manifest: UnderstandingManifest
): Promise<void> {
    await fs.promises.mkdir(understandingDir, { recursive: true });
    const manifestPath = getManifestPath(understandingDir);
    const tmpPath = manifestPath + '.tmp';
    const envelope = wrapArtifact('manifest.json', manifest);
    await fs.promises.writeFile(tmpPath, JSON.stringify(envelope, null, 2), 'utf8');
    await fs.promises.rename(tmpPath, manifestPath);
}

export function markStageStarted(
    manifest: UnderstandingManifest,
    stage: UnderstandingStageName,
    inputHash: string | null,
    now = new Date().toISOString()
): UnderstandingManifest {
    return updateStage(manifest, stage, {
        status: 'running',
        startedAt: now,
        completedAt: null,
        error: null,
        inputHash
    }, now);
}

export function markStageComplete(
    manifest: UnderstandingManifest,
    stage: UnderstandingStageName,
    artifactPaths: string[],
    stats: Record<string, unknown>,
    now = new Date().toISOString()
): UnderstandingManifest {
    return updateStage(manifest, stage, {
        status: 'complete',
        completedAt: now,
        error: null,
        artifactPaths,
        stats
    }, now);
}

export function markStageFailed(
    manifest: UnderstandingManifest,
    stage: UnderstandingStageName,
    error: unknown,
    now = new Date().toISOString()
): UnderstandingManifest {
    return updateStage(manifest, stage, {
        status: 'failed',
        completedAt: now,
        error: formatError(error)
    }, now);
}

export function updateStage(
    manifest: UnderstandingManifest,
    stage: UnderstandingStageName,
    patch: Partial<UnderstandingStageManifest>,
    now = new Date().toISOString()
): UnderstandingManifest {
    return {
        ...manifest,
        overallStatus: deriveOverallStatus({
            ...manifest.stages,
            [stage]: {
                ...manifest.stages[stage],
                ...patch
            }
        }),
        updatedAt: now,
        stages: {
            ...manifest.stages,
            [stage]: {
                ...manifest.stages[stage],
                ...patch
            }
        }
    };
}

export function hashManifestInput(value: unknown): string {
    return crypto
        .createHash('sha256')
        .update(stableStringify(value))
        .digest('hex');
}

function normalizeManifest(
    parsed: Partial<UnderstandingManifest>,
    projectRoot: string
): UnderstandingManifest {
    const now = new Date().toISOString();
    const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : now;
    const stages = {} as Record<UnderstandingStageName, UnderstandingStageManifest>;

    for (const stage of UNDERSTANDING_STAGES) {
        const existing = parsed.stages?.[stage] as Partial<UnderstandingStageManifest> | undefined;
        stages[stage] = {
            ...createEmptyStage(),
            ...existing,
            status: normalizeStatus(existing?.status),
            startedAt: typeof existing?.startedAt === 'string' ? existing.startedAt : null,
            completedAt: typeof existing?.completedAt === 'string' ? existing.completedAt : null,
            error: typeof existing?.error === 'string' ? existing.error : null,
            artifactPaths: Array.isArray(existing?.artifactPaths)
                ? existing.artifactPaths.filter(item => typeof item === 'string')
                : [],
            inputHash: typeof existing?.inputHash === 'string' ? existing.inputHash : null,
            stats: isRecord(existing?.stats) ? existing.stats : {}
        };
    }

    return {
        version: typeof parsed.version === 'string'
            ? parsed.version
            : UNDERSTANDING_MANIFEST_VERSION,
        projectRoot: typeof parsed.projectRoot === 'string' ? parsed.projectRoot : projectRoot,
        overallStatus: normalizeStatus(parsed.overallStatus) === 'pending'
            ? deriveOverallStatus(stages)
            : normalizeStatus(parsed.overallStatus),
        createdAt,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : createdAt,
        stages
    };
}

function deriveOverallStatus(stages: Record<UnderstandingStageName, UnderstandingStageManifest>): UnderstandingStageStatus {
    const statuses = Object.values(stages).map(stage => stage.status);
    if (statuses.some(status => status === 'failed')) {
        return 'failed';
    }
    if (statuses.some(status => status === 'running')) {
        return 'running';
    }
    if (statuses.every(status => status === 'complete')) {
        return 'complete';
    }
    if (statuses.some(status => status === 'stale')) {
        return 'stale';
    }
    return 'pending';
}

function createEmptyStage(): UnderstandingStageManifest {
    return {
        status: 'pending',
        startedAt: null,
        completedAt: null,
        error: null,
        artifactPaths: [],
        inputHash: null,
        stats: {}
    };
}

function normalizeStatus(value: unknown): UnderstandingStageStatus {
    return value === 'running' ||
        value === 'complete' ||
        value === 'failed' ||
        value === 'stale'
        ? value
        : 'pending';
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack || error.message;
    }
    return String(error);
}

function stableStringify(value: unknown): string {
    return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortForStableStringify);
    }
    if (isRecord(value)) {
        return Object.keys(value)
            .sort()
            .reduce<Record<string, unknown>>((acc, key) => {
                acc[key] = sortForStableStringify(value[key]);
                return acc;
            }, {});
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
