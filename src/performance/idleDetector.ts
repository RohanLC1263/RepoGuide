import * as vscode from 'vscode';

export class IdleDetector implements vscode.Disposable {
    private lastActivityTime = Date.now();
    private disposables: vscode.Disposable[] = [];
    private idleCallbacks: Array<() => void> = [];
    private activeCallbacks: Array<() => void> = [];
    private wasIdle = false;
    private interval: NodeJS.Timeout;

    constructor(private idleThresholdMs: number = 10000) {
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(() => {
                this.recordActivity();
            })
        );
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => {
                this.recordActivity();
            })
        );

        this.interval = setInterval(() => {
            this.checkIdleTransition();
        }, 1000);
    }

    private recordActivity(): void {
        const wasIdle = this.isIdle();
        this.lastActivityTime = Date.now();

        if (wasIdle || this.wasIdle) {
            this.wasIdle = false;
            this.activeCallbacks.forEach(callback => callback());
        }
    }

    private checkIdleTransition(): void {
        const isIdleNow = this.isIdle();
        if (isIdleNow && !this.wasIdle) {
            this.wasIdle = true;
            this.idleCallbacks.forEach(callback => callback());
        }
    }

    isIdle(): boolean {
        return Date.now() - this.lastActivityTime > this.idleThresholdMs;
    }

    onBecomeIdle(callback: () => void): void {
        this.idleCallbacks.push(callback);
    }

    onBecomeActive(callback: () => void): void {
        this.activeCallbacks.push(callback);
    }

    dispose(): void {
        clearInterval(this.interval);
        this.disposables.forEach(disposable => disposable.dispose());
    }
}
