export function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function escapeJs(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function escapeAttr(value: string): string {
    return escapeHtml(value).replace(/'/g, '&#39;');
}

export function unescapeAttr(value: string): string {
    return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

export function wrapHtml(title: string, body: string, customCss?: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
:root {
    color-scheme: light dark;
    --rg-bg: var(--vscode-editor-background);
    --rg-fg: var(--vscode-editor-foreground);
    --rg-border: var(--vscode-panel-border, rgba(127,127,127,0.25));
    --rg-muted: var(--vscode-descriptionForeground);
    --rg-accent: var(--vscode-button-background);
    --rg-accent-hover: var(--vscode-button-hoverBackground);
    --rg-accent-fg: var(--vscode-button-foreground);
    --rg-link: var(--vscode-textLink-foreground);
    --rg-success: var(--vscode-testing-iconPassed);
    --rg-warning: var(--vscode-testing-iconQueued);
    --rg-error: var(--vscode-testing-iconFailed);
    --rg-card-bg: var(--vscode-editorWidget-background);
}
body {
    margin: 0;
    padding: 24px 32px;
    background: var(--rg-bg);
    color: var(--rg-fg);
    font-family: var(--vscode-font-family);
    font-size: 13px;
    line-height: 1.5;
    max-width: 1200px;
    margin-left: auto;
    margin-right: auto;
}
h1 { font-size: 20px; font-weight: 600; margin: 0 0 24px; color: var(--rg-fg); }
h2 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--rg-muted); margin: 0 0 12px; border-bottom: 1px solid var(--rg-border); padding-bottom: 4px; }
h3 { font-size: 14px; font-weight: 600; margin: 16px 0 8px; }
p { margin: 0 0 12px; }
section { margin: 0 0 32px; }
.card {
    background: var(--rg-card-bg);
    border: 1px solid var(--rg-border);
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 16px;
}
.metric-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.metric-label { flex: 0 0 200px; font-size: 12px; }
.metric-value { font-weight: 600; font-size: 12px; }
.hero, .picker, .summary { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
.metric { border: 1px solid var(--rg-border); border-radius: 6px; padding: 12px 16px; min-width: 160px; background: var(--rg-card-bg); }
.metric strong { display: block; font-size: 22px; font-weight: 600; margin-bottom: 4px; }
.metric span, .empty { color: var(--rg-muted); font-size: 12px; }
.warn strong, .error { color: var(--rg-error); }
.success { color: var(--rg-success); }
.warning { color: var(--rg-warning); }
button, .link {
    border: 1px solid transparent;
    background: var(--rg-accent);
    color: var(--rg-accent-fg);
    border-radius: 4px;
    padding: 6px 12px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    font-weight: 500;
    transition: background 0.15s ease;
}
button:hover { background: var(--rg-accent-hover); }
.link {
    background: transparent;
    color: var(--rg-link);
    border: 1px solid var(--rg-border);
    margin: 0 6px 6px 0;
}
.link:hover {
    background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.1));
}
.inline { padding: 2px 6px; margin: 0 4px 4px 0; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); }
textarea, input[type="text"] {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--rg-border));
    border-radius: 4px;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 13px;
    margin-bottom: 12px;
    box-sizing: border-box;
}
textarea:focus, input[type="text"]:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
textarea { min-height: 92px; resize: vertical; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--rg-border); vertical-align: top; }
th { font-weight: 600; color: var(--rg-muted); }
tr:hover td { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.04)); }
.badge { border-radius: 12px; padding: 2px 8px; font-size: 11px; font-weight: 600; display: inline-block; }
.badge-success { color: var(--rg-success); background: color-mix(in srgb, var(--rg-success) 15%, transparent); border: 1px solid color-mix(in srgb, var(--rg-success) 30%, transparent); }
.badge-warning { color: var(--rg-warning); background: color-mix(in srgb, var(--rg-warning) 15%, transparent); border: 1px solid color-mix(in srgb, var(--rg-warning) 30%, transparent); }
.badge-error { color: var(--rg-error); background: color-mix(in srgb, var(--rg-error) 15%, transparent); border: 1px solid color-mix(in srgb, var(--rg-error) 30%, transparent); }
.badge-info { color: var(--vscode-textLink-foreground); background: color-mix(in srgb, var(--vscode-textLink-foreground) 15%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 30%, transparent); }
.bar { height: 8px; border-radius: 4px; background: var(--vscode-panel-border, rgba(127,127,127,0.15)); overflow: hidden; flex: 1; min-width: 180px; }
.bar span { display: block; height: 100%; background: var(--rg-success); transition: width 0.3s ease; }
.mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
.flex-row { display: flex; gap: 8px; align-items: center; }
.flex-col { display: flex; flex-direction: column; gap: 8px; }
.action-grid { display: flex; flex-wrap: wrap; gap: 8px; }
${customCss ?? ''}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
<script>
const vscode = acquireVsCodeApi();
function openFile(filePath, startLine) { vscode.postMessage({ type: 'openFile', filePath, startLine }); }
</script>
</body>
</html>`;
}
