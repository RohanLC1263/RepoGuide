export interface RepoGuideConfig {
    inferenceModel?: string;
    planningModel?: string;
    tokenBudget?: number;
    ollamaUrl?: string;
    excludePatterns?: string[];
    performanceMode?: string;
    queryArchitecture?: string;
    memory?: { bridge?: { enabled?: boolean } };
    captureTerminalErrors?: boolean;
    [key: string]: any;
}

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface StageProgressOptions {
    stageName: string;
    current: number;
    total: number;
    failed?: number;
    cached?: number;
}

export interface ArtifactWriteOptions {
    artifactName: string;
    stats?: Record<string, number | string>;
    sizeBytes?: number;
}

export interface QueryLogOptions {
    query: string;
    intent?: string;
    retrievalSources?: string[];
    answerTimeMs?: number;
    tokenCount?: number;
}

export interface RepairLogOptions {
    action: 'queued' | 'started' | 'complete' | 'failed';
    repairType: string;
    target: string;
    blameScore?: number;
    durationSec?: number;
    error?: string;
}

export interface Logger {
    appendLine(message: string): void;
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    stageStart(stageName: string, totalItems?: number): void;
    stageProgress(opts: StageProgressOptions): void;
    stageComplete(stageName: string, stats?: { total?: number; failed?: number; durationSec?: number }): void;
    stageFailed(stageName: string, error: string | Error, context?: string): void;
    artifactWritten(opts: ArtifactWriteOptions): void;
    queryLog(opts: QueryLogOptions): void;
    repairLog(opts: RepairLogOptions): void;
}

export interface RepositoryContext {
    readonly workspaceRoot: string;
    readonly repoguideDataDir?: string;

    getConfig<T>(key: string, defaultValue?: T): T;

    asRelativePath(absolutePath: string): string;

    readonly logger: Logger;

    notifyInfo(message: string): Promise<void> | void;
    notifyWarning(message: string): Promise<void> | void;
    notifyError(message: string): Promise<void> | void;
}
