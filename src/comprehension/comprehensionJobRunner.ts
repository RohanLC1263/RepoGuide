import * as path from 'path';
import * as fs from 'fs';
import { ComprehensionEngine } from './comprehensionEngine';
import {
    loadUnderstandingManifest,
    UNDERSTANDING_STAGES,
    UnderstandingManifest,
    UnderstandingStageName,
    UnderstandingStageStatus
} from './understandingManifest';
import { ArtifactConfidenceReport } from './artifactConfidenceReport';

export interface ComprehensionJobOutput {
    appendLine: (s: string) => void;
}

// Validation is a future stage in the manifest, but Phase 0 does not build it yet.
export const RUNNABLE_COMPREHENSION_STAGES = UNDERSTANDING_STAGES.filter(
    stage => stage !== 'validation'
) as Exclude<UnderstandingStageName, 'validation'>[];

export class ComprehensionJobRunner {
    private isRunning = false;

    constructor(
        private engine: ComprehensionEngine,
        private repoguideDir: string,
        private outputChannel: ComprehensionJobOutput
    ) {}

    async run(workspaceRoot: string): Promise<boolean> {
        if (this.isRunning) {
            this.outputChannel.appendLine(
                '[Info] Comprehension job already running; skipping duplicate request.'
            );
            return false;
        }

        if (!(await this.needsRepair(workspaceRoot))) {
            this.outputChannel.appendLine('[Info] All comprehension stages complete. Skipping.');
            return false;
        }

        this.isRunning = true;
        await this.saveJobState(workspaceRoot, 'running');
        this.outputChannel.appendLine('[Info] Comprehension job started.');

        try {
            await this.engine.runFullComprehension(workspaceRoot);
            
            this.outputChannel.appendLine('[Info] Generating Artifact Confidence Report...');
            try {
                ArtifactConfidenceReport.generate(getUnderstandingDir(this.repoguideDir));
            } catch (err) {
                this.outputChannel.appendLine(`[Warn] Failed to generate confidence report: ${err instanceof Error ? err.message : String(err)}`);
            }

            await this.saveJobState(workspaceRoot, 'complete');
            this.outputChannel.appendLine('[Info] Comprehension job complete.');
            return true;
        } catch (error) {
            await this.saveJobState(workspaceRoot, 'failed', error);
            throw error;
        } finally {
            this.isRunning = false;
        }
    }

    scheduleRepair(
        workspaceRoot: string,
        delayMs = 5000,
        onComplete?: () => void | Promise<void>
    ): void {
        setTimeout(() => {
            this.run(workspaceRoot)
                .then(didRun => {
                    if (didRun) {
                        return onComplete?.();
                    }
                    return undefined;
                })
                .catch(error => {
                    const message = error instanceof Error ? error.message : String(error);
                    this.outputChannel.appendLine('[Warn] Comprehension repair failed: ' + message);
                });
        }, delayMs);
    }

    async needsRepair(workspaceRoot: string): Promise<boolean> {
        const manifest = await this.loadManifest(workspaceRoot);
        return getMissingStages(manifest).length > 0;
    }

    async getMissingStages(workspaceRoot: string): Promise<string[]> {
        const manifest = await this.loadManifest(workspaceRoot);
        return getMissingStages(manifest);
    }

    getIsRunning(): boolean {
        return this.isRunning;
    }

    private async loadManifest(workspaceRoot: string): Promise<UnderstandingManifest> {
        return loadUnderstandingManifest(getUnderstandingDir(this.repoguideDir), workspaceRoot);
    }

    private async saveJobState(
        workspaceRoot: string,
        status: 'running' | 'complete' | 'failed',
        error?: unknown
    ): Promise<void> {
        const understandingDir = getUnderstandingDir(this.repoguideDir);
        await fs.promises.mkdir(understandingDir, { recursive: true });
        const statePath = path.join(understandingDir, 'job.json');
        const state = {
            status,
            workspaceRoot,
            updatedAt: new Date().toISOString(),
            error: error ? formatError(error) : null
        };
        const tmpPath = statePath + '.tmp';
        await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
        await fs.promises.rename(tmpPath, statePath);
    }
}

export function getMissingStages(manifest: UnderstandingManifest): string[] {
    return RUNNABLE_COMPREHENSION_STAGES.filter(stage => {
        const status = manifest.stages[stage]?.status;
        return isRepairStatus(status);
    });
}

export function isRepairStatus(status: UnderstandingStageStatus | undefined): boolean {
    return status !== 'complete';
}

function getUnderstandingDir(repoguideDir: string): string {
    return path.join(repoguideDir, 'understanding');
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack || error.message;
    }
    return String(error);
}
