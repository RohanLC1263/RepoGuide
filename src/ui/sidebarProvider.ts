import * as vscode from 'vscode';
import * as fs from 'fs';
import { NavigationTarget } from '../comprehension/types';
import { ChatPipeline } from '../query/hybridQueryPipeline';
import { ConversationHistory } from '../query/conversationHistory';
import { IndexManager } from '../indexing/indexManager';
import { ContextAccumulator } from '../query/contextAccumulator';
import { SessionWorkingSet } from '../query/sessionWorkingSet';
import { IndexHealthProvider } from './indexHealthProvider';
import { LanceStore } from '../store/lanceStore';
import { DecorationManager } from './decorationManager';
import { FeedbackHandler } from '../cache/feedbackHandler';
import { FeedbackCaptureService } from '../feedback/feedbackCaptureService';

/**
 * Provides the sidebar webview for RepoGuide's chat interface.
 * Loads index.html + sidebar.js from webviews/sidebar/.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'repoguide-rightchat';

    private _view?: vscode.WebviewView;
    private _isWebviewReady = false;
    private _readyResolvers: (() => void)[] = [];
    private activeAbortController: AbortController | null = null;
    private healthPollTimer?: NodeJS.Timeout;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private pipeline: ChatPipeline,
        private history: ConversationHistory,
        private indexManager: IndexManager,
        private accumulator: ContextAccumulator,
        private workingSet: SessionWorkingSet,
        private indexHealthProvider: IndexHealthProvider,
        private store: LanceStore,
        private decorationManager: DecorationManager,
        private feedbackHandler?: FeedbackHandler,
        private feedbackCaptureService?: FeedbackCaptureService
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        this._isWebviewReady = false;

        webviewView.onDidDispose(() => {
            this._view = undefined;
            this._isWebviewReady = false;
        });

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        // Build the webview URI for sidebar.js so it can be loaded via <script src>
        const sidebarJsUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'webviews', 'sidebar', 'sidebar.js')
        );

        const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'webviews', 'sidebar', 'index.html');
        let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf-8');

        // Replace the relative script src with the proper webview URI
        htmlContent = htmlContent.replace(
            'src="sidebar.js"',
            `src="${sidebarJsUri}"`
        );

        webviewView.webview.html = htmlContent;

        webviewView.webview.onDidReceiveMessage(async (data) => {
            if (data.type === 'ready') {
                this._isWebviewReady = true;
                for (const resolve of this._readyResolvers) {
                    resolve();
                }
                this._readyResolvers = [];
                await this.postIndexHealth(webviewView.webview);
            } else if (data.type === 'question') {
                this.activeAbortController = new AbortController();
                try {
                    for await (const chatToken of this.pipeline.query(
                        data.value,
                        this.activeAbortController.signal,
                        async confidence => {
                            await webviewView.webview.postMessage({ type: 'confidence', data: confidence });
                        }
                    )) {
                        const trimmed = chatToken.trim();
                        if (trimmed.startsWith('{"__type":"navigationResult"')) {
                            try {
                                const parsed = JSON.parse(trimmed) as { targets: NavigationTarget[]; primaryTarget: NavigationTarget | null; intent: string; queryId: string };
                                await webviewView.webview.postMessage({ type: 'navigationResult', data: parsed });
                                if (parsed.primaryTarget) {
                                    await this.openNavigationTarget(parsed.primaryTarget);
                                }
                                continue;
                            } catch {
                                // Fall through and treat it as a regular token.
                            }
                        }
                        if (trimmed.startsWith('{"__type":"feedbackContext"')) {
                            try {
                                await webviewView.webview.postMessage({ type: 'feedbackContext', data: JSON.parse(trimmed) });
                                continue;
                            } catch {
                                // Fall through and treat it as a regular token.
                            }
                        }
                        if (trimmed.startsWith('{"__type":"answerMetadata"')) {
                            try {
                                await webviewView.webview.postMessage({ type: 'answerMetadata', data: JSON.parse(trimmed).metadata });
                                continue;
                            } catch {
                                // Fall through and treat it as a regular token.
                            }
                        }
                        if (trimmed.startsWith('{"__type":"answerProvenance"')) {
                            try {
                                await webviewView.webview.postMessage({ type: 'answerProvenance', data: JSON.parse(trimmed).provenance });
                                continue;
                            } catch {
                                // Fall through and treat it as a regular token.
                            }
                        }
                        await webviewView.webview.postMessage({ type: 'token', value: chatToken });
                    }
                    await webviewView.webview.postMessage({ type: 'done' });
                } catch (e) {
                    if (e instanceof Error && e.name === 'AbortError') {
                        await webviewView.webview.postMessage({ type: 'cancelled' });
                    } else {
                        const errStr = e instanceof Error ? e.message : String(e);
                        await webviewView.webview.postMessage({ type: 'error', value: errStr });
                    }
                } finally {
                    this.activeAbortController = null;
                }
            } else if (data.type === 'cancel') {
                if (this.activeAbortController) {
                    this.activeAbortController.abort();
                    this.activeAbortController = null;
                }
            } else if (data.type === 'reset') {
                if (this.activeAbortController) {
                    this.activeAbortController.abort();
                    this.activeAbortController = null;
                }
                this.history.clear();
                this.accumulator.clear();
                this.workingSet.clear();
            } else if (data.type === 'resync') {
                const confirmed = await vscode.window.showWarningMessage(
                    'This will delete and rebuild the entire index. This may take several minutes. Continue?',
                    { modal: true },
                    'Continue'
                );
                if (confirmed === 'Continue') {
                    await this.indexManager.forceFullReindex();
                    await this.postIndexHealth(webviewView.webview);
                }
            } else if (data.type === 'getSessionInfo') {
                await webviewView.webview.postMessage({
                    type: 'systemMessage',
                    text: this.workingSet.getSessionSummary()
                });
            } else if (data.type === 'viewIndexDetails') {
                const health = await this.indexHealthProvider.getHealthData();
                await webviewView.webview.postMessage({
                    type: 'systemMessage',
                    text: this.indexHealthProvider.formatHealthSummary(health)
                });
                await this.postIndexHealth(webviewView.webview);
            } else if (data.command === 'openFile') {
                try {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(data.file));
                    const startLine = Math.max(0, parseInt(data.line_start) - 1);
                    const endLine = Math.max(0, parseInt(data.line_end) - 1);
                    const range = new vscode.Range(startLine, 0, endLine, Number.MAX_VALUE);
                    await vscode.window.showTextDocument(doc, { selection: range, preview: true });
                } catch (e) {
                    console.error('Failed to open file citation', e);
                }
            } else if (data.type === 'openFile') {
                if (typeof data.value === 'string') {
                    await this.openFileFromFooter(String(data.value ?? ''));
                } else if (data.value && typeof data.value === 'object') {
                    await this.openNavigationTarget(data.value as NavigationTarget);
                }
            } else if (data.type === 'cacheFeedback' && this.feedbackHandler) {
                if (data.positive) {
                    this.feedbackHandler.recordPositive(data.pairId);
                } else {
                    this.feedbackHandler.recordNegative(data.pairId);
                }
            } else if (data.type === 'answerFeedback' && this.feedbackCaptureService) {
                if (data.positive === false && typeof data.queryId === 'string' && typeof data.answerId === 'string' && typeof data.sessionId === 'string') {
                    this.feedbackCaptureService.logExplicitNegative(data.queryId, data.answerId, data.sessionId);
                }
            }
        });
    }

    private async postIndexHealth(webview: vscode.Webview): Promise<void> {
        const [health, topFolders] = await Promise.all([
            this.indexHealthProvider.getHealthData(),
            this.indexHealthProvider.getTopIndexedFolders()
        ]);
        await webview.postMessage({
            type: 'indexHealth',
            data: { ...health, topFolders }
        });

        if (health.isIndexing && !this.healthPollTimer) {
            this.healthPollTimer = setInterval(async () => {
                if (this._view && this.indexManager.getIsIndexing()) {
                    await this.postIndexHealth(this._view.webview);
                } else if (this.healthPollTimer) {
                    clearInterval(this.healthPollTimer);
                    this.healthPollTimer = undefined;
                    if (this._view) {
                        await this.postIndexHealth(this._view.webview);
                    }
                }
            }, 3000);
        }
    }

    private async openFileFromFooter(filePath: string): Promise<void> {
        if (!filePath) {
            return;
        }
        const chunks = await this.store.getChunksByFile(filePath);
        if (chunks.length > 0) {
            await this.decorationManager.highlightLocation({
                filePath,
                startLine: chunks[0].startLine,
                endLine: chunks[0].endLine
            });
            return;
        }
        const document = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
    }

    private async openNavigationTarget(target: NavigationTarget): Promise<void> {
        if (!target?.filePath) {
            return;
        }
        await this.decorationManager.navigateTo(target);
    }

    private async _waitForReady(): Promise<void> {
        if (this._isWebviewReady && this._view) {
            return;
        }
        return new Promise(resolve => {
            this._readyResolvers.push(resolve);
        });
    }

    public async explainCode(prompt: string, selectedText: string) {
        // Focus the sidebar first to ensure it's loaded and visible
        await vscode.commands.executeCommand('repoguide-rightchat.focus');

        // Robustly wait for the webview frontend to declare it has attached listeners
        await this._waitForReady();

        if (this._view && this._isWebviewReady) {
            // First add the user's action to the chat
            const displayCode = selectedText.length > 200 ? selectedText.substring(0, 200) + '...' : selectedText;
            await this._view.webview.postMessage({ type: 'addMessage', role: 'user', value: `Explain this code:\n\n${displayCode}` });

            // Route through the pipeline for context-aware explanation
            this.activeAbortController = new AbortController();
            try {
                for await (const token of this.pipeline.query(
                    prompt,
                    this.activeAbortController.signal
                )) {
                    await this._view.webview.postMessage({ type: 'token', value: token });
                }
                await this._view.webview.postMessage({ type: 'done' });
            } catch (e) {
                if (e instanceof Error && e.name === 'AbortError') {
                    await this._view.webview.postMessage({ type: 'cancelled' });
                } else {
                    const errStr = e instanceof Error ? e.message : String(e);
                    await this._view.webview.postMessage({ type: 'error', value: errStr });
                }
            } finally {
                this.activeAbortController = null;
            }
        } else {
            vscode.window.showErrorMessage('RepoGuide: Sidebar could not be activated.');
        }
    }
}
