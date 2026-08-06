import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { isIgnoredPath, isWalkableFile } from '../indexing/fileWalker';
import { SymbolIndex } from '../indexing/symbolIndex';
import { LanceStore } from '../store/lanceStore';
import { ArtifactDependencyGraph } from './artifactDependencyGraph';
import { FileChangeHandler } from './fileChangeHandler';
import { unwrapArtifact, wrapArtifact } from './schema-versions';
import { RepoguideTestUtils } from '../test/testUtils';
import { isWithinWorkspace } from '../security/pathSafety';

type OutputLogger = { appendLine(message: string): void };

interface CleanupCounts {
    chunks: number;
    symbols: number;
    callEdges: number;
    behavioralSteps: number;
    conceptLocations: number;
    unlocatedConcepts: number;
}

interface PreservedRenameCheckpoint {
    checkpointEntry?: any;
    sidecarUnderstanding?: any;
    filesIndexEntry?: any;
}

export class FileLifecycleHandler implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly workspaceRoot: string,
        private readonly repoguideDir: string,
        private readonly understandingDir: string,
        private readonly depGraph: ArtifactDependencyGraph,
        private readonly store: LanceStore,
        private readonly symbolIndex: SymbolIndex,
        private readonly fileChangeHandler: FileChangeHandler,
        private readonly outputChannel?: OutputLogger
    ) {
        this.disposables.push(
            vscode.workspace.onDidDeleteFiles(event => {
                void this.handleDelete(event.files);
            }),
            vscode.workspace.onWillRenameFiles(event => {
                event.waitUntil(this.handleRename(event.files));
            }),
            vscode.workspace.onDidCreateFiles(event => {
                void this.handleCreate(event.files);
            })
        );
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
    }

    private async handleDelete(uris: readonly vscode.Uri[]): Promise<void> {
        for (const uri of uris) {
            const relativePath = this.toWorkspaceRelativePath(uri);
            if (!relativePath) {
                continue;
            }
            await this.processDelete(relativePath);
        }
    }

    private async handleRename(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
        for (const file of files) {
            const oldRelativePath = this.toWorkspaceRelativePath(file.oldUri);
            const newRelativePath = this.toWorkspaceRelativePath(file.newUri);
            if (!oldRelativePath || !newRelativePath) {
                continue;
            }

            this.outputChannel?.appendLine(`[Info] File renamed: ${oldRelativePath} -> ${newRelativePath}`);

            const preserved = this.preserveRenameCheckpoint(oldRelativePath, newRelativePath, file.oldUri.fsPath);
            await this.processDelete(oldRelativePath);

            RepoguideTestUtils.schedule(() => {
                this.restoreRenameCheckpoint(newRelativePath, preserved);
                void this.handleCreate([file.newUri]);
            }, 3000);
        }
    }

    private async handleCreate(uris: readonly vscode.Uri[]): Promise<void> {
        for (const uri of uris) {
            const relativePath = this.toWorkspaceRelativePath(uri, { requireWalkable: true });
            if (!relativePath) {
                continue;
            }

            this.addPendingFile(relativePath);
            this.outputChannel?.appendLine(`[Info] File created: ${relativePath}`);

            RepoguideTestUtils.schedule(() => {
                const absolutePath = path.join(this.workspaceRoot, relativePath);
                if (fs.existsSync(absolutePath)) {
                    void this.fileChangeHandler.scheduleFileChange(relativePath);
                }
            }, 3000);
        }
    }

    private async processDelete(relativePath: string): Promise<CleanupCounts> {
        const deps = await this.depGraph.getArtifactsAffectedByFile(relativePath);
        const counts: CleanupCounts = {
            chunks: 0,
            symbols: 0,
            callEdges: 0,
            behavioralSteps: 0,
            conceptLocations: 0,
            unlocatedConcepts: 0
        };
        const staleBehavioralPaths = new Set<string>();

        this.outputChannel?.appendLine(`[Info] File deleted: ${relativePath}`);

        if (deps?.vectorChunkIds.length) {
            counts.chunks = await this.deleteVectorChunks(deps.vectorChunkIds);
        }

        counts.symbols = await this.removeSymbols(relativePath);
        this.removeFileUnderstanding(relativePath);
        this.removeLexicalMapEntry(relativePath);
        this.removeImportEdges(relativePath);
        counts.callEdges = this.removeCallGraphEdges(relativePath);
        const conceptCleanup = this.removeConceptLocations(relativePath);
        counts.conceptLocations = conceptCleanup.removedLocations;
        counts.unlocatedConcepts = conceptCleanup.unlocatedConcepts;

        const behavioralCleanup = this.markBehavioralPathsStale(relativePath, deps?.behavioralPathIds ?? []);
        counts.behavioralSteps = behavioralCleanup.behavioralSteps;
        for (const pathId of behavioralCleanup.pathIds) {
            staleBehavioralPaths.add(pathId);
        }

        this.markModuleUnderstandingChanged(deps?.moduleUnderstandingPath ?? modulePathForFile(relativePath));
        this.removeArtifactDependencyEntry(relativePath);
        await this.depGraph.build();

        this.outputChannel?.appendLine(
            `[Info] Cleaned: ${counts.chunks} chunks, ${counts.symbols} symbols, ` +
            `${counts.callEdges} call edges, ${counts.behavioralSteps} behavioral steps, ` +
            `${counts.conceptLocations} concept locations (${counts.unlocatedConcepts} concept now unlocated)`
        );

        for (const pathId of staleBehavioralPaths) {
            this.outputChannel?.appendLine(
                `[Warn] Behavioral path "${pathId}" is stale (file deleted from path)`
            );
        }

        return counts;
    }

    private async deleteVectorChunks(chunkIds: string[]): Promise<number> {
        let deleted = 0;
        for (const chunkId of chunkIds) {
            try {
                await this.store.deleteChunkById(chunkId);
                deleted += 1;
            } catch (error) {
                this.outputChannel?.appendLine(
                    `[Warn] FileLifecycleHandler: failed to delete vector chunk ${chunkId} - ${String(error)}`
                );
            }
        }
        return deleted;
    }

    private async removeSymbols(relativePath: string): Promise<number> {
        const before = this.symbolIndex.getStats().totalSymbols;
        this.symbolIndex.removeSymbolsByFile(relativePath);
        this.symbolIndex.removeSymbolsByFile(path.join(this.workspaceRoot, relativePath));
        const removed = Math.max(0, before - this.symbolIndex.getStats().totalSymbols);

        const symbolsPath = path.join(this.repoguideDir, 'symbols.json');
        const persisted = readJsonFile<Record<string, any[]>>(symbolsPath);
        if (persisted) {
            let persistedRemoved = 0;
            for (const [name, entries] of Object.entries(persisted)) {
                if (!Array.isArray(entries)) {
                    continue;
                }
                const filtered = entries.filter(entry => !samePath(entry.filePath, relativePath, this.workspaceRoot));
                persistedRemoved += entries.length - filtered.length;
                if (filtered.length === 0) {
                    delete persisted[name];
                } else {
                    persisted[name] = filtered;
                }
            }
            writeJsonFile(symbolsPath, persisted);
            return Math.max(removed, persistedRemoved);
        }

        try {
            await this.symbolIndex.save(this.repoguideDir);
        } catch {
            // Persist best-effort; the in-memory index is still cleaned.
        }

        return removed;
    }

    private removeFileUnderstanding(relativePath: string): void {
        const fileId = fileIdForPath(relativePath);
        const sidecarPath = path.join(this.understandingDir, 'files', `${fileId}.json`);
        try {
            if (fs.existsSync(sidecarPath)) {
                fs.unlinkSync(sidecarPath);
            }
        } catch {
            // Best effort cleanup.
        }

        const files = this.readArtifact<any[]>('files.json');
        if (Array.isArray(files)) {
            const filtered = files.filter(file => !samePath(file.filePath ?? file.relativePath, relativePath, this.workspaceRoot));
            if (filtered.length !== files.length) {
                this.writeArtifact('files.json', filtered);
            }
        }

        const checkpointPath = path.join(this.understandingDir, 'file_checkpoints.json');
        const checkpoint = readJsonFile<any>(checkpointPath);
        if (checkpoint?.files?.[relativePath]) {
            delete checkpoint.files[relativePath];
            writeJsonFile(checkpointPath, checkpoint);
        }
    }

    private removeLexicalMapEntry(relativePath: string): void {
        const lexicalMap = this.readArtifact<any>('lexical_map.json');
        if (!lexicalMap?.files) {
            return;
        }

        let removed = false;
        for (const [key, entry] of Object.entries<any>(lexicalMap.files)) {
            if (samePath(entry?.filePath ?? key, relativePath, this.workspaceRoot)) {
                delete lexicalMap.files[key];
                removed = true;
            }
        }

        if (removed) {
            rebuildLexicalMapIndexes(lexicalMap);
            this.writeArtifact('lexical_map.json', lexicalMap);
        }
    }

    private removeImportEdges(relativePath: string): void {
        const importGraph = this.readArtifact<any>('import_graph.json');
        if (!importGraph || !Array.isArray(importGraph.edges)) {
            return;
        }

        const kept: any[] = [];
        let removed = false;
        for (const edge of importGraph.edges) {
            const from = edge.from ?? edge.source;
            const to = edge.to ?? edge.target;
            if (samePath(from, relativePath, this.workspaceRoot) || samePath(to, relativePath, this.workspaceRoot)) {
                removed = true;
                if (samePath(to, relativePath, this.workspaceRoot)) {
                    this.outputChannel?.appendLine(`[Warn] Import removed: ${from} -> ${to} (${to} deleted)`);
                }
                continue;
            }
            kept.push(edge);
        }

        if (removed) {
            importGraph.edges = kept;
            if (importGraph.nodes) {
                delete importGraph.nodes[relativePath];
            }
            importGraph.stats = {
                totalEdges: kept.length,
                localEdges: kept.filter(edge => edge.type === 'local').length,
                externalEdges: kept.filter(edge => edge.type === 'external').length,
                unresolvedCount: importGraph.unresolvedImports?.length ?? 0
            };
            importGraph.builtAt = new Date().toISOString();
            this.writeArtifact('import_graph.json', importGraph);
        }
    }

    private removeCallGraphEdges(relativePath: string): number {
        let totalRemoved = 0;
        for (const artifactName of ['call_graph_v2.json', 'call-graph.json']) {
            const graph = this.readArtifact<any>(artifactName);
            if (!graph || !Array.isArray(graph.edges)) {
                continue;
            }

            const before = graph.edges.length;
            graph.edges = graph.edges.filter((edge: any) => !callEdgeTouchesFile(edge, relativePath, this.workspaceRoot));
            const removed = before - graph.edges.length;
            if (removed > 0) {
                totalRemoved += removed;
                if (graph.stats) {
                    graph.stats.resolved = Math.max(0, (graph.stats.resolved ?? graph.edges.length) - removed);
                    graph.stats.totalCallSites = graph.edges.length + (graph.unresolved?.length ?? 0);
                }
                graph.builtAt = new Date().toISOString();
                this.writeArtifact(artifactName, graph);
            }
        }
        return totalRemoved;
    }

    private removeConceptLocations(relativePath: string): { removedLocations: number; unlocatedConcepts: number } {
        const conceptMap = this.readArtifact<any>('concept_map.json');
        if (!conceptMap?.concepts) {
            return { removedLocations: 0, unlocatedConcepts: 0 };
        }

        let removedLocations = 0;
        let unlocatedConcepts = 0;
        let changed = false;
        const concepts = Array.isArray(conceptMap.concepts)
            ? conceptMap.concepts
            : Object.values(conceptMap.concepts);

        for (const concept of concepts as any[]) {
            if (!Array.isArray(concept.locations)) {
                continue;
            }
            const before = concept.locations.length;
            concept.locations = concept.locations.filter((location: any) =>
                !samePath(location.filePath ?? location.relativePath, relativePath, this.workspaceRoot)
            );
            const removed = before - concept.locations.length;
            if (removed > 0) {
                removedLocations += removed;
                changed = true;
                if (concept.locations.length === 0) {
                    concept.unlocated = true;
                    concept.status = 'unlocated';
                    concept.updatedAt = new Date().toISOString();
                    unlocatedConcepts += 1;
                }
            }
        }

        if (changed) {
            this.writeArtifact('concept_map.json', conceptMap);
        }

        return { removedLocations, unlocatedConcepts };
    }

    private markBehavioralPathsStale(
        relativePath: string,
        dependencyPathIds: string[]
    ): { behavioralSteps: number; pathIds: string[] } {
        const behavioralPaths = this.readArtifact<any>('behavioral_paths.json');
        if (!behavioralPaths || !Array.isArray(behavioralPaths.paths)) {
            return { behavioralSteps: 0, pathIds: [] };
        }

        const dependencyIds = new Set(dependencyPathIds);
        const stalePathIds = new Set<string>();
        let behavioralSteps = 0;
        let changed = false;

        for (const item of behavioralPaths.paths) {
            const id = String(item.id ?? item.entryPointId ?? item.entryPointSymbol ?? 'unknown_path');
            const traversingSteps = Array.isArray(item.happyPath)
                ? item.happyPath.filter((step: any) =>
                    samePath(step.relativePath ?? step.filePath, relativePath, this.workspaceRoot)
                ).length
                : 0;
            const touchesFile =
                dependencyIds.has(id) ||
                samePath(item.entryPointFile ?? item.entryPointLocation, relativePath, this.workspaceRoot) ||
                traversingSteps > 0;

            if (!touchesFile) {
                continue;
            }

            item.status = 'stale';
            item.needsRebuild = true;
            item.updatedAt = new Date().toISOString();
            stalePathIds.add(id);
            behavioralSteps += Math.max(1, traversingSteps);
            changed = true;
        }

        if (changed) {
            this.writeArtifact('behavioral_paths.json', behavioralPaths);
        }

        return { behavioralSteps, pathIds: Array.from(stalePathIds) };
    }

    private markModuleUnderstandingChanged(modulePath: string): void {
        const normalized = modulePath || '.';
        for (const artifactName of ['module_understanding.json', 'modules.json']) {
            const data = this.readArtifact<any>(artifactName);
            if (!data) {
                continue;
            }

            let changed = false;
            if (Array.isArray(data)) {
                for (const item of data) {
                    if (samePath(item.moduleRelativePath ?? item.modulePath, normalized, this.workspaceRoot)) {
                        item.status = 'changed';
                        item.needsRebuild = true;
                        item.updatedAt = new Date().toISOString();
                        changed = true;
                    }
                }
            } else if (data[normalized]) {
                data[normalized].status = 'changed';
                data[normalized].needsRebuild = true;
                data[normalized].updatedAt = new Date().toISOString();
                changed = true;
            }

            if (changed) {
                this.writeArtifact(artifactName, data);
            }
        }
    }

    private removeArtifactDependencyEntry(relativePath: string): void {
        const dependencies = this.readArtifact<any>('artifact_dependencies.json');
        if (!dependencies?.fileArtifacts) {
            return;
        }

        for (const key of Object.keys(dependencies.fileArtifacts)) {
            if (samePath(key, relativePath, this.workspaceRoot)) {
                delete dependencies.fileArtifacts[key];
            }
        }
        dependencies.builtAt = new Date().toISOString();
        this.writeArtifact('artifact_dependencies.json', dependencies);
    }

    private preserveRenameCheckpoint(
        oldRelativePath: string,
        newRelativePath: string,
        oldAbsolutePath: string
    ): PreservedRenameCheckpoint {
        const preserved: PreservedRenameCheckpoint = {};
        const checkpointPath = path.join(this.understandingDir, 'file_checkpoints.json');
        const checkpoint = readJsonFile<any>(checkpointPath);
        const oldCheckpoint = checkpoint?.files?.[oldRelativePath];
        const oldContentHash = hashFile(oldAbsolutePath);
        const checkpointHash = oldCheckpoint?.contentHash;

        if (oldCheckpoint && oldContentHash && checkpointHash === oldContentHash) {
            preserved.checkpointEntry = {
                ...oldCheckpoint,
                relativePath: newRelativePath,
                status: oldCheckpoint.status ?? 'current',
                renamedFrom: oldRelativePath,
                updatedAt: new Date().toISOString()
            };
        }

        const oldSidecarPath = path.join(this.understandingDir, 'files', `${fileIdForPath(oldRelativePath)}.json`);
        const sidecar = readJsonFile<any>(oldSidecarPath);
        if (sidecar && preserved.checkpointEntry) {
            preserved.sidecarUnderstanding = rewriteFilePathFields(sidecar, oldRelativePath, newRelativePath, this.workspaceRoot);
        }

        const files = this.readArtifact<any[]>('files.json');
        if (Array.isArray(files) && preserved.checkpointEntry) {
            const match = files.find(file => samePath(file.filePath ?? file.relativePath, oldRelativePath, this.workspaceRoot));
            if (match) {
                preserved.filesIndexEntry = rewriteFilePathFields(match, oldRelativePath, newRelativePath, this.workspaceRoot);
            }
        }

        if (preserved.checkpointEntry) {
            this.outputChannel?.appendLine(
                '[Info] Preserved file understanding checkpoint to prevent LLM re-run'
            );
        }

        return preserved;
    }

    private restoreRenameCheckpoint(
        newRelativePath: string,
        preserved: PreservedRenameCheckpoint
    ): void {
        if (!preserved.checkpointEntry) {
            return;
        }

        const checkpointPath = path.join(this.understandingDir, 'file_checkpoints.json');
        const checkpoint = readJsonFile<any>(checkpointPath) ?? {};
        checkpoint.files ??= {};
        checkpoint.files[newRelativePath] = preserved.checkpointEntry;
        writeJsonFile(checkpointPath, checkpoint);

        if (preserved.sidecarUnderstanding) {
            const sidecarPath = path.join(this.understandingDir, 'files', `${fileIdForPath(newRelativePath)}.json`);
            writeJsonFile(sidecarPath, preserved.sidecarUnderstanding);
        }

        if (preserved.filesIndexEntry) {
            const files = this.readArtifact<any[]>('files.json') ?? [];
            const filtered = files.filter(file => !samePath(file.filePath ?? file.relativePath, newRelativePath, this.workspaceRoot));
            filtered.push(preserved.filesIndexEntry);
            this.writeArtifact('files.json', filtered);
        }
    }

    private addPendingFile(relativePath: string): void {
        const files = this.readArtifact<any[]>('files.json') ?? [];
        if (!files.some(file => samePath(file.filePath ?? file.relativePath, relativePath, this.workspaceRoot))) {
            files.push({
                filePath: path.join(this.workspaceRoot, relativePath),
                relativePath,
                status: 'pending',
                createdAt: new Date().toISOString()
            });
            this.writeArtifact('files.json', files);
        }

        const checkpointPath = path.join(this.understandingDir, 'file_checkpoints.json');
        const checkpoint = readJsonFile<any>(checkpointPath) ?? {};
        checkpoint.files ??= {};
        checkpoint.files[relativePath] ??= {
            status: 'pending',
            createdAt: new Date().toISOString()
        };
        writeJsonFile(checkpointPath, checkpoint);
    }

    private toWorkspaceRelativePath(
        uri: vscode.Uri,
        options: { requireWalkable?: boolean } = {}
    ): string | null {
        if (uri.scheme !== 'file') {
            return null;
        }
        if (!isWithinWorkspace(uri.fsPath, this.workspaceRoot)) {
            return null;
        }
        if (isIgnoredPath(uri.fsPath, this.workspaceRoot)) {
            return null;
        }
        if (options.requireWalkable && !isWalkableFile(uri.fsPath)) {
            return null;
        }

        const relativePath = toRelativePath(this.workspaceRoot, uri.fsPath);
        if (relativePath.startsWith('.repoguide/')) {
            return null;
        }
        return relativePath;
    }

    private readArtifact<T>(artifactName: string): T | null {
        return unwrapArtifact<T>(readJsonFile(path.join(this.understandingDir, artifactName)));
    }

    private writeArtifact<T>(artifactName: string, data: T): void {
        const artifactPath = path.join(this.understandingDir, artifactName);
        const existingRaw = readJsonFile<any>(artifactPath);
        writePossiblyWrappedArtifact(artifactPath, artifactName, existingRaw, data);
    }
}

