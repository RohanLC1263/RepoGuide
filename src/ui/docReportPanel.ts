import { RepositoryContext } from '../context/repositoryContext';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { QueryDispatcher } from '../query/queryDispatcher';

/**
 * Generates a documentation report by streaming QueryDispatcher.runDocumentationReport()
 * (whole-repo, folder-bucketed evidence sourced via LanceStoreProvider, gated by
 * AnswerGate) into a styled WebviewPanel. Previously did its own direct LanceStore
 * iteration + prompt build, bypassing the canonical pipeline entirely
 * (ARCHITECTURE_CONFORMANCE_REPORT check 1).
 */
export async function generateDocReport(repoContext: RepositoryContext, queryDispatcher: QueryDispatcher, extensionUri: vscode.Uri): Promise<void> {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'RepoGuide: Generating documentation report...',
        cancellable: true
    }, async (progress, token) => {
        const panel = vscode.window.createWebviewPanel(
            'repoguide.docreport',
            'RepoGuide: Documentation Report',
            vscode.ViewColumn.One,
            { enableScripts: true, localResourceRoots: [extensionUri] }
        );

        const htmlPath = vscode.Uri.joinPath(extensionUri, 'webviews', 'docreport', 'report.html');
        const htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf-8');
        panel.webview.html = htmlContent;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);

        try {
            for await (const chunkToken of queryDispatcher.runDocumentationReport(controller.signal)) {
                if (token.isCancellationRequested) {
                    controller.abort();
                    break;
                }
                await panel.webview.postMessage({ type: 'token', value: chunkToken });
            }
            clearTimeout(timeoutId);
            await panel.webview.postMessage({ type: 'done' });
        } catch (e: any) {
            clearTimeout(timeoutId);
            if (e.name === 'AbortError') {
                await panel.webview.postMessage({ type: 'token', value: '\n\n[RepoGuide: Report generation timed out or was cancelled]' });
            } else {
                const errStr = e instanceof Error ? e.message : String(e);
                await panel.webview.postMessage({ type: 'token', value: `\n\nError: ${errStr}` });
            }
            await panel.webview.postMessage({ type: 'done' });
        }
    });
}
