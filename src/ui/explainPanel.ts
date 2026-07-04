import * as path from 'path';
import * as vscode from 'vscode';
import { wrapHtml, escapeHtml } from './htmlUtils';

export interface ExplainPanelOptions {
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
}

/**
 * Opens a side panel and streams a project-aware explanation for a selected code region.
 */
export async function streamExplain(
    stream: AsyncIterable<string>,
    options: ExplainPanelOptions
): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
        'repoguide.explain',
        `RepoGuide: Explain ${path.basename(options.filePath)}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );

    const headerLabel = `${path.basename(options.filePath)}  ${options.startLine + 1}-${options.endLine + 1}  ${options.language}`;
    const body = `
        <div class="empty" style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Project-aware explanation</div>
        <div class="meta">${escapeHtml(headerLabel)}</div>
        <div id="content" class="explain-content thinking">Thinking through the selected code in repository context...</div>
    `;
    panel.webview.html = wrapHtml('Selected code', body, `
        .meta {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            color: var(--rg-muted);
            border: 1px solid var(--rg-border);
            border-radius: 6px;
            padding: 6px 10px;
            margin-bottom: 16px;
        }
        .explain-content { white-space: pre-wrap; line-height: 1.65; font-size: 13px; }
        .explain-content.thinking { color: var(--rg-muted); }
        .explain-done { margin-top: 16px; padding-top: 10px; border-top: 1px solid var(--rg-border); color: var(--rg-muted); font-size: 12px; }
        .explain-error { margin-top: 16px; color: var(--rg-error); }
    `) + `
    <script>
        const contentDiv = document.getElementById('content');
        let isFirstToken = true;

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'token') {
                if (isFirstToken) {
                    contentDiv.textContent = '';
                    contentDiv.classList.remove('thinking');
                    isFirstToken = false;
                }
                contentDiv.textContent += message.value;
            } else if (message.type === 'done') {
                const doneEl = document.createElement('div');
                doneEl.className = 'explain-done';
                doneEl.textContent = 'Done';
                contentDiv.appendChild(doneEl);
            } else if (message.type === 'error') {
                const errEl = document.createElement('div');
                errEl.className = 'explain-error';
                errEl.textContent = message.value;
                contentDiv.appendChild(errEl);
            }
        });
    </script>`;

    try {
        for await (const token of stream) {
            await panel.webview.postMessage({ type: 'token', value: token });
        }
        await panel.webview.postMessage({ type: 'done' });
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await panel.webview.postMessage({ type: 'error', value: `Error: ${errorMsg}` });
        await panel.webview.postMessage({ type: 'done' });
    }
}
