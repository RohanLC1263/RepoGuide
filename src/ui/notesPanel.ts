import * as vscode from 'vscode';
import * as path from 'path';
import { wrapHtml, escapeHtml, escapeJs } from './htmlUtils';
import { resolveWorkspaceFilePath } from './workspacePathResolver';
import { NotesManager, DeveloperNote } from '../notes/notesManager';

let currentPanel: vscode.WebviewPanel | undefined;

export async function showNotesPanel(context: vscode.ExtensionContext, notesManager: NotesManager, workspaceRoot: string) {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
        currentPanel.webview.html = await buildNotesHtml(notesManager);
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'repoguide.notes',
        'RepoGuide: Notes',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    currentPanel.onDidDispose(() => {
        currentPanel = undefined;
    }, null, context.subscriptions);

    currentPanel.webview.onDidReceiveMessage(async message => {
        if (message.type === 'openFile') {
            const target = resolveWorkspaceFilePath(message.filePath, workspaceRoot);
            if (!target) {
                void vscode.window.showWarningMessage(`RepoGuide: refused to open a path outside the workspace: ${message.filePath}`);
                return;
            }
            const doc = await vscode.workspace.openTextDocument(target);
            await vscode.window.showTextDocument(doc, { preview: false });
        } else if (message.type === 'deleteNote') {
            await notesManager.deleteNote(message.id);
            if (currentPanel) {
                currentPanel.webview.html = await buildNotesHtml(notesManager);
            }
        }
    }, null, context.subscriptions);

    currentPanel.webview.html = await buildNotesHtml(notesManager);
}

export async function refreshNotesPanelIfOpen(notesManager: NotesManager) {
    if (currentPanel) {
        currentPanel.webview.html = await buildNotesHtml(notesManager);
    }
}

async function buildNotesHtml(notesManager: NotesManager): Promise<string> {
    const notes = await notesManager.loadNotes();
    
    const customJs = `
        function deleteNote(id) {
            if (confirm('Are you sure you want to delete this note?')) {
                vscode.postMessage({ type: 'deleteNote', id });
            }
        }
    `;

    if (notes.length === 0) {
        const emptyBody = `
            <section class="card" style="text-align: center; padding: 48px 24px;">
                <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">No Notes Yet</div>
                <div class="empty" style="margin-bottom: 16px;">Create notes using the "RepoGuide: Add Note" command from the command palette.</div>
            </section>
        `;
        return wrapHtml('Developer Notes', emptyBody) + `\n<script>\n${customJs}\n</script>`;
    }

    // Group notes by file
    const byFile: Record<string, DeveloperNote[]> = {};
    for (const n of notes) {
        const file = n.target_file || 'General';
        if (!byFile[file]) byFile[file] = [];
        byFile[file].push(n);
    }

    const groupsHtml = Object.entries(byFile).map(([file, fileNotes]) => {
        const fileTitle = file === 'General' ? 'General Notes' : path.basename(file);
        
        const noteItems = fileNotes.map(n => {
            const badgeClass = n.source === 'chat' ? 'badge-info' : 'badge-success';
            const timestamp = new Date(n.created_at).toLocaleDateString();
            
            return `
            <div style="margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--rg-border);">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                    <div>
                        <strong style="font-size: 14px;">${escapeHtml(n.title)}</strong>
                        <div style="font-size: 11px; margin-top: 4px; color: var(--rg-muted);">
                            <span class="badge ${badgeClass}" style="margin-right: 8px;">${escapeHtml(n.source)}</span>
                            ${escapeHtml(timestamp)}
                            ${n.target_symbol ? `<span class="mono" style="margin-left: 8px; padding: 2px 4px; background: var(--vscode-editor-background); border-radius: 3px;">${escapeHtml(n.target_symbol)}</span>` : ''}
                        </div>
                    </div>
                    <button class="secondary" onclick="deleteNote('${escapeJs(n.id)}')">Delete</button>
                </div>
                <div style="font-size: 13px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(n.content)}</div>
                ${n.tags && n.tags.length > 0 ? `<div style="margin-top: 8px;">${n.tags.map((t: string) => `<span class="inline" style="background: var(--vscode-editor-background); border: 1px solid var(--rg-border); border-radius: 4px;">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
            </div>`;
        }).join('');

        return `
        <section class="card" style="margin-bottom: 24px;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; border-bottom: 1px solid var(--rg-border); padding-bottom: 8px;">
                <h2 style="margin: 0; border: none; padding: 0;">${escapeHtml(fileTitle)}</h2>
                ${file !== 'General' ? `<button class="link inline" style="margin: 0;" onclick="openFile('${escapeJs(file)}')">Open File</button>` : ''}
            </div>
            <div>${noteItems}</div>
        </section>`;
    }).join('');

    const body = `
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px;">
            <div class="empty">You have ${notes.length} saved notes.</div>
        </div>
        ${groupsHtml}
    `;

    return wrapHtml('Developer Notes', body) + `\n<script>\n${customJs}\n</script>`;
}
