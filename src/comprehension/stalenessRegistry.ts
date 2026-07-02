import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface StalenessEntry {
    dirtySince: string;
    triggerFiles: string[];
    reason: string;
}

export interface StalenessState {
    version: '1.0';
    artifacts: Record<string, StalenessEntry>;
}

export class StalenessRegistry {
    private readonly registryPath: string;
    private state: StalenessState;
    private readonly onDidChangeStalenessEmitter = new vscode.EventEmitter<void>();
    public readonly onDidChangeStaleness = this.onDidChangeStalenessEmitter.event;

    constructor(private readonly understandingDir: string) {
        this.registryPath = path.join(this.understandingDir, 'staleness_registry.json');
        this.state = this.loadState();
    }

    private loadState(): StalenessState {
        try {
            if (fs.existsSync(this.registryPath)) {
                const raw = fs.readFileSync(this.registryPath, 'utf8');
                const parsed = JSON.parse(raw);
                if (parsed.version === '1.0' && parsed.artifacts) {
                    return parsed as StalenessState;
                }
            }
        } catch {
            // Ignore parse errors, fallback to empty
        }
        return { version: '1.0', artifacts: {} };
    }

    private saveState(): void {
        try {
            if (!fs.existsSync(this.understandingDir)) {
                fs.mkdirSync(this.understandingDir, { recursive: true });
            }
            const tmpPath = `${this.registryPath}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf8');
            fs.renameSync(tmpPath, this.registryPath);
            this.onDidChangeStalenessEmitter.fire();
        } catch (error) {
            console.error('[StalenessRegistry] Failed to save state:', error);
        }
    }

    public markDirty(artifactIds: string[], triggerFile: string, reason: string): void {
        let changed = false;
        const now = new Date().toISOString();

        for (const id of artifactIds) {
            if (!this.state.artifacts[id]) {
                this.state.artifacts[id] = {
                    dirtySince: now,
                    triggerFiles: [triggerFile],
                    reason
                };
                changed = true;
            } else {
                const entry = this.state.artifacts[id];
                if (!entry.triggerFiles.includes(triggerFile)) {
                    entry.triggerFiles.push(triggerFile);
                    entry.reason = reason;
                    changed = true;
                }
            }
        }

        if (changed) {
            this.saveState();
        }
    }

    public clearDirty(artifactId: string): void {
        if (this.state.artifacts[artifactId]) {
            delete this.state.artifacts[artifactId];
            this.saveState();
        }
    }

    public isDirty(artifactId: string): boolean {
        return !!this.state.artifacts[artifactId];
    }

    public getDirtyState(artifactId: string): StalenessEntry | undefined {
        return this.state.artifacts[artifactId];
    }

    public getAllDirtyArtifacts(): string[] {
        return Object.keys(this.state.artifacts);
    }
}
