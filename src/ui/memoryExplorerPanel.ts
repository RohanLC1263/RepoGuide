import * as vscode from 'vscode';
import * as path from 'path';
import { wrapHtml, escapeHtml } from './htmlUtils';
import { LanceDbMemoryStore } from '../memory/lanceDbMemoryStore';
import { MemoryStoreFactory } from '../memory/memoryStoreFactory';
import { MemoryRecord } from '../memory/memoryTypes';

export interface MemoryExplorerDeps {
    context: vscode.ExtensionContext;
    workspaceRoot: string;
}

let memoryExplorerPanel: vscode.WebviewPanel | undefined;

export function registerMemoryExplorerPanel(deps: MemoryExplorerDeps): void {
    deps.context.subscriptions.push(
        vscode.commands.registerCommand('repoguide.memoryExplorerPanel', async () => {
            await showMemoryExplorerPanel(deps);
        })
    );
}

async function showMemoryExplorerPanel(deps: MemoryExplorerDeps): Promise<void> {
    if (memoryExplorerPanel) {
        memoryExplorerPanel.reveal(vscode.ViewColumn.One);
        return;
    }
    
    memoryExplorerPanel = vscode.window.createWebviewPanel(
        'repoguide.memoryExplorer',
        'RepoGuide: Memory Explorer',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    
    memoryExplorerPanel.onDidDispose(() => { memoryExplorerPanel = undefined; }, null, deps.context.subscriptions);
    
    // Initial loading state
    memoryExplorerPanel.webview.html = wrapHtml('Memory Explorer', '<p class="empty">Loading memories...</p>');
    
    try {
        const store = await getMemoryStore(deps.workspaceRoot);
        
        let currentTextQuery = '';

        const render = async () => {
            if (!memoryExplorerPanel) return;
            // Fetch memories
            const queryObj: any = { limit: 1000, includeStale: true };
            if (currentTextQuery.trim()) {
                queryObj.textQuery = currentTextQuery.trim();
                queryObj.limit = 100;
            }
            const memories = await store.search(queryObj);
            memoryExplorerPanel.webview.html = buildMemoryExplorerHtml(memories, currentTextQuery);
        };

        memoryExplorerPanel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'markStale') {
                await store.markStale(msg.id);
                await render();
            } else if (msg.command === 'reactivate') {
                const record = await store.getById(msg.id);
                if (record) {
                    record.stale = false;
                    await store.update(record);
                }
                await render();
            } else if (msg.command === 'semanticSearch') {
                currentTextQuery = msg.text || '';
                await render();
            }
        });

        await render();
    } catch (e) {
        memoryExplorerPanel.webview.html = wrapHtml(
            'Memory Explorer', 
            `<p class="error">Failed to load memories: ${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`
        );
    }
}

async function getMemoryStore(workspaceRoot: string): Promise<LanceDbMemoryStore> {
    return MemoryStoreFactory.getMemoryStore(workspaceRoot);
}