function readJsonFile<T>(filePath: string): T | null {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
        return null;
    }
}

function writeJsonFile(filePath: string, data: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function writePossiblyWrappedArtifact<T>(
    filePath: string,
    artifactName: string,
    existingRaw: any,
    data: T
): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (existingRaw && typeof existingRaw === 'object' && 'data' in existingRaw) {
        existingRaw.data = data;
        existingRaw.updatedAt = new Date().toISOString();
        fs.writeFileSync(filePath, JSON.stringify(existingRaw, null, 2), 'utf8');
        return;
    }
    fs.writeFileSync(filePath, JSON.stringify(wrapArtifact(artifactName, data), null, 2), 'utf8');
}

function rebuildLexicalMapIndexes(lexicalMap: any): void {
    const symbolsByName: Record<string, string[]> = {};
    const stats = {
        files: Object.keys(lexicalMap.files ?? {}).length,
        symbols: 0,
        functions: 0,
        classes: 0,
        methods: 0,
        exports: 0,
        comments: 0
    };

    for (const entry of Object.values<any>(lexicalMap.files ?? {})) {
        stats.comments += Array.isArray(entry.comments) ? entry.comments.length : 0;
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

function callEdgeTouchesFile(edge: any, relativePath: string, workspaceRoot: string): boolean {
    return samePath(edge.caller?.relativePath, relativePath, workspaceRoot) ||
        samePath(edge.callee?.relativePath, relativePath, workspaceRoot) ||
        samePath(edge.callerFile, relativePath, workspaceRoot) ||
        samePath(edge.calleeFile, relativePath, workspaceRoot) ||
        samePath(edge.sourceFilePath, relativePath, workspaceRoot) ||
        samePath(edge.targetFilePath, relativePath, workspaceRoot) ||
        samePath(edge.from?.split?.('::')?.[0], relativePath, workspaceRoot) ||
        samePath(edge.to?.split?.('::')?.[0], relativePath, workspaceRoot);
}

function rewriteFilePathFields<T>(value: T, oldRelativePath: string, newRelativePath: string, workspaceRoot: string): T {
    const copy = JSON.parse(JSON.stringify(value));
    const newAbsolutePath = path.join(workspaceRoot, newRelativePath);
    if (copy.filePath && samePath(copy.filePath, oldRelativePath, workspaceRoot)) {
        copy.filePath = path.isAbsolute(copy.filePath) ? newAbsolutePath : newRelativePath;
    }
    if (copy.relativePath && samePath(copy.relativePath, oldRelativePath, workspaceRoot)) {
        copy.relativePath = newRelativePath;
    }
    copy.renamedFrom = oldRelativePath;
    copy.updatedAt = new Date().toISOString();
    return copy;
}

function hashFile(filePath: string): string | null {
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch {
        return null;
    }
}

function fileIdForPath(relativePath: string): string {
    return relativePath.replace(/[\\/]/g, '_');
}

function modulePathForFile(relativePath: string): string {
    const dirname = path.dirname(relativePath).replace(/\\/g, '/');
    return dirname === '.' ? '' : dirname;
}

function toRelativePath(workspaceRoot: string, filePath: string): string {
    const relative = path.isAbsolute(filePath) ? path.relative(workspaceRoot, filePath) : filePath;
    return path.normalize(relative).replace(/\\/g, '/').replace(/^\.\//, '');
}

function samePath(left: string | undefined, right: string | undefined, workspaceRoot: string): boolean {
    if (!left || !right) {
        return false;
    }
    const leftRelative = toRelativePath(workspaceRoot, String(left)).toLowerCase();
    const rightRelative = toRelativePath(workspaceRoot, String(right)).toLowerCase();
    return leftRelative === rightRelative;
}
