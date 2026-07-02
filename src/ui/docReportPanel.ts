import { RepositoryContext } from '../context/repositoryContext';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { LanceStore } from '../store/lanceStore';
import { buildDocPrompt } from '../prompts/docPrompt';
import { streamChat } from '../ollama/inferencer';
import { CodeChunk } from '../store/storeTypes';
import { getProfile } from '../config/performanceConfig';

/**
 * Generates a documentation report by:
 * 1. Fetching top chunks per folder from LanceDB
 * 2. Building a structured prompt
 * 3. Streaming the LLM response into a styled WebviewPanel
 */
export async function generateDocReport(repoContext: RepositoryContext, store: LanceStore, extensionUri: vscode.Uri): Promise<void> {
    await vscode.window.withProgress({ 
        location: vscode.ProgressLocation.Notification, 
        title: 'RepoGuide: Generating documentation report...',
        cancellable: true 
    }, async (progress, token) => {
        
        const allPaths = await store.getAllFilePaths();
        const chunksByFolder = new Map<string, CodeChunk[]>();
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return;
        }
        const rootPath = workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');

        for (const filePath of allPaths) {
            if (token.isCancellationRequested) {
                return;
            }
            const normalizedPath = filePath.replace(/\\/g, '/');
            const relativePath = normalizedPath.replace(rootPath + '/', '');
            const folderSegment = relativePath.split('/')[0];

            let chunks: CodeChunk[] = [];
            try {
                chunks = await store.getChunksByFile(filePath);
            } catch (e) {
                // Skip files we can't read chunks for
            }

            if (chunks.length > 0) {
                const existing = chunksByFolder.get(folderSegment) || [];
                existing.push(...chunks.slice(0, 3));
                chunksByFolder.set(folderSegment, existing);
            }
        }
        
        // Cap each folder to top 5 chunks
        const cappedByFolder = new Map<string, CodeChunk[]>();
        for (const [folder, chunks] of chunksByFolder.entries()) {
            cappedByFolder.set(folder, chunks.slice(0, 5));
        }

        const messages = buildDocPrompt(cappedByFolder);

        const panel = vscode.window.createWebviewPanel(
            'repoguide.docreport',
            'RepoGuide: Documentation Report',
            vscode.ViewColumn.One,
            { enableScripts: true, localResourceRoots: [extensionUri] }
        );

        const htmlPath = vscode.Uri.joinPath(extensionUri, 'webviews', 'docreport', 'report.html');
        const htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf-8');
        panel.webview.html = htmlContent;

        const inferenceModel = getProfile().inferenceModel;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 120000);

            for await (const chunkToken of streamChat(repoContext, messages, inferenceModel, controller.signal)) {
                if (token.isCancellationRequested) {
                    controller.abort();
                    break;
                }
                await panel.webview.postMessage({ type: 'token', value: chunkToken });
            }
            clearTimeout(timeoutId);
            await panel.webview.postMessage({ type: 'done' });
        } catch (e: any) {
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
