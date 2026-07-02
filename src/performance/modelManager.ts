import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class ModelManager {
    private lastQueryTime = Date.now();
    private idleTimer: NodeJS.Timeout | null = null;
    private isQueryActive = false;

    constructor(
        private outputChannel: vscode.OutputChannel,
        private idleTimeoutSeconds: number = 300
    ) {}

    async checkVRAM(): Promise<number> {
        try {
            const { stdout } = await execAsync(
                'nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits'
            );
            const firstGpu = stdout
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)[0];
            const freeVRAM = Number.parseInt(firstGpu ?? '', 10);
            return Number.isFinite(freeVRAM) ? freeVRAM : 8000;
        } catch {
            return 8000;
        }
    }

    async ensureModelLoaded(model: string, ollamaUrl: string): Promise<boolean> {
        const freeVRAM = await this.checkVRAM();
        this.outputChannel.appendLine(`[Info] Free VRAM: ${freeVRAM}MB`);

        if (freeVRAM < 1000) {
            void vscode.window.showWarningMessage(
                'RepoGuide: Low GPU memory. Close other GPU applications for best performance.',
                'Dismiss'
            );
        }

        try {
            const response = await fetch(`${ollamaUrl}/api/tags`, {
                signal: AbortSignal.timeout(3000) as RequestInit['signal']
            });
            if (!response.ok) {
                this.outputChannel.appendLine(
                    `[Warn] Ollama health check failed before loading ${model}: ${response.status} ${response.statusText}`
                );
            }
            return response.ok;
        } catch {
            void vscode.window.showErrorMessage(
                'RepoGuide: Ollama is not running. Start it with: ollama serve',
                'Dismiss'
            );
            return false;
        }
    }

    recordQueryActivity(): void {
        this.lastQueryTime = Date.now();

        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }

        if (this.idleTimeoutSeconds <= 0) {
            return;
        }

        this.idleTimer = setTimeout(() => {
            this.onIdle();
        }, this.idleTimeoutSeconds * 1000);
    }

    dispose(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    private onIdle(): void {
        if (this.isQueryActive) {
            return;
        }
        const idleSeconds = Math.round((Date.now() - this.lastQueryTime) / 1000);
        const idleMinutes = Math.max(1, Math.round(idleSeconds / 60));
        this.outputChannel.appendLine(
            `[Info] RepoGuide idle for ${idleMinutes} minutes. Model will unload from VRAM on next Ollama GC cycle.`
        );
    }

    setQueryActive(active: boolean): void {
        this.isQueryActive = active;
        if (active) {
            this.recordQueryActivity();
        } else {
            // Restart the idle timer from zero so the 5-minute countdown begins from query completion
            this.recordQueryActivity();
        }
    }

    getKeepAliveParam(isBackgroundTask: boolean): string {
        return isBackgroundTask ? '60s' : '300s';
    }
}
