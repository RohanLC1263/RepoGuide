import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { isIgnoredPath, isWalkableFile } from '../indexing/fileWalker';
import { IndexManager } from '../indexing/indexManager';
import { ArtifactDependencyGraph, AffectedArtifacts } from './artifactDependencyGraph';
import { CrossLayerValidator } from './crossLayerValidator';
import { getFileUnderstandingCheckpointPath } from './fileUnderstandingCheckpoint';
import { StalenessRegistry } from './stalenessRegistry';
import { BackgroundRegenerationQueue } from './backgroundRegenerationQueue';
import { ImportGraphBuilder } from './importGraphBuilder';
import { buildLexicalMap } from './lexicalMapBuilder';
import { unwrapArtifact, wrapArtifact } from './schema-versions';
import { analyzeFileStructure } from './staticAnalyzer';
import {
    FileStructure,
    ImportEdge,
    ImportGraph,
    LexicalFileEntry,
    LexicalMap,
    LexicalSymbol
} from './types';
import { UnderstandingQualityMetrics } from './understandingQualityMetrics';
import { RepoguideTestUtils } from '../test/testUtils';

type OutputLogger = { appendLine(message: string): void };

interface SymbolDiff {
    added: LexicalSymbol[];
    removed: LexicalSymbol[];
    changed: Array<{ before: LexicalSymbol; after: LexicalSymbol }>;
}

interface ImportDiff {
    added: ImportEdge[];
    removed: ImportEdge[];
}

interface FileChangeSnapshot {
    structure: FileStructure;
    lexicalEntry: LexicalFileEntry;
    importEdges: ImportEdge[];
}

interface InvalidatedCounts {
    chunks: number;
    symbols: number;
    fileUnderstandings: number;
    importEdges: number;
    callEdges: number;
    behavioralPathSteps: number;
}

type RebuildTask = {
    label: string;
    run: (signal: AbortSignal) => Promise<void>;
};

class AsyncRebuildQueue {
    private readonly tasks: RebuildTask[] = [];
    private isDraining = false;

    constructor(private readonly outputChannel?: OutputLogger) {}

    enqueue(task: RebuildTask): void {
        this.tasks.push(task);
        void this.drain();
    }

    private async drain(): Promise<void> {
        if (this.isDraining) {
            return;
        }

        this.isDraining = true;
        try {
            while (this.tasks.length > 0) {
                const task = this.tasks.shift()!;
                const controller = new AbortController();
                try {
                    await task.run(controller.signal);
                } catch (error) {
                    if (!controller.signal.aborted) {
                        this.outputChannel?.appendLine(
                            `[Warn] FileChangeHandler: queued task "${task.label}" failed - ${String(error)}`
                        );
                    }
                }
            }
        } finally {
            this.isDraining = false;
        }
    }

