import * as vscode from 'vscode';
import { RepositoryContext, Logger } from './repositoryContext';
import { RepoGuideLogger } from '../logging/repoguideLogger';

export class VSCodeContext implements RepositoryContext {
    public readonly workspaceRoot: string;
    public readonly repoguideDataDir?: string;
    public readonly logger: Logger;

    constructor(
        workspaceRoot: string,
        outputChannel: vscode.OutputChannel,
        repoguideDataDir?: string
    ) {
        this.workspaceRoot = workspaceRoot;
        this.repoguideDataDir = repoguideDataDir;
        this.logger = new RepoGuideLogger(outputChannel, repoguideDataDir);
    }

    getConfig<T>(key: string, defaultValue?: T): T {
        const config = vscode.workspace.getConfiguration('repoguide');
        return config.get<T>(key, defaultValue as T);
    }

    asRelativePath(absolutePath: string): string {
        return vscode.workspace.asRelativePath(absolutePath);
    }

    async notifyInfo(message: string): Promise<void> {
        await vscode.window.showInformationMessage(message);
    }

    async notifyWarning(message: string): Promise<void> {
        await vscode.window.showWarningMessage(message);
    }

    async notifyError(message: string): Promise<void> {
        await vscode.window.showErrorMessage(message);
    }
}

let globalContext: RepositoryContext | undefined;

export function setGlobalVSCodeContext(context: RepositoryContext): void {
    globalContext = context;
}

export function getGlobalVSCodeContext(): RepositoryContext {
    if (!globalContext) {
        globalContext = new VSCodeContext(
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
            vscode.window.createOutputChannel('RepoGuide Evidence Pipeline')
        );
    }
    return globalContext;
}
