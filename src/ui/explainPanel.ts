import * as path from 'path';
import * as vscode from 'vscode';

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
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Explain</title>
    <style>
        :root {
            color-scheme: light dark;
        }
        body {
            margin: 0;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
        }
        .shell {
            padding: 16px 18px 24px;
            max-width: 980px;
        }
        .eyebrow {
            font-size: 11px;
            letter-spacing: 0;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 6px;
        }
        .title {
            font-size: 20px;
            font-weight: 600;
            margin: 0 0 10px;
        }
        .meta {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            border: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.2));
            border-radius: 6px;
            padding: 6px 10px;
            margin-bottom: 16px;
        }
        .content {
            white-space: pre-wrap;
            line-height: 1.65;
            font-size: 13px;
        }
        .thinking {
            color: var(--vscode-descriptionForeground);
        }
        .done {
            margin-top: 16px;
            padding-top: 10px;
            border-top: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.2));
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .error {
            margin-top: 16px;
            color: var(--vscode-errorForeground);
        }
    </style>
</head>
<body>
    <div class="shell">
        <div class="eyebrow">Project-aware explanation</div>
        <h1 class="title">Selected code</h1>
        <div class="meta">${headerLabel}</div>
        <div id="content" class="content thinking">Thinking through the selected code in repository context...</div>
    </div>
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
                doneEl.className = 'done';
                doneEl.textContent = 'Done';
                contentDiv.appendChild(doneEl);
            } else if (message.type === 'error') {
                const errEl = document.createElement('div');
                errEl.className = 'error';
                errEl.textContent = message.value;
                contentDiv.appendChild(errEl);
            }
        });
    </script>
</body>
</html>`;

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
