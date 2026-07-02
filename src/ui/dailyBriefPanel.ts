import * as vscode from 'vscode';
import * as path from 'path';
import { wrapHtml, escapeHtml, escapeJs } from './htmlUtils';
import { DailyBrief } from '../brief/dailyBriefService';

let currentPanel: vscode.WebviewPanel | undefined;

export function showDailyBriefPanel(context: vscode.ExtensionContext, brief: DailyBrief, workspaceRoot: string) {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
        currentPanel.webview.html = buildDailyBriefHtml(brief);
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'repoguide.dailyBrief',
        'RepoGuide: Daily Brief',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    currentPanel.onDidDispose(() => {
        currentPanel = undefined;
    }, null, context.subscriptions);

    currentPanel.webview.onDidReceiveMessage(async message => {
        if (message.type === 'openFile') {
            const target = path.isAbsolute(message.filePath) ? message.filePath : path.join(workspaceRoot, message.filePath);
            const doc = await vscode.workspace.openTextDocument(target);
            await vscode.window.showTextDocument(doc, { preview: false });
        }
    }, null, context.subscriptions);

    currentPanel.webview.html = buildDailyBriefHtml(brief);
}

function buildDailyBriefHtml(brief: DailyBrief): string {
    const sinceDate = new Date(brief.since).toLocaleString();
    
    // Changed Files
    const filesHtml = brief.changed_files.length > 0
        ? brief.changed_files.map(f => {
            const lastMod = f.last_modified ? new Date(f.last_modified).toLocaleTimeString() : '';
            return `
            <tr>
                <td><button class="link inline" onclick="openFile('${escapeJs(f.file)}')">${escapeHtml(path.basename(f.file))}</button></td>
                <td><span class="badge ${f.change_type === 'M' ? 'badge-warning' : f.change_type === 'A' ? 'badge-success' : 'badge-error'}">${escapeHtml(f.change_type || 'M')}</span></td>
                <td>${escapeHtml(f.commits?.join(', ') || '')}</td>
                <td><span class="empty">${escapeHtml(lastMod)}</span></td>
            </tr>`;
        }).join('')
        : '<tr><td colspan="4" class="empty">No file changes detected since the last session.</td></tr>';

    // Affected Modules
    const modulesHtml = brief.affected_modules.length > 0
        ? brief.affected_modules.map(m => `
            <div style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--rg-border);">
                <strong>${escapeHtml(m.name)}</strong>
                <div style="font-size: 11px; margin-top: 4px; color: var(--rg-muted);">${escapeHtml(m.summary || 'Module affected by recent changes.')}</div>
                <div style="margin-top: 4px;">${m.files.map(f => `<span class="inline mono">${escapeHtml(path.basename(f))}</span>`).join(' ')}</div>
            </div>`).join('')
        : '<p class="empty">No specific module impacts identified.</p>';

    // Stale Annotations
    const staleHtml = brief.stale_annotations.length > 0
        ? brief.stale_annotations.map(sa => `
            <div style="margin-bottom: 8px;">
                <button class="link inline" onclick="openFile('${escapeJs(sa.file)}')">${escapeHtml(path.basename(sa.file))}</button>
                <span class="warning" style="font-size: 11px;">${escapeHtml(sa.reason || 'Hash mismatch')}</span>
            </div>`).join('')
        : '<p class="empty">No stale annotations detected.</p>';

    // Related Notes
    const notesHtml = brief.related_notes.length > 0
        ? brief.related_notes.map(n => `
            <div style="margin-bottom: 8px;">
                <div style="font-weight: 500;">${escapeHtml(n.title)}</div>
                <div style="font-size: 11px; color: var(--rg-muted); margin-bottom: 4px;">For <button class="link inline" style="margin:0; padding:0; background:transparent;" onclick="openFile('${escapeJs(n.file)}')">${escapeHtml(path.basename(n.file))}</button></div>
                <div style="font-size: 12px; border-left: 3px solid var(--rg-border); padding-left: 8px;">${escapeHtml(n.content || '').substring(0, 100)}...</div>
            </div>`).join('')
        : '<p class="empty">No recent notes overlap with changed files.</p>';

    const body = `
        <section class="card" style="text-align: center; padding: 24px;">
            <div style="font-size: 16px; font-weight: 600; margin-bottom: 4px;">Welcome back to the workspace.</div>
            <div class="empty">Reviewing changes since ${escapeHtml(sinceDate)}</div>
        </section>
        
        <div style="display: flex; gap: 16px; flex-wrap: wrap;">
            <div style="flex: 2; min-width: 400px;">
                <section class="card">
                    <h2 style="display:flex; justify-content:space-between;"><span>Changed Files</span><span class="badge badge-info">${brief.changed_files.length}</span></h2>
                    <table style="margin-bottom: 0;">
                        <thead>
                            <tr><th>File</th><th>Type</th><th>Commits</th><th>Time</th></tr>
                        </thead>
                        <tbody>${filesHtml}</tbody>
                    </table>
                </section>
                
                <section class="card">
                    <h2>Affected Modules</h2>
                    <div>${modulesHtml}</div>
                </section>
            </div>
            
            <div style="flex: 1; min-width: 300px;">
                <section class="card">
                    <h2 style="display:flex; justify-content:space-between;"><span>Stale Annotations</span><span class="badge ${brief.stale_annotations.length > 0 ? 'badge-warning' : ''}">${brief.stale_annotations.length}</span></h2>
                    <div>${staleHtml}</div>
                </section>
                
                <section class="card">
                    <h2>Relevant Notes</h2>
                    <div>${notesHtml}</div>
                </section>
            </div>
        </div>
    `;

    return wrapHtml('Daily Brief', body);
}
