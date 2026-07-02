import * as vscode from 'vscode';
import { RepositoryContext } from '../context/repositoryContext';
import { NavigationTarget } from '../comprehension/types';
import { LocationData } from '../query/responseParser';
import { ContextAccumulator } from '../query/contextAccumulator';
import { RepoGuideLogger } from '../logging/repoguideLogger';

export class DecorationManager {
    private decoration = vscode.window.createTextEditorDecorationType({ 
        backgroundColor: 'rgba(255,200,0,0.2)', 
        isWholeLine: true 
    });
    private secondaryDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255,200,0,0.12)',
        isWholeLine: true
    });
    private tertiaryDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255,200,0,0.08)',
        isWholeLine: true
    });
    private persistentNavigationDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(100,200,100,0.15)',
        border: '1px solid rgba(100,200,100,0.35)',
        isWholeLine: true
    });

    constructor(private accumulator?: ContextAccumulator, private context?: RepositoryContext) {}

    setContext(context: RepositoryContext) {
        this.context = context;
    }

    async highlightLocation(location: LocationData): Promise<void> {
        try {
            const doc = await vscode.workspace.openTextDocument(location.filePath);
            const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true });
            
            const startLine = Math.max(0, location.startLine);
            const endLine = Math.min(Math.max(startLine, location.endLine), doc.lineCount - 1);

            const startPos = new vscode.Position(startLine, 0);
            const endPos = new vscode.Position(endLine, doc.lineAt(endLine).text.length);
            const range = new vscode.Range(startPos, endPos);
            
            editor.setDecorations(this.decoration, [range]);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            this.accumulator?.recordAccess(location.filePath, startLine, endLine);
        } catch (e) {
            this.context?.logger.warn(`Failed to highlight location ${location.filePath}: ${e}`);
        }
    }

    async highlightMultiple(locations: LocationData[]): Promise<void> {
        const topThree = locations.slice(0, 3);
        const decorations = [this.decoration, this.secondaryDecoration, this.tertiaryDecoration];

        for (let i = 0; i < topThree.length; i++) {
            const location = topThree[i];
            try {
                const doc = await vscode.workspace.openTextDocument(location.filePath);
                const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true });

                const startLine = Math.max(0, location.startLine);
                const endLine = Math.min(Math.max(startLine, location.endLine), doc.lineCount - 1);

                const startPos = new vscode.Position(startLine, 0);
                const endPos = new vscode.Position(endLine, doc.lineAt(endLine).text.length);
                const range = new vscode.Range(startPos, endPos);

                editor.setDecorations(decorations[i], [range]);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                this.accumulator?.recordAccess(location.filePath, startLine, endLine);
            } catch (e) {
                this.context?.logger.warn(`Failed to highlight location ${location.filePath}: ${e}`);
            }
        }
    }

    async navigateTo(target: NavigationTarget): Promise<void> {
        try {
            const doc = await vscode.workspace.openTextDocument(target.filePath);
            const editor = await vscode.window.showTextDocument(doc, {
                preserveFocus: false,
                preview: false,
                viewColumn: vscode.ViewColumn.One
            });

            const startLine = Math.max(0, target.startLine);
            const endLine = Math.min(Math.max(startLine, target.endLine), doc.lineCount - 1);
            const startPos = new vscode.Position(startLine, 0);
            const endPos = new vscode.Position(endLine, doc.lineAt(endLine).text.length);
            const range = new vscode.Range(startPos, endPos);

            editor.setDecorations(this.persistentNavigationDecoration, [range]);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            this.accumulator?.recordAccess(target.filePath, startLine, endLine);
        } catch (e) {
            this.context?.logger.warn(`Failed to navigate to ${target.filePath}: ${e}`);
        }
    }

    async navigateToMultiple(targets: NavigationTarget[]): Promise<void> {
        const viewColumns = [
            vscode.ViewColumn.One,
            vscode.ViewColumn.Two,
            vscode.ViewColumn.Three
        ];
        const topTargets = targets.slice(0, 3);

        for (let i = 0; i < topTargets.length; i++) {
            const target = topTargets[i];
            try {
                const doc = await vscode.workspace.openTextDocument(target.filePath);
                const editor = await vscode.window.showTextDocument(doc, {
                    preserveFocus: i !== 0,
                    preview: false,
                    viewColumn: viewColumns[i]
                });

                const startLine = Math.max(0, target.startLine);
                const endLine = Math.min(Math.max(startLine, target.endLine), doc.lineCount - 1);
                const startPos = new vscode.Position(startLine, 0);
                const endPos = new vscode.Position(endLine, doc.lineAt(endLine).text.length);
                const range = new vscode.Range(startPos, endPos);

                editor.setDecorations(this.persistentNavigationDecoration, [range]);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                this.accumulator?.recordAccess(target.filePath, startLine, endLine);
            } catch (e) {
                this.context?.logger.warn(`Failed to navigate to ${target.filePath}: ${e}`);
            }
        }
    }

    clearDecorations(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this.decoration, []);
            editor.setDecorations(this.secondaryDecoration, []);
            editor.setDecorations(this.tertiaryDecoration, []);
            editor.setDecorations(this.persistentNavigationDecoration, []);
        }
    }

    dispose(): void {
        this.decoration.dispose();
        this.secondaryDecoration.dispose();
        this.tertiaryDecoration.dispose();
        this.persistentNavigationDecoration.dispose();
    }
}
