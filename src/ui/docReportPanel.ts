import { RepositoryContext } from '../context/repositoryContext';
import * as vscode from 'vscode';
import { QueryDispatcher } from '../query/queryDispatcher';
import { wrapHtml } from './htmlUtils';

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

        const body = `
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                <span id="status" class="badge badge-info">Generating...</span>
                <button id="copyBtn" onclick="copyToClipboard()">Copy to Clipboard</button>
            </div>
            <pre id="content" class="mono" style="white-space: pre-wrap; word-wrap: break-word; font-size: 12px; line-height: 1.7; background: var(--rg-card-bg); border: 1px solid var(--rg-border); border-radius: 6px; padding: 20px; max-height: calc(100vh - 220px); overflow-y: auto;">Analyzing codebase and generating documentation...</pre>
        `;
        panel.webview.html = wrapHtml('Documentation Report', body) + `
        <script>
            const content = document.getElementById('content');
            const status = document.getElementById('status');
            const copyBtn = document.getElementById('copyBtn');
            let started = false;

            function copyToClipboard() {
                navigator.clipboard.writeText(content.textContent).then(() => {
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => { copyBtn.textContent = 'Copy to Clipboard'; }, 2000);
                });
            }

            window.addEventListener('message', event => {
                const msg = event.data;
                if (msg.type === 'token') {
                    if (!started) {
                        content.textContent = '';
                        started = true;
                    }
                    content.textContent += msg.value;
                    content.scrollTop = content.scrollHeight;
                } else if (msg.type === 'done') {
                    status.textContent = 'Complete';
                    status.className = 'badge badge-success';
                }
            });
        </script>`;

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
