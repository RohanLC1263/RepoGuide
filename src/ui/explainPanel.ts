import * as path from 'path';
import * as vscode from 'vscode';
import { wrapHtml, escapeHtml } from './htmlUtils';
import { classifyAnswerStreamToken } from '../query/answerStreamTokens';

export interface ExplainPanelOptions {
    filePath: string;
    startLine: number;
    endLine: number;
    language: string;
    /** Extension install root, used to load the shared gate-chip renderer
     *  (`webviews/sidebar/gateStatusRendering.js`) into this panel. Optional so
     *  the panel still works (minus the chip) for any caller without it. */
    extensionUri?: vscode.Uri;
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
        options.extensionUri
            ? {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(options.extensionUri, 'webviews')]
            }
            : { enableScripts: true }
    );

    // Reuse the sidebar's gate-chip derivation rather than restating the chip
    // text/class mapping here -- gateStatusRendering.js is the single source of
    // truth for it (and is asserted against answerGate.ts by
    // src/test/webviews/gateStatusRendering.test.ts). If the URI can't be built
    // the chip is simply omitted; the explanation itself is unaffected.
    const gateScriptUri = options.extensionUri
        ? panel.webview.asWebviewUri(
            vscode.Uri.joinPath(options.extensionUri, 'webviews', 'sidebar', 'gateStatusRendering.js')
        )
        : undefined;

    const headerLabel = `${path.basename(options.filePath)}  ${options.startLine + 1}-${options.endLine + 1}  ${options.language}`;
    const body = `
        <div class="empty" style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Project-aware explanation</div>
        <div class="meta">${escapeHtml(headerLabel)}<span id="gate-chip" class="gate-chip" hidden></span></div>
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
        .gate-chip { border-radius: 10px; padding: 1px 8px; font-size: 11px; font-weight: 600; }
        .gate-status-pass { color: var(--rg-success); }
        .gate-status-revise { color: var(--rg-warning); }
        .gate-status-block { color: var(--rg-error); }
        .gate-status-unverified { color: var(--rg-muted); }
    `) + (gateScriptUri ? `<script src="${gateScriptUri}"></script>` : '') + `
    <script>
        const contentDiv = document.getElementById('content');
        const gateChip = document.getElementById('gate-chip');
        let isFirstToken = true;

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'gateStatus') {
                if (gateChip && typeof RepoGuideGateStatus !== 'undefined') {
                    const info = RepoGuideGateStatus.deriveGateChipInfo(message.status);
                    gateChip.textContent = info.text;
                    gateChip.className = 'gate-chip ' + info.className.split(' ').pop();
                    gateChip.title = info.title;
                    gateChip.hidden = false;
                }
            } else if (message.type === 'token') {
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
            const classified = classifyAnswerStreamToken(token);
            if (classified.kind === 'control') {
                if (classified.type === 'gateStatus') {
                    await panel.webview.postMessage({ type: 'gateStatus', status: classified.payload.status });
                }
                // Any other control token is dispatcher bookkeeping this panel
                // has no use for -- dropped, never concatenated into the prose.
                continue;
            }
            await panel.webview.postMessage({ type: 'token', value: classified.value });
        }
        await panel.webview.postMessage({ type: 'done' });
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await panel.webview.postMessage({ type: 'error', value: `Error: ${errorMsg}` });
        await panel.webview.postMessage({ type: 'done' });
    }
}