function buildMemoryExplorerHtml(memories: MemoryRecord[], currentTextQuery: string = ''): string {
    const activeCount = memories.filter(m => !m.stale).length;
    const staleCount = memories.filter(m => m.stale).length;
    
    // Simple custom JS for V1 UI (Filters and Expansion)
    const customJs = `
        const vscode = acquireVsCodeApi();

        function toggleRow(id) {
            const el = document.getElementById('details-' + id);
            if (el.style.display === 'none') {
                el.style.display = 'table-row';
            } else {
                el.style.display = 'none';
            }
        }
        
        function applyFilters() {
            const scopeFilter = document.getElementById('filter-scope').value;
            const statusFilter = document.getElementById('filter-status').value;
            const tagFilter = document.getElementById('filter-tag').value.toLowerCase();
            
            const rows = document.querySelectorAll('.memory-row');
            rows.forEach(row => {
                const scope = row.getAttribute('data-scope');
                const status = row.getAttribute('data-status');
                const tags = row.getAttribute('data-tags').toLowerCase();
                
                let show = true;
                if (scopeFilter !== 'all' && scope !== scopeFilter) show = false;
                if (statusFilter !== 'all' && status !== statusFilter) show = false;
                if (tagFilter && !tags.includes(tagFilter)) show = false;
                
                row.style.display = show ? 'table-row' : 'none';
                
                // Hide details if main row is hidden
                if (!show) {
                    const details = document.getElementById('details-' + row.getAttribute('data-id'));
                    if (details) details.style.display = 'none';
                }
            });
        }

        function markStale(id) {
            vscode.postMessage({ command: 'markStale', id });
        }

        function reactivate(id) {
            vscode.postMessage({ command: 'reactivate', id });
        }

        function submitSearch() {
            const input = document.getElementById('semantic-search-input');
            if (input) vscode.postMessage({ command: 'semanticSearch', text: input.value });
        }

        function clearSearch() {
            const input = document.getElementById('semantic-search-input');
            if (input) input.value = '';
            vscode.postMessage({ command: 'semanticSearch', text: '' });
        }

        window.addEventListener('DOMContentLoaded', () => {
            const searchInput = document.getElementById('semantic-search-input');
            if (searchInput) {
                searchInput.addEventListener('keypress', function(e) {
                    if (e.key === 'Enter') {
                        submitSearch();
                    }
                });
            }
        });
    `;

    const summarySection = `
        <div style="display: flex; gap: 16px; margin-bottom: 16px;">
            <div class="card" style="flex: 1; text-align: center; margin: 0; padding: 16px;">
                <div style="font-size: 24px; font-weight: 600; color: var(--rg-success);">${activeCount}</div>
                <div class="empty" style="font-size: 11px; text-transform: uppercase;">Active Memories</div>
            </div>
            <div class="card" style="flex: 1; text-align: center; margin: 0; padding: 16px;">
                <div style="font-size: 24px; font-weight: 600; color: var(--rg-warning);">${staleCount}</div>
                <div class="empty" style="font-size: 11px; text-transform: uppercase;">Stale Memories</div>
            </div>
        </div>
    `;

    const filterSection = `
        <section class="card" style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 16px; padding: 12px 16px;">
            <div style="display: flex; align-items: center; gap: 8px; width: 100%; border-bottom: 1px solid var(--rg-border); padding-bottom: 12px; margin-bottom: 4px;">
                <label style="font-size: 12px; color: var(--rg-muted); font-weight: 600;">Semantic Search:</label>
                <input type="text" id="semantic-search-input" value="${escapeHtml(currentTextQuery)}" placeholder="Search by meaning or keyword..." style="flex-grow: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px 8px;">
                <button onclick="submitSearch()" style="background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 16px; cursor: pointer; border-radius: 2px;">Search</button>
                <button onclick="clearSearch()" style="background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 6px 16px; cursor: pointer; border-radius: 2px;">Clear</button>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
                <label style="font-size: 12px; color: var(--rg-muted);">Scope:</label>
                <select id="filter-scope" onchange="applyFilters()" style="background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 4px;">
                    <option value="all">All Scopes</option>
                    <option value="repository">Repository</option>
                    <option value="file">File</option>
                    <option value="symbol">Symbol</option>
                    <option value="mentor">Mentor</option>
                </select>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
                <label style="font-size: 12px; color: var(--rg-muted);">Status:</label>
                <select id="filter-status" onchange="applyFilters()" style="background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 4px;">
                    <option value="all">All</option>
                    <option value="active">Active Only</option>
                    <option value="stale">Stale Only</option>
                </select>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; flex-grow: 1;">
                <label style="font-size: 12px; color: var(--rg-muted);">Tags:</label>
                <input type="text" id="filter-tag" onkeyup="applyFilters()" placeholder="Filter by tag..." style="flex-grow: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px;">
            </div>
        </section>
    `;

    const sortedMemories = [...memories].sort((a, b) => {
        const timeA = new Date(a.provenance?.timestamp || 0).getTime();
        const timeB = new Date(b.provenance?.timestamp || 0).getTime();
        return timeB - timeA; // Descending
    });

    const rows = sortedMemories.map(m => {
        const safeId = escapeHtml(m.id);
        const statusClass = m.stale ? 'badge-warning' : 'badge-success';
        const statusText = m.stale ? 'STALE' : 'ACTIVE';
        const truncatedContent = m.content.length > 80 ? m.content.substring(0, 80).replace(/\\n/g, ' ') + '...' : m.content.replace(/\\n/g, ' ');
        const tagsStr = (m.tags || []).join(', ');
        
        // Relative age approximation
        const age = m.provenance?.timestamp ? calculateAge(m.provenance.timestamp) : 'unknown';

        const actionButton = m.stale 
            ? `<button onclick="reactivate('${safeId}')" style="margin-top: 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 2px;">Reactivate</button>`
            : `<button onclick="markStale('${safeId}')" style="margin-top: 12px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 2px;">Mark Stale</button>`;

        return `
            <tr class="memory-row" data-id="${safeId}" data-scope="${escapeHtml(m.scope)}" data-status="${m.stale ? 'stale' : 'active'}" data-tags="${escapeHtml(tagsStr)}" style="cursor: pointer; border-bottom: 1px solid var(--rg-border);" onclick="toggleRow('${safeId}')">
                <td style="padding: 8px;"><span class="badge ${statusClass}">${statusText}</span></td>
                <td style="padding: 8px; font-weight: 600;">${escapeHtml(m.scope.toUpperCase())}</td>
                <td style="padding: 8px; color: var(--rg-fg); max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(truncatedContent)}</td>
                <td style="padding: 8px; color: var(--rg-muted);">${escapeHtml(tagsStr)}</td>
                <td style="padding: 8px; color: var(--rg-muted); font-size: 11px;">${age}</td>
            </tr>
            <tr id="details-${safeId}" style="display: none; background: var(--vscode-editor-background);">
                <td colspan="5" style="padding: 16px; border-bottom: 2px solid var(--rg-border);">
                    <div style="display: flex; gap: 24px;">
                        <div style="flex: 2;">
                            <strong style="color: var(--rg-muted); font-size: 11px; text-transform: uppercase;">Full Content</strong>
                            <div style="margin-top: 8px; padding: 12px; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--rg-link); white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 12px;">${escapeHtml(m.content)}</div>
                        </div>
                        <div style="flex: 1;">
                            <strong style="color: var(--rg-muted); font-size: 11px; text-transform: uppercase;">Metadata</strong>
                            <ul style="list-style: none; padding: 0; margin: 8px 0 0 0; font-size: 12px; line-height: 1.8;">
                                <li><strong>ID:</strong> <span class="mono">${safeId}</span></li>
                                <li><strong>ScopeKeys:</strong> <span class="mono" style="word-break: break-all;">${escapeHtml(JSON.stringify(m.scopeKeys || []))}</span></li>
                                <li><strong>Author:</strong> ${escapeHtml(m.provenance?.authorType || 'unknown')}</li>
                                <li><strong>Timestamp:</strong> ${escapeHtml(m.provenance?.timestamp || 'unknown')}</li>
                            </ul>
                            ${actionButton}
                        </div>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    const tableSection = `
        <div class="card" style="padding: 0; overflow-x: auto;">
            <table style="width: 100%; text-align: left; border-collapse: collapse;">
                <thead style="background: var(--vscode-editor-background); border-bottom: 1px solid var(--rg-border);">
                    <tr>
                        <th style="padding: 12px 8px; font-weight: 500; font-size: 12px; color: var(--rg-muted);">STATUS</th>
                        <th style="padding: 12px 8px; font-weight: 500; font-size: 12px; color: var(--rg-muted);">SCOPE</th>
                        <th style="padding: 12px 8px; font-weight: 500; font-size: 12px; color: var(--rg-muted);">CONTENT</th>
                        <th style="padding: 12px 8px; font-weight: 500; font-size: 12px; color: var(--rg-muted);">TAGS</th>
                        <th style="padding: 12px 8px; font-weight: 500; font-size: 12px; color: var(--rg-muted);">AGE</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
            ${rows.length === 0 ? '<p class="empty" style="padding: 24px;">No memories found.</p>' : ''}
        </div>
    `;

    return wrapHtml('Memory Explorer', summarySection + filterSection + tableSection) + `\n<script>\n${customJs}\n</script>`;
}

function calculateAge(timestamp: string): string {
    const time = new Date(timestamp).getTime();
    if (isNaN(time)) return 'unknown';
    
    const diff = Date.now() - time;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    
    if (hours < 1) return 'Just now';
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