    public async waitForDrain(): Promise<void> {
        while (this.isDraining || this.tasks.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
}

export class FileChangeHandler implements vscode.Disposable {
    private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
    private readonly activeRebuilds = new Map<string, AbortController>();
    private readonly activePromises = new Set<Promise<void>>();
    private readonly queue: AsyncRebuildQueue;
    private readonly saveSubscription: vscode.Disposable;
    private readonly deleteSubscription: vscode.Disposable;
    private readonly renameSubscription: vscode.Disposable;
    private readonly debounceMs: number;
    private indexManager?: IndexManager;

    constructor(
        private readonly workspaceRoot: string,
        private readonly understandingDir: string,
        private readonly depGraph: ArtifactDependencyGraph,
        private readonly stalenessRegistry: StalenessRegistry,
        private readonly regenQueue: BackgroundRegenerationQueue,
        private readonly outputChannel?: OutputLogger,
        options: { debounceMs?: number } = {}
    ) {
        this.debounceMs = options.debounceMs ?? 2000;
        this.queue = new AsyncRebuildQueue(outputChannel);

        this.saveSubscription = vscode.workspace.onDidSaveTextDocument(document => {
            this.onDidSaveTextDocument(document);
        });
        this.deleteSubscription = vscode.workspace.onDidDeleteFiles(e => {
            for (const uri of e.files) {
                this.handleFileChange(toRelativePath(this.workspaceRoot, uri.fsPath), null, 'deleted');
            }
        });
        this.renameSubscription = vscode.workspace.onDidRenameFiles(e => {
            for (const file of e.files) {
                this.handleFileChange(toRelativePath(this.workspaceRoot, file.oldUri.fsPath), null, 'deleted');
                this.handleFileChange(toRelativePath(this.workspaceRoot, file.newUri.fsPath), null, 'added');
            }
        });
    }

    public setIndexManager(indexManager: IndexManager): void {
        this.indexManager = indexManager;
    }

    dispose(): void {
        this.saveSubscription.dispose();
        this.deleteSubscription.dispose();
        this.renameSubscription.dispose();
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        for (const controller of this.activeRebuilds.values()) {
            controller.abort();
        }
        this.activeRebuilds.clear();
    }

    public async waitForRebuilds(): Promise<void> {
        while (this.activePromises.size > 0 || this.debounceTimers.size > 0) {
            await Promise.all(Array.from(this.activePromises));
            await this.queue.waitForDrain();
            await new Promise(resolve => setTimeout(resolve, 10)); // allow timers to fire
        }
        await this.queue.waitForDrain();
        // Allow microtasks to settle
        await new Promise(resolve => setTimeout(resolve, 10));
    }

    private onDidSaveTextDocument(document: vscode.TextDocument): void {
        if (document.uri.scheme !== 'file') {
            return;
        }

        const fsPath = document.uri.fsPath;
        if (!isWithinWorkspace(fsPath, this.workspaceRoot)) {
            return;
        }
        if (isIgnoredPath(fsPath, this.workspaceRoot) || !isWalkableFile(fsPath)) {
            return;
        }

        const relativePath = toRelativePath(this.workspaceRoot, fsPath);
        if (relativePath.startsWith('.repoguide/')) {
            return;
        }

        this.handleFileChange(relativePath, document.getText());
    }

    public async scheduleFileChange(relativePath: string, content?: string): Promise<void> {
        const absolutePath = path.join(this.workspaceRoot, relativePath);
        const nextContent = content ?? await readTextFile(absolutePath);
        if (nextContent === null) {
            return;
        }
        this.handleFileChange(relativePath, nextContent);
    }

    private handleFileChange(relativePath: string, content: string | null, reason: string = 'modified'): void {
        const existingTimer = this.debounceTimers.get(relativePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = RepoguideTestUtils.schedule(() => {
            this.debounceTimers.delete(relativePath);
            const promise = this.markArtifactsStale(relativePath, reason).catch(err => {
                this.outputChannel?.appendLine(`[Warn] FileChangeHandler: staleness propagation failed - ${String(err)}`);
            });
            this.activePromises.add(promise);
            promise.finally(() => this.activePromises.delete(promise));
        }, this.debounceMs);

        this.debounceTimers.set(relativePath, timer);
    }

    private async markArtifactsStale(relativePath: string, reason: string): Promise<void> {
        this.outputChannel?.appendLine(`[Info] File ${reason}: ${relativePath}`);

        // Fast marking using the dependency graph
        const affected = this.depGraph.getTransitiveDependents(relativePath);
        const artifactIds = affected.map(a => a.id);

        if (artifactIds.length > 0) {
            this.stalenessRegistry.markDirty(artifactIds, relativePath, `Source file ${reason}`);
            
            // Queue them for dependency-ordered regeneration
            for (const id of artifactIds) {
                this.regenQueue.enqueue(id, [relativePath]);
            }
            this.regenQueue.enqueue(relativePath, [relativePath]); // Queue the source file rebuild too
        } else {
            // Even if no dependents exist yet, mark the file for background indexing
            this.regenQueue.enqueue(relativePath, [relativePath]);
        }
    }

    private async parseSavedFile(relativePath: string, content: string): Promise<FileChangeSnapshot> {
        const absolutePath = path.join(this.workspaceRoot, relativePath);
        const structure = analyzeFileStructure(absolutePath, content, this.workspaceRoot);
        if (!structure) {
            throw new Error(`unsupported file type: ${relativePath}`);
        }

        const lexicalMap = buildLexicalMap(this.workspaceRoot, [structure]);
        const lexicalEntry = Object.values(lexicalMap.files)[0];
        const allStructures = await this.getImportResolutionStructures(relativePath, structure);
        const singleFileImportGraph = new ImportGraphBuilder(
            this.workspaceRoot,
            allStructures,
            this.outputChannel
        ).build([structure]);

        return {
            structure,
            lexicalEntry,
            importEdges: singleFileImportGraph.edges.filter(edge => samePath(edge.from, relativePath))
        };
    }

    private async getImportResolutionStructures(relativePath: string, current: FileStructure): Promise<FileStructure[]> {
        const structures = new Map<string, FileStructure>();
        structures.set(relativePath, current);

        const lexicalMap = await this.readArtifact<LexicalMap>('lexical_map.json');
        for (const [fileKey, entry] of Object.entries(lexicalMap?.files ?? {})) {
            const rel = toRelativePath(this.workspaceRoot, entry.filePath || fileKey);
            if (structures.has(rel)) {
                continue;
            }
            structures.set(rel, {
                filePath: path.join(this.workspaceRoot, rel),
                language: entry.language,
                imports: [],
                exports: [],
                classes: [],
                functions: [],
                docstrings: [],
                topLevelCalls: [],
                analyzedAt: entry.updatedAt ?? new Date().toISOString(),
                hash: entry.hash
            });
        }

        return Array.from(structures.values());
    }

    private async getAffectedArtifacts(relativePath: string): Promise<AffectedArtifacts> {
        const affected = await this.depGraph.getArtifactsAffectedByFile(relativePath);
        if (affected) {
            return affected;
        }

        const modulePath = path.dirname(relativePath).replace(/\\/g, '/');
        return {
            vectorChunkIds: [],
            symbolIds: [],
            fileUnderstandingId: relativePath,
            importGraphEdgeIds: [],
            callGraphEdgeIds: [],
            conceptMapEntryNames: [],
            behavioralPathIds: [],
            moduleUnderstandingPath: modulePath === '.' ? '' : modulePath,
            affectsProjectIntelligence: isCoreConfigOrEntryPoint(relativePath),
            vectorChunks: [],
            symbols: [],
            fileUnderstanding: relativePath,
            importEdges: [],
            callEdges: [],
            concepts: [],
            behavioralPaths: [],
            module: modulePath === '.' ? '' : modulePath,
            projectIntelligence: isCoreConfigOrEntryPoint(relativePath)
        };
    }

    private async invalidateAffectedArtifacts(
        relativePath: string,
        affected: AffectedArtifacts,
        symbolsChanged: boolean,
        importsChanged: boolean
    ): Promise<InvalidatedCounts> {
        const counts: InvalidatedCounts = {
            chunks: 0,
            symbols: 0,
            fileUnderstandings: 0,
            importEdges: 0,
            callEdges: 0,
            behavioralPathSteps: affected.behavioralPathIds.length
        };

        if (symbolsChanged) {
            counts.chunks = affected.vectorChunkIds.length;
            counts.symbols = affected.symbolIds.length;
            counts.fileUnderstandings = 1;
            await this.markFileUnderstandingChanged(relativePath);
            await this.markSymbolEntriesChanged(relativePath);
        }

        if (importsChanged) {
            counts.importEdges = affected.importGraphEdgeIds.length;
            counts.callEdges = affected.callGraphEdgeIds.length;
            await this.markImportEdgesChanged(affected.importGraphEdgeIds);
            await this.markCallGraphEdgesForGapFill(affected.callGraphEdgeIds);
        }

        if (counts.behavioralPathSteps > 0) {
            await this.markBehavioralPathsChanged(affected.behavioralPathIds);
        }

        return counts;
    }

    private queueRebuilds(
        relativePath: string,
        affected: AffectedArtifacts,
        symbolsChanged: boolean,
        importsChanged: boolean,
        signal: AbortSignal
    ): string[] {
        const queued: string[] = [];
        const shouldQueueUnderstanding = symbolsChanged || importsChanged;

        if (shouldQueueUnderstanding) {
            queued.push('file understanding');
            this.queue.enqueue({
                label: `file understanding ${relativePath}`,
                run: async taskSignal => {
                    throwIfAborted(signal);
                    throwIfAborted(taskSignal);
                    await this.markFileUnderstandingChanged(relativePath);
                }
            });
        }

        if (shouldQueueUnderstanding) {
            const modulePath = affected.moduleUnderstandingPath;
            queued.push(`module understanding (${modulePath || '.'})`);
            this.queue.enqueue({
                label: `module understanding ${modulePath || '.'}`,
                run: async taskSignal => {
                    throwIfAborted(signal);
                    throwIfAborted(taskSignal);
                    await this.markModuleUnderstandingChanged(modulePath);
                }
            });
        }

        if (affected.behavioralPathIds.length > 0) {
            const label = affected.behavioralPathIds.length === 1
                ? '1 behavioral path'
                : `${affected.behavioralPathIds.length} behavioral paths`;
            queued.push(label);
            this.queue.enqueue({
                label: `behavioral paths ${relativePath}`,
                run: async taskSignal => {
                    throwIfAborted(signal);
                    throwIfAborted(taskSignal);
                    await this.markBehavioralPathsChanged(affected.behavioralPathIds);
                }
            });
        }

        if (affected.affectsProjectIntelligence || isCoreConfigOrEntryPoint(relativePath)) {
            queued.push('project intelligence');
            this.queue.enqueue({
                label: 'project intelligence',
                run: async taskSignal => {
                    throwIfAborted(signal);
                    throwIfAborted(taskSignal);
                    await this.markProjectIntelligenceChanged();
                }
            });
        }

        return queued;
    }

    private logInvalidation(counts: InvalidatedCounts): void {
        this.outputChannel?.appendLine(
            `[Info] Invalidated: ${counts.chunks} chunks, ${counts.symbols} symbol entries, ` +
            `${counts.fileUnderstandings} file understanding, ${counts.callEdges} call edges, ` +
            `${counts.behavioralPathSteps} behavioral path steps`
        );
    }

    private async getOldSymbols(relativePath: string): Promise<LexicalSymbol[]> {
        const lexicalMap = await this.readArtifact<LexicalMap>('lexical_map.json');
        const entry = findLexicalEntry(lexicalMap, relativePath, this.workspaceRoot);
        return entry?.symbols ?? [];
    }

    private async getOldImports(relativePath: string): Promise<ImportEdge[]> {
        const importGraph = await this.readArtifact<ImportGraph>('import_graph.json');
        return (importGraph?.edges ?? []).filter(edge => samePath(edge.from, relativePath));
    }

    private async updateContentHash(relativePath: string, content: string): Promise<void> {
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        const checkpointPath = path.join(this.understandingDir, 'file_checkpoints.json');
        const checkpoint = (await readJsonFile<any>(checkpointPath)) ?? {};
        checkpoint.files ??= {};
        checkpoint.files[relativePath] ??= {};
        checkpoint.files[relativePath] = {
            ...checkpoint.files[relativePath],
            contentHash: hash,
            status: 'changed',
            lastAnalyzed: new Date().toISOString()
        };
        await writeJsonFile(checkpointPath, checkpoint);
    }

    private async updateLexicalMap(relativePath: string, lexicalEntry: LexicalFileEntry): Promise<void> {
        const lexicalMap = (await this.readArtifact<LexicalMap>('lexical_map.json')) ?? emptyLexicalMap(this.workspaceRoot);
        const existingKey = findLexicalKey(lexicalMap, relativePath, this.workspaceRoot) ?? relativePath;
        lexicalMap.files[existingKey] = {
            ...lexicalEntry,
            filePath: path.join(this.workspaceRoot, relativePath),
            updatedAt: new Date().toISOString()
        };
        rebuildLexicalStats(lexicalMap);
        await this.writeArtifact('lexical_map.json', lexicalMap);
    }

    private async updateImportGraph(relativePath: string, structure: FileStructure, importEdges: ImportEdge[]): Promise<void> {
        const importGraph = (await this.readArtifact<ImportGraph>('import_graph.json')) ?? emptyImportGraph();
        importGraph.edges = [
            ...importGraph.edges.filter(edge => !samePath(edge.from, relativePath)),
            ...importEdges
        ];
        importGraph.nodes[relativePath] = {
            language: structure.language,
            isEntryPoint: isCoreConfigOrEntryPoint(relativePath) || structure.topLevelCalls.length > 0,
            isExternal: false
        };
        for (const edge of importEdges) {
            if (!importGraph.nodes[edge.to]) {
                importGraph.nodes[edge.to] = {
                    language: edge.type === 'external' ? 'external' : 'unknown',
                    isEntryPoint: false,
                    isExternal: edge.type === 'external'
                };
            }
        }
        importGraph.externalPackages = unique(
            importGraph.edges
                .filter(edge => edge.type === 'external')
                .map(edge => edge.to)
        ).sort();
        importGraph.stats = {
            totalEdges: importGraph.edges.length,
            localEdges: importGraph.edges.filter(edge => edge.type === 'local').length,
            externalEdges: importGraph.edges.filter(edge => edge.type === 'external').length,
            unresolvedCount: importGraph.unresolvedImports?.length ?? 0
        };
        importGraph.builtAt = new Date().toISOString();
        await this.writeArtifact('import_graph.json', importGraph);
    }

    private async markFileUnderstandingChanged(relativePath: string): Promise<void> {
        const filesPath = path.join(this.understandingDir, 'files.json');
        const files = await this.readArtifact<any[]>('files.json');
        if (Array.isArray(files)) {
            let changed = false;
            for (const file of files) {
                if (samePath(file.filePath, relativePath) || samePath(file.relativePath, relativePath)) {
                    file.status = 'changed';
                    file.needsRebuild = true;
                    file.updatedAt = new Date().toISOString();
                    changed = true;
                }
            }
            if (changed) {
                await this.writeArtifact('files.json', files);
            }
        }

        const absolutePath = path.join(this.workspaceRoot, relativePath);
        const sidecarPath = getFileUnderstandingCheckpointPath(this.understandingDir, absolutePath);
        const sidecar = await readJsonFile<any>(sidecarPath);
        if (sidecar) {
            sidecar.status = 'changed';
            sidecar.needsRebuild = true;
            sidecar.updatedAt = new Date().toISOString();
            await writeJsonFile(sidecarPath, sidecar);
        } else if (!fs.existsSync(filesPath)) {
            await fs.promises.mkdir(path.dirname(sidecarPath), { recursive: true });
            await writeJsonFile(sidecarPath, {
                relativePath,
                status: 'changed',
                needsRebuild: true,
                updatedAt: new Date().toISOString()
            });
        }
    }

    private async markSymbolEntriesChanged(relativePath: string): Promise<void> {
        const symbolsPath = path.join(path.dirname(this.understandingDir), 'symbols.json');
        const symbols = await readJsonFile<Record<string, any[]>>(symbolsPath);
        if (!symbols) {
            return;
        }

        let changed = false;
        for (const entries of Object.values(symbols)) {
            if (!Array.isArray(entries)) {
                continue;
            }
            for (const entry of entries) {
                if (samePath(entry.filePath, relativePath)) {
                    entry.status = 'changed';
                    entry.needsRebuild = true;
                    changed = true;
                }
            }
        }
        if (changed) {
            await writeJsonFile(symbolsPath, symbols);
        }
    }

    private async markImportEdgesChanged(edgeIds: string[]): Promise<void> {
        if (edgeIds.length === 0) {
            return;
        }

        const importGraph = await this.readArtifact<ImportGraph>('import_graph.json');
        if (!importGraph) {
            return;
        }
        const staleIds = new Set(edgeIds);
        let changed = false;
        importGraph.edges = importGraph.edges.map((edge, index) => {
            const id = importEdgeId(edge, index);
            if (!staleIds.has(id)) {
                return edge;
            }
            changed = true;
            return { ...edge, status: 'changed', needsRebuild: true } as ImportEdge;
        });
        if (changed) {
            await this.writeArtifact('import_graph.json', importGraph);
        }
    }

    private async markCallGraphEdgesForGapFill(edgeIds: string[]): Promise<void> {
        if (edgeIds.length === 0) {
            return;
        }

        const callGraphPath = path.join(this.understandingDir, 'call_graph_v2.json');
        const raw = await readJsonFile<any>(callGraphPath);
        const graph = unwrapArtifact<any>(raw);
        if (!graph || !Array.isArray(graph.edges)) {
            return;
        }

        const staleIds = new Set(edgeIds);
        let changed = false;
        graph.edges = graph.edges.map((edge: any, index: number) => {
            const id = String(edge.id ?? `${edge.from ?? edge.caller?.relativePath}:${index}`);
            if (!staleIds.has(id)) {
                return edge;
            }
            changed = true;
            return { ...edge, status: 'changed', needsGapFill: true };
        });

        if (changed) {
            await writePossiblyWrappedArtifact(callGraphPath, 'call_graph_v2.json', raw, graph);
        }
    }

    private async markBehavioralPathsChanged(pathIds: string[]): Promise<void> {
        if (pathIds.length === 0) {
            return;
        }

        const behavioralPath = path.join(this.understandingDir, 'behavioral_paths.json');
        const raw = await readJsonFile<any>(behavioralPath);
        const graph = unwrapArtifact<any>(raw);
        if (!graph || !Array.isArray(graph.paths)) {
            return;
        }

        const staleIds = new Set(pathIds);
        let changed = false;
        for (const item of graph.paths) {
            const id = String(item.id ?? item.entryPointId ?? item.entryPointSymbol ?? '');
            if (staleIds.has(id)) {
                item.status = 'changed';
                item.needsRebuild = true;
                item.updatedAt = new Date().toISOString();
                changed = true;
            }
        }
        if (changed) {
            await writePossiblyWrappedArtifact(behavioralPath, 'behavioral_paths.json', raw, graph);
        }
    }

    private async markModuleUnderstandingChanged(modulePath: string): Promise<void> {
        const normalizedModule = modulePath || '.';
        for (const artifactName of ['module_understanding.json', 'modules.json']) {
            const artifactPath = path.join(this.understandingDir, artifactName);
            const raw = await readJsonFile<any>(artifactPath);
            const data = unwrapArtifact<any>(raw);
            if (!data) {
                continue;
            }

            let changed = false;
            if (Array.isArray(data)) {
                for (const item of data) {
                    if (samePath(item.moduleRelativePath, normalizedModule) || samePath(item.modulePath, normalizedModule)) {
                        item.status = 'changed';
                        item.needsRebuild = true;
                        item.updatedAt = new Date().toISOString();
                        changed = true;
                    }
                }
            } else if (data[normalizedModule]) {
                data[normalizedModule].status = 'changed';
                data[normalizedModule].needsRebuild = true;
                data[normalizedModule].updatedAt = new Date().toISOString();
                changed = true;
            }

            if (changed) {
                await writePossiblyWrappedArtifact(artifactPath, artifactName, raw, data);
            }
        }
    }

    private async markProjectIntelligenceChanged(): Promise<void> {
        const projectPath = path.join(this.understandingDir, 'project.json');
        const raw = await readJsonFile<any>(projectPath);
        const project = unwrapArtifact<any>(raw);
        if (!project) {
            return;
        }
        project.status = 'changed';
        project.needsRebuild = true;
        project.updatedAt = new Date().toISOString();
        await writePossiblyWrappedArtifact(projectPath, 'project.json', raw, project);
    }

    private async readArtifact<T>(artifactName: string): Promise<T | null> {
        return unwrapArtifact<T>(await readJsonFile(path.join(this.understandingDir, artifactName)));
    }

    private async writeArtifact<T>(artifactName: string, data: T): Promise<void> {
        const artifactPath = path.join(this.understandingDir, artifactName);
        const raw = await readJsonFile<any>(artifactPath);
        await writePossiblyWrappedArtifact(artifactPath, artifactName, raw, data);
    }
}

function diffSymbols(oldSymbols: LexicalSymbol[], newSymbols: LexicalSymbol[]): SymbolDiff {
    const oldByKey = new Map(oldSymbols.map(symbol => [symbolKey(symbol), symbol]));
    const newByKey = new Map(newSymbols.map(symbol => [symbolKey(symbol), symbol]));
    const added = newSymbols.filter(symbol => !oldByKey.has(symbolKey(symbol)));
    const removed = oldSymbols.filter(symbol => !newByKey.has(symbolKey(symbol)));
    const changed: Array<{ before: LexicalSymbol; after: LexicalSymbol }> = [];

    for (const symbol of newSymbols) {
        const before = oldByKey.get(symbolKey(symbol));
        if (before && symbolSignature(before) !== symbolSignature(symbol)) {
            changed.push({ before, after: symbol });
        }
    }

    return { added, removed, changed };
}

function diffImports(oldImports: ImportEdge[], newImports: ImportEdge[]): ImportDiff {
    const oldByKey = new Map(oldImports.map(edge => [importKey(edge), edge]));
    const newByKey = new Map(newImports.map(edge => [importKey(edge), edge]));
    return {
        added: newImports.filter(edge => !oldByKey.has(importKey(edge))),
        removed: oldImports.filter(edge => !newByKey.has(importKey(edge)))
    };
}

function hasSymbolChanges(diff: SymbolDiff): boolean {
    return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}

function hasImportChanges(diff: ImportDiff): boolean {
    return diff.added.length > 0 || diff.removed.length > 0;
}

function symbolKey(symbol: LexicalSymbol): string {
    return `${symbol.kind}:${symbol.containerName ?? ''}:${symbol.name}`;
}

function symbolSignature(symbol: LexicalSymbol): string {
    return [
        symbol.kind,
        symbol.containerName ?? '',
        symbol.name,
        symbol.startLine,
        symbol.endLine,
        symbol.isExported
    ].join('|');
}

function importKey(edge: ImportEdge): string {
    return [
        edge.from,
        edge.to,
        edge.type,
        edge.lineNumber,
        edge.isWildcard,
        edge.importedNames.slice().sort().join(',')
    ].join('|');
}

function importEdgeId(edge: ImportEdge, index: number): string {
    return String((edge as any).id ?? `${edge.from}->${edge.to}:${edge.lineNumber ?? index}`);
}

function emptyLexicalMap(projectRoot: string): LexicalMap {
    return {
        version: '1.0',
        builtAt: new Date().toISOString(),
        projectRoot,
        fileCount: 0,
        files: {},
        symbolsByName: {},
        stats: {
            files: 0,
            symbols: 0,
            functions: 0,
            classes: 0,
            methods: 0,
            exports: 0,
            comments: 0
        },
        confidence: 1.0
    };
}

function emptyImportGraph(): ImportGraph {
    return {
        schemaVersion: '1.0',
        builtAt: new Date().toISOString(),
        nodes: {},
        edges: [],
        externalPackages: [],
        unresolvedImports: [],
        stats: {
            totalEdges: 0,
            localEdges: 0,
            externalEdges: 0,
            unresolvedCount: 0
        }
    };
}

function rebuildLexicalStats(lexicalMap: LexicalMap): void {
    const symbolsByName: Record<string, string[]> = {};
    const stats = {
        files: Object.keys(lexicalMap.files).length,
        symbols: 0,
        functions: 0,
        classes: 0,
        methods: 0,
        exports: 0,
        comments: 0
    };

    for (const entry of Object.values(lexicalMap.files)) {
        stats.comments += entry.comments?.length ?? 0;
        for (const symbol of entry.symbols ?? []) {
            (symbolsByName[symbol.name] ??= []).push(symbol.id);
            stats.symbols += 1;
            if (symbol.kind === 'function') {
                stats.functions += 1;
            } else if (symbol.kind === 'class') {
                stats.classes += 1;
            } else if (symbol.kind === 'method' || symbol.kind === 'constructor') {
                stats.methods += 1;
            } else if (symbol.kind === 'export') {
                stats.exports += 1;
            }
        }
    }

    lexicalMap.symbolsByName = symbolsByName;
    lexicalMap.stats = stats;
    lexicalMap.fileCount = stats.files;
    lexicalMap.builtAt = new Date().toISOString();
}

function findLexicalEntry(
    lexicalMap: LexicalMap | null,
    relativePath: string,
    workspaceRoot: string
): LexicalFileEntry | null {
    if (!lexicalMap) {
        return null;
    }
    const key = findLexicalKey(lexicalMap, relativePath, workspaceRoot);
    return key ? lexicalMap.files[key] : null;
}

function findLexicalKey(lexicalMap: LexicalMap, relativePath: string, workspaceRoot: string): string | null {
    const normalized = normalizeRelative(relativePath);
    for (const key of Object.keys(lexicalMap.files ?? {})) {
        const entry = lexicalMap.files[key];
        const keyRel = toRelativePath(workspaceRoot, entry?.filePath || key);
        if (samePath(keyRel, normalized)) {
            return key;
        }
    }
    return null;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
    try {
        return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as T;
    } catch {
        return null;
    }
}

async function readTextFile(filePath: string): Promise<string | null> {
    try {
        return await fs.promises.readFile(filePath, 'utf8');
    } catch {
        return null;
    }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function writePossiblyWrappedArtifact<T>(
    filePath: string,
    artifactName: string,
    existingRaw: any,
    data: T
): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    if (existingRaw && typeof existingRaw === 'object' && 'data' in existingRaw) {
        existingRaw.data = data;
        existingRaw.updatedAt = new Date().toISOString();
        await fs.promises.writeFile(filePath, JSON.stringify(existingRaw, null, 2), 'utf8');
        return;
    }
    await fs.promises.writeFile(filePath, JSON.stringify(wrapArtifact(artifactName, data), null, 2), 'utf8');
}

function toRelativePath(workspaceRoot: string, filePath: string): string {
    const relative = path.isAbsolute(filePath) ? path.relative(workspaceRoot, filePath) : filePath;
    return normalizeRelative(relative);
}

function normalizeRelative(filePath: string): string {
    return path.normalize(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
}

function samePath(left: string | undefined, right: string | undefined): boolean {
    if (!left || !right) {
        return false;
    }
    const a = normalizeRelative(left).toLowerCase();
    const b = normalizeRelative(right).toLowerCase();
    return a === b;
}

function isWithinWorkspace(fsPath: string, workspaceRoot: string): boolean {
    const relative = path.relative(workspaceRoot, fsPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isCoreConfigOrEntryPoint(relativePath: string): boolean {
    const basename = path.basename(relativePath).toLowerCase();
    const configFiles = new Set([
        'package.json',
        'requirements.txt',
        'pyproject.toml',
        'poetry.lock',
        'dockerfile',
        'docker-compose.yml',
        'tsconfig.json',
        'vite.config.ts',
        'next.config.js',
        'main.py',
        'index.ts',
        'index.js'
    ]);
    return configFiles.has(basename);
}

function unique(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new Error('rebuild aborted');
    }
}
