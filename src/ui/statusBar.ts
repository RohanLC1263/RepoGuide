import * as vscode from 'vscode';

export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private readyText = '$(check) RepoGuide: Ready';

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.text = 'RepoGuide: Ready';
    }

    show(): void {
        this.statusBarItem.show();
    }

    setIndexing(): void {
        this.statusBarItem.text = '$(sync~spin) RepoGuide: Indexing...';
    }

    setIndexingProgress(current: number, total: number): void {
        this.statusBarItem.text = `$(sync~spin) RepoGuide: Indexing (${current}/${total} files)...`;
    }

    setReady(chunkCount: number): void {
        this.readyText = `$(check) RepoGuide: Ready (${chunkCount} chunks)`;
        this.statusBarItem.text = this.readyText;
    }

    setHealth(summary: string): void {
        this.readyText = `$(pulse) ${summary}`;
        this.statusBarItem.text = this.readyText;
    }

    setError(msg: string): void {
        this.statusBarItem.text = `$(error) RepoGuide: ${msg}`;
    }

    setSynced(): void {
        this.statusBarItem.text = '$(check) RepoGuide: Synced';
        setTimeout(() => {
            if (this.statusBarItem.text === '$(check) RepoGuide: Synced') {
                this.statusBarItem.text = this.readyText;
            }
        }, 3000);
    }

    setAnswering(confidence: 'high' | 'medium' | 'low'): void {
        const label = confidence.charAt(0).toUpperCase() + confidence.slice(1);
        this.statusBarItem.text = `RepoGuide: Answering... [${label} confidence]`;
    }

    restoreReady(): void {
        this.statusBarItem.text = this.readyText;
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}
