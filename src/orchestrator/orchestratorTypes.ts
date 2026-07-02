export type OrchestratorStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface OrchestratorState {
    id: string;
    lastFullRebuildStart: Date;
    lastFullRebuildEnd: Date | null;
    status: OrchestratorStatus;
    failedAtStep: string | null;
    diagnostics: string | null;
}

export interface RepositoryBuilder {
    build(): Promise<void>;
}
