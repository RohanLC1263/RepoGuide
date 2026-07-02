import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { unwrapArtifact, wrapArtifact } from './schema-versions';

export interface FileDependencies {
    vectorChunkIds: string[];
    symbolIds: string[];
    fileUnderstandingId: string;
    importGraphEdgeIds: string[];
    callGraphEdgeIds: string[];
    conceptMapEntryNames: string[];
    behavioralPathIds: string[];
    moduleUnderstandingPath: string;
    affectsProjectIntelligence: boolean;
}

export interface ArtifactNode {
    id: string;
    kind: 'source_file' | 'config_file' | 'index_artifact' | 'understanding_artifact' | 'meta_artifact' | 'runtime_artifact';
    artifactPath?: string;
    relativePath?: string;
    stage?: string;
    producedBy?: string;
}

export interface ArtifactDependencyEdge {
    from: string;
    to: string;
    reason: string;
    required: boolean;
}

export interface ArtifactDependencySchema {
    schemaVersion: string;
    builtAt: string;
    workspaceRoot: string;
    nodes: ArtifactNode[];
    edges: ArtifactDependencyEdge[];
    fileArtifacts: Record<string, FileDependencies>;
}

export interface AffectedArtifacts extends FileDependencies {
    vectorChunks: string[];
    symbols: string[];
    fileUnderstanding: string | null;
    importEdges: string[];
    callEdges: string[];
    concepts: string[];
    behavioralPaths: string[];
    module: string | null;
    projectIntelligence: boolean;
}

export interface VectorChunkRef {
    id: string;
    filePath: string;
}

export class ArtifactDependencyGraph implements vscode.Disposable {
    private readonly graphFile: string;
    private state: ArtifactDependencySchema | null = null;
    private commandDisposable: vscode.Disposable | null = null;
    private artifactCache = new Map<string, { hash: string; data: any }>();

    constructor(
        private readonly workspaceRoot: string,
        private readonly understandingDir: string,
        private readonly outputChannel?: vscode.OutputChannel
    ) {
        this.graphFile = path.join(this.understandingDir, 'artifact_dependencies.json');
    }

    public registerCommand(context?: vscode.ExtensionContext): vscode.Disposable {
        if (this.commandDisposable) {
            return this.commandDisposable;
        }

        this.commandDisposable = vscode.commands.registerCommand('repoguide.whatDoesThisFileAffect', async () => {
            await this.showCurrentFileDependencies();
        });
        context?.subscriptions.push(this.commandDisposable);
        return this.commandDisposable;
    }

    public dispose(): void {
        this.commandDisposable?.dispose();
        this.commandDisposable = null;
    }

    public async build(vectorChunks: VectorChunkRef[] = []): Promise<ArtifactDependencySchema> {
        const lexicalMap = await this.readArtifact<any>('lexical_map.json');
        const lexicalFiles = lexicalMap?.files ?? {};
        const allFiles = collectAllFiles(lexicalFiles, this.workspaceRoot);

        if (allFiles.length === 0) {
            this.outputChannel?.appendLine('[Warn] ArtifactDependencyGraph: lexical_map.json has no files; dependency graph skipped.');
        }

        const importGraph = (await this.readArtifact<any>('import_graph.json')) ?? { edges: [] };
        const callGraphV1 = (await this.readArtifact<any>('call-graph.json')) ?? { edges: [] };
        const callGraphV2 = (await this.readArtifact<any>('call_graph_v2.json')) ?? { edges: [] };
        const conceptMap = (await this.readArtifact<any>('concept_map.json')) ?? { concepts: [] };
        const behavioralPaths = (await this.readArtifact<any>('behavioral_paths.json')) ?? { paths: [] };
        const moduleUnderstanding = (await this.readArtifact<Record<string, any>>('module_understanding.json')) ?? {};
        const entryPoints = (await this.readArtifact<any>('entry_points.json')) ?? { entryPoints: [] };
        const chunkIndexArtifact = await this.readArtifact<any>('chunk_index.json');
        const fallbackChunkIndex = chunkIndexArtifact?.chunks ?? [];

        const chunks = vectorChunks.length > 0 ? vectorChunks : fallbackChunkIndex;
        const nodes: ArtifactNode[] = [
            { id: 'file-structures.json', kind: 'understanding_artifact' },
            { id: 'call-graph.json', kind: 'understanding_artifact' },
            { id: 'lexical_map.json', kind: 'understanding_artifact' },
            { id: 'import_graph.json', kind: 'understanding_artifact' },
            { id: 'type_annotation_map.json', kind: 'understanding_artifact' },
            { id: 'decorator_map.json', kind: 'understanding_artifact' },
            { id: 'inheritance_map.json', kind: 'understanding_artifact' },
            { id: 'call_graph_v1.json', kind: 'understanding_artifact' },
            { id: 'files.json', kind: 'understanding_artifact' },
            { id: 'call_graph_v2.json', kind: 'understanding_artifact' },
            { id: 'modules.json', kind: 'understanding_artifact' },
            { id: 'module_understanding.json', kind: 'understanding_artifact' },
            { id: 'concept_map.json', kind: 'understanding_artifact' },
            { id: 'entry_points.json', kind: 'understanding_artifact' },
            { id: 'behavioral_paths.json', kind: 'understanding_artifact' },
            { id: 'project.json', kind: 'understanding_artifact' },
            { id: 'validation_report.json', kind: 'understanding_artifact' },
            { id: 'artifact_dependencies.json', kind: 'meta_artifact' }
        ];

        const edges: ArtifactDependencyEdge[] = [
            { from: 'file-structures.json', to: 'call-graph.json', reason: 'structural dependency', required: true },
            { from: 'file-structures.json', to: 'lexical_map.json', reason: 'structural dependency', required: true },
            { from: 'file-structures.json', to: 'import_graph.json', reason: 'structural dependency', required: true },
            { from: 'lexical_map.json', to: 'type_annotation_map.json', reason: 'lexical dependency', required: true },
            { from: 'lexical_map.json', to: 'decorator_map.json', reason: 'lexical dependency', required: true },
            { from: 'lexical_map.json', to: 'inheritance_map.json', reason: 'lexical dependency', required: true },
            { from: 'import_graph.json', to: 'inheritance_map.json', reason: 'import dependency', required: true },
            { from: 'lexical_map.json', to: 'call_graph_v1.json', reason: 'call graph extraction', required: true },
            { from: 'import_graph.json', to: 'call_graph_v1.json', reason: 'call graph extraction', required: true },
            { from: 'inheritance_map.json', to: 'call_graph_v1.json', reason: 'call graph extraction', required: true },
            { from: 'type_annotation_map.json', to: 'call_graph_v1.json', reason: 'call graph extraction', required: true },
            { from: 'file-structures.json', to: 'files.json', reason: 'comprehension', required: true },
            { from: 'call-graph.json', to: 'files.json', reason: 'comprehension', required: true },
            { from: 'lexical_map.json', to: 'files.json', reason: 'comprehension', required: true },
            { from: 'import_graph.json', to: 'files.json', reason: 'comprehension', required: true },
            { from: 'call_graph_v1.json', to: 'files.json', reason: 'comprehension', required: true },
            { from: 'decorator_map.json', to: 'files.json', reason: 'comprehension', required: true },
            { from: 'inheritance_map.json', to: 'files.json', reason: 'comprehension', required: true },
            { from: 'type_annotation_map.json', to: 'files.json', reason: 'comprehension', required: true },
            { from: 'call_graph_v1.json', to: 'call_graph_v2.json', reason: 'gap fill', required: true },
            { from: 'lexical_map.json', to: 'call_graph_v2.json', reason: 'gap fill', required: true },
            { from: 'import_graph.json', to: 'call_graph_v2.json', reason: 'gap fill', required: true },
            { from: 'files.json', to: 'call_graph_v2.json', reason: 'gap fill', required: true },
            { from: 'files.json', to: 'modules.json', reason: 'module generation', required: true },
            { from: 'import_graph.json', to: 'modules.json', reason: 'module generation', required: true },
            { from: 'inheritance_map.json', to: 'modules.json', reason: 'module generation', required: true },
            { from: 'call_graph_v1.json', to: 'modules.json', reason: 'module generation', required: true },
            { from: 'files.json', to: 'module_understanding.json', reason: 'module generation', required: true },
            { from: 'import_graph.json', to: 'module_understanding.json', reason: 'module generation', required: true },
            { from: 'inheritance_map.json', to: 'module_understanding.json', reason: 'module generation', required: true },
            { from: 'call_graph_v1.json', to: 'module_understanding.json', reason: 'module generation', required: true },
            { from: 'files.json', to: 'concept_map.json', reason: 'concept extraction', required: true },
            { from: 'lexical_map.json', to: 'entry_points.json', reason: 'entry point detection', required: true },
            { from: 'decorator_map.json', to: 'entry_points.json', reason: 'entry point detection', required: true },
            { from: 'inheritance_map.json', to: 'entry_points.json', reason: 'entry point detection', required: true },
            { from: 'files.json', to: 'entry_points.json', reason: 'entry point detection', required: true },
            { from: 'call_graph_v2.json', to: 'behavioral_paths.json', reason: 'path building', required: true },
            { from: 'entry_points.json', to: 'behavioral_paths.json', reason: 'path building', required: true },
            { from: 'files.json', to: 'behavioral_paths.json', reason: 'path building', required: true },
            { from: 'module_understanding.json', to: 'behavioral_paths.json', reason: 'path building', required: true },
            { from: 'modules.json', to: 'project.json', reason: 'project synthesis', required: true },
            { from: 'files.json', to: 'project.json', reason: 'project synthesis', required: true },
            { from: 'file-structures.json', to: 'project.json', reason: 'project synthesis', required: true },
            { from: 'behavioral_paths.json', to: 'project.json', reason: 'project synthesis', required: true }
        ];

        for (const relativePath of allFiles) {
            nodes.push({ id: relativePath, kind: 'source_file', relativePath });
            edges.push({ from: relativePath, to: 'file-structures.json', reason: 'source', required: true });
            edges.push({ from: relativePath, to: 'files.json', reason: 'source', required: true });
            edges.push({ from: relativePath, to: 'lexical_map.json', reason: 'source', required: true });
            edges.push({ from: relativePath, to: 'import_graph.json', reason: 'source', required: true });
        }

        const graph: ArtifactDependencySchema = {
            schemaVersion: '2.0',
            builtAt: new Date().toISOString(),
            workspaceRoot: this.workspaceRoot,
            nodes,
            edges,
            fileArtifacts: {}
        };

        for (const relativePath of allFiles) {
            graph.fileArtifacts[relativePath] = {
                vectorChunkIds: collectVectorChunkIds(relativePath, chunks, this.workspaceRoot),
                symbolIds: collectSymbolIds(relativePath, lexicalFiles, this.workspaceRoot),
                fileUnderstandingId: relativePath,
                importGraphEdgeIds: collectImportEdgeIds(relativePath, importGraph.edges ?? [], this.workspaceRoot),
                callGraphEdgeIds: [
                    ...collectCallGraphV1EdgeIds(relativePath, callGraphV1.edges ?? [], this.workspaceRoot),
                    ...collectCallGraphV2EdgeIds(relativePath, callGraphV2.edges ?? [], this.workspaceRoot)
                ],
                conceptMapEntryNames: collectConceptNames(relativePath, conceptMap, this.workspaceRoot),
                behavioralPathIds: collectBehavioralPathIds(relativePath, behavioralPaths.paths ?? [], this.workspaceRoot),
                moduleUnderstandingPath: findModuleForFile(relativePath, moduleUnderstanding, this.workspaceRoot),
                affectsProjectIntelligence: affectsProjectIntelligence(relativePath, entryPoints.entryPoints ?? [], this.workspaceRoot)
            };
        }

        for (const dependencies of Object.values(graph.fileArtifacts)) {
            dependencies.vectorChunkIds = unique(dependencies.vectorChunkIds);
            dependencies.symbolIds = unique(dependencies.symbolIds);
            dependencies.importGraphEdgeIds = unique(dependencies.importGraphEdgeIds);
            dependencies.callGraphEdgeIds = unique(dependencies.callGraphEdgeIds);
            dependencies.conceptMapEntryNames = unique(dependencies.conceptMapEntryNames);
            dependencies.behavioralPathIds = unique(dependencies.behavioralPathIds);
        }

        this.state = graph;
        await fs.promises.mkdir(this.understandingDir, { recursive: true });
        await fs.promises.writeFile(this.graphFile, JSON.stringify(wrapArtifact('artifact_dependencies.json', graph), null, 2), 'utf8');
        this.outputChannel?.appendLine(
            `[Info] ArtifactDependencyGraph: built dependency map for ${Object.keys(graph.fileArtifacts).length} files.`
        );
        return graph;
    }

    public async getArtifactsAffectedByFile(relativePath: string): Promise<AffectedArtifacts | null> {
        if (!this.state) {
            await this.loadState();
        }

        const normalizedPath = normalizeRelativePath(relativePath, this.workspaceRoot);
        const dependencies = this.state?.fileArtifacts[normalizedPath] ??
            Object.entries(this.state?.fileArtifacts ?? {})
                .find(([filePath]) => samePath(filePath, normalizedPath, this.workspaceRoot))?.[1];

        if (!dependencies) {
            return null;
        }

        return {
            vectorChunkIds: dependencies.vectorChunkIds,
            symbolIds: dependencies.symbolIds,
            fileUnderstandingId: dependencies.fileUnderstandingId,
            importGraphEdgeIds: dependencies.importGraphEdgeIds,
            callGraphEdgeIds: dependencies.callGraphEdgeIds,
            conceptMapEntryNames: dependencies.conceptMapEntryNames,
            behavioralPathIds: dependencies.behavioralPathIds,
            moduleUnderstandingPath: dependencies.moduleUnderstandingPath,
            affectsProjectIntelligence: dependencies.affectsProjectIntelligence,
            vectorChunks: dependencies.vectorChunkIds,
            symbols: dependencies.symbolIds,
            fileUnderstanding: dependencies.fileUnderstandingId || null,
            importEdges: dependencies.importGraphEdgeIds,
            callEdges: dependencies.callGraphEdgeIds,
            concepts: dependencies.conceptMapEntryNames,
            behavioralPaths: dependencies.behavioralPathIds,
            module: dependencies.moduleUnderstandingPath || null,
            projectIntelligence: dependencies.affectsProjectIntelligence
        };
    }

    public async getFilesAffectingArtifact(artifactType: string, artifactId: string): Promise<string[]> {
        if (!this.state) {
            await this.loadState();
        }
        if (!this.state) {
            return [];
        }

        const normalizedType = normalizeArtifactType(artifactType);
        const files: string[] = [];
        for (const [relativePath, dependencies] of Object.entries(this.state.fileArtifacts)) {
            if (artifactMatches(normalizedType, artifactId, dependencies, this.workspaceRoot)) {
                files.push(relativePath);
            }
        }
        return files;
    }

    public getDependenciesOfArtifact(artifactId: string): ArtifactNode[] {
        if (!this.state) return [];
        const edges = this.state.edges.filter(e => e.to === artifactId);
        const fromIds = new Set(edges.map(e => e.from));
        return this.state.nodes.filter(n => fromIds.has(n.id));
    }

    public getDependentsOfArtifact(artifactId: string): ArtifactNode[] {
        if (!this.state) return [];
        const edges = this.state.edges.filter(e => e.from === artifactId);
        const toIds = new Set(edges.map(e => e.to));
        return this.state.nodes.filter(n => toIds.has(n.id));
    }

    public getTransitiveDependencies(artifactId: string): ArtifactNode[] {
        if (!this.state) return [];
        const result = new Map<string, ArtifactNode>();
        const queue = [artifactId];
        const visited = new Set<string>();

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (visited.has(current)) continue;
            visited.add(current);

            const deps = this.getDependenciesOfArtifact(current);
            for (const dep of deps) {
                if (!result.has(dep.id)) {
                    result.set(dep.id, dep);
                    queue.push(dep.id);
                }
            }
        }
        return Array.from(result.values());
    }

    public getTransitiveDependents(artifactId: string): ArtifactNode[] {
        if (!this.state) return [];
        const result = new Map<string, ArtifactNode>();
        const queue = [artifactId];
        const visited = new Set<string>();

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (visited.has(current)) continue;
            visited.add(current);

            const deps = this.getDependentsOfArtifact(current);
            for (const dep of deps) {
                if (!result.has(dep.id)) {
                    result.set(dep.id, dep);
                    queue.push(dep.id);
                }
            }
        }
        return Array.from(result.values());
    }

    private async showCurrentFileDependencies(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
            void vscode.window.showWarningMessage('RepoGuide: Open a workspace file first.');
            return;
        }

        const relativePath = normalizeRelativePath(editor.document.uri.fsPath, this.workspaceRoot);
        const affected = await this.getArtifactsAffectedByFile(relativePath);
        if (!affected) {
            void vscode.window.showInformationMessage(`RepoGuide: No dependency data recorded for ${relativePath}.`);
            return;
        }

        this.outputChannel?.show(true);
        this.outputChannel?.appendLine('');
        this.outputChannel?.appendLine(`=== RepoGuide: Artifacts affected by ${relativePath} ===`);
        this.outputChannel?.appendLine(`Vector chunks: ${affected.vectorChunks.length}`);
        this.outputChannel?.appendLine(`Symbols: ${affected.symbols.length}${formatPreview(affected.symbols)}`);
        this.outputChannel?.appendLine(`File understanding: ${affected.fileUnderstanding ?? 'none'}`);
        this.outputChannel?.appendLine(`Import edges: ${affected.importEdges.length}${formatPreview(affected.importEdges)}`);
        this.outputChannel?.appendLine(`Call edges: ${affected.callEdges.length}${formatPreview(affected.callEdges)}`);
        this.outputChannel?.appendLine(`Concepts: ${affected.concepts.length}${formatPreview(affected.concepts)}`);
        this.outputChannel?.appendLine(`Behavioral paths: ${affected.behavioralPaths.length}${formatPreview(affected.behavioralPaths)}`);
        this.outputChannel?.appendLine(`Module: ${affected.module ?? 'none'}`);
        this.outputChannel?.appendLine(`Project intelligence: ${affected.projectIntelligence ? 'yes' : 'no'}`);
        this.outputChannel?.appendLine('================================================');
        this.outputChannel?.appendLine('');
    }

    private async readArtifact<T>(artifactName: string): Promise<T | null> {
        const artifactPath = path.join(this.understandingDir, artifactName);
        if (!fs.existsSync(artifactPath)) {
            return null;
        }
        try {
            const content = await fs.promises.readFile(artifactPath, 'utf8');
            const hash = crypto.createHash('sha256').update(content).digest('hex');
            
            const cached = this.artifactCache.get(artifactName);
            if (cached && cached.hash === hash) {
                return cached.data as T;
            }

            const data = unwrapArtifact<T>(JSON.parse(content));
            this.artifactCache.set(artifactName, { hash, data });
            return data;
        } catch {
            return null;
        }
    }

    private async loadState(): Promise<void> {
        if (!fs.existsSync(this.graphFile)) {
            return;
        }
        try {
            const content = await fs.promises.readFile(this.graphFile, 'utf8');
            this.state = unwrapArtifact<ArtifactDependencySchema>(JSON.parse(content));
        } catch {
            this.state = null;
        }
    }
}

function collectAllFiles(lexicalFiles: Record<string, any>, workspaceRoot: string): string[] {
    return unique(Object.keys(lexicalFiles).map(filePath => normalizeRelativePath(filePath, workspaceRoot))).sort();
}

function collectVectorChunkIds(relativePath: string, chunks: any[], workspaceRoot: string): string[] {
    return chunks
        .filter(chunk => samePath(chunk.filePath, relativePath, workspaceRoot))
        .map(chunk => String(chunk.id))
        .filter(Boolean);
}

function collectSymbolIds(relativePath: string, lexicalFiles: Record<string, any>, workspaceRoot: string): string[] {
    const entry = Object.entries(lexicalFiles)
        .find(([filePath]) => samePath(filePath, relativePath, workspaceRoot))?.[1];
    const symbols = Array.isArray(entry?.symbols) ? entry.symbols : [];
    return symbols.map((symbol: any) => String(symbol.id ?? symbol.name)).filter(Boolean);
}

function collectImportEdgeIds(relativePath: string, edges: any[], workspaceRoot: string): string[] {
    return edges
        .filter(edge => samePath(edge.from ?? edge.source, relativePath, workspaceRoot))
        .map((edge, index) => String(edge.id ?? `${edge.from ?? edge.source}->${edge.to ?? edge.target}:${edge.lineNumber ?? index}`));
}

function collectCallGraphV1EdgeIds(relativePath: string, edges: any[], workspaceRoot: string): string[] {
    return edges
        .filter(edge =>
            samePath(edge.caller?.relativePath ?? edge.callerFile ?? edge.sourceFilePath, relativePath, workspaceRoot) ||
            samePath(edge.callee?.relativePath ?? edge.calleeFile ?? edge.targetFilePath, relativePath, workspaceRoot)
        )
        .map((edge, index) => String(edge.id ??
            `${edge.caller?.relativePath ?? edge.callerFile}:${edge.caller?.symbol ?? edge.caller}->` +
            `${edge.callee?.relativePath ?? edge.calleeFile}:${edge.callee?.symbol ?? edge.callee}:${index}`
        ));
}

function collectCallGraphV2EdgeIds(relativePath: string, edges: any[], workspaceRoot: string): string[] {
    return collectCallGraphV1EdgeIds(relativePath, edges, workspaceRoot);
}

function collectConceptNames(relativePath: string, conceptMap: any, workspaceRoot: string): string[] {
    const concepts = Array.isArray(conceptMap.concepts)
        ? conceptMap.concepts
        : Object.entries(conceptMap.concepts ?? {}).map(([concept, value]) => ({ concept, ...(value as object) }));

    return concepts
        .filter((concept: any) => {
            const locations = Array.isArray(concept.locations) ? concept.locations : [];
            return locations.some((location: any) =>
                samePath(location.filePath ?? location.relativePath, relativePath, workspaceRoot)
            );
        })
        .map((concept: any) => String(concept.concept ?? concept.name))
        .filter(Boolean);
}

function collectBehavioralPathIds(relativePath: string, paths: any[], workspaceRoot: string): string[] {
    return paths
        .filter(pathItem =>
            samePath(pathItem.entryPointFile ?? pathItem.entryPointLocation, relativePath, workspaceRoot) ||
            (Array.isArray(pathItem.happyPath) && pathItem.happyPath.some((step: any) =>
                samePath(step.relativePath ?? step.filePath, relativePath, workspaceRoot)
            ))
        )
        .map(pathItem => String(pathItem.id ?? pathItem.entryPointId ?? pathItem.entryPointSymbol))
        .filter(Boolean);
}

function findModuleForFile(relativePath: string, moduleUnderstanding: Record<string, any>, workspaceRoot: string): string {
    for (const [modulePath, moduleData] of Object.entries(moduleUnderstanding)) {
        const filePaths = Array.isArray(moduleData.filePaths) ? moduleData.filePaths : [];
        if (filePaths.some((filePath: string) => samePath(filePath, relativePath, workspaceRoot))) {
            return normalizeRelativePath(moduleData.moduleRelativePath ?? modulePath, workspaceRoot);
        }
    }
    const dirname = path.dirname(relativePath).replace(/\\/g, '/');
    return dirname === '.' ? '' : dirname;
}

function affectsProjectIntelligence(relativePath: string, entryPoints: any[], workspaceRoot: string): boolean {
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
        'next.config.js'
    ]);
    if (configFiles.has(basename)) {
        return true;
    }
    return entryPoints.some(entryPoint => samePath(entryPoint.relativePath ?? entryPoint.filePath, relativePath, workspaceRoot));
}

function artifactMatches(
    artifactType: string,
    artifactId: string,
    dependencies: FileDependencies,
    workspaceRoot: string
): boolean {
    switch (artifactType) {
        case 'vector_chunk':
        case 'chunk':
            return dependencies.vectorChunkIds.includes(artifactId);
        case 'symbol':
            return dependencies.symbolIds.includes(artifactId);
        case 'file_understanding':
            return dependencies.fileUnderstandingId === artifactId || samePath(dependencies.fileUnderstandingId, artifactId, workspaceRoot);
        case 'import_edge':
            return dependencies.importGraphEdgeIds.includes(artifactId);
        case 'call_edge':
            return dependencies.callGraphEdgeIds.includes(artifactId);
        case 'concept_map':
        case 'concept':
            return dependencies.conceptMapEntryNames.includes(artifactId);
        case 'behavioral_path':
            return dependencies.behavioralPathIds.includes(artifactId);
        case 'module_understanding':
        case 'module':
            return dependencies.moduleUnderstandingPath === artifactId || samePath(dependencies.moduleUnderstandingPath, artifactId, workspaceRoot);
        case 'project_intelligence':
            return dependencies.affectsProjectIntelligence;
        default:
            return false;
    }
}

function normalizeArtifactType(artifactType: string): string {
    const normalized = artifactType.toLowerCase().replace(/-/g, '_');
    return normalized === 'behavioral_paths' ? 'behavioral_path' : normalized;
}

function normalizeRelativePath(filePath: string | undefined, workspaceRoot: string): string {
    if (!filePath) {
        return '';
    }
    const relative = path.isAbsolute(filePath) ? path.relative(workspaceRoot, filePath) : filePath;
    return path.normalize(relative).replace(/\\/g, '/').replace(/^\.\//, '');
}

function samePath(left: string | undefined, right: string | undefined, workspaceRoot: string): boolean {
    if (!left || !right) {
        return false;
    }
    const a = normalizeRelativePath(left, workspaceRoot).toLowerCase();
    const b = normalizeRelativePath(right, workspaceRoot).toLowerCase();
    return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function unique(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
}

function formatPreview(values: string[]): string {
    if (values.length === 0) {
        return '';
    }
    const preview = values.slice(0, 5).join(', ');
    return ` (${preview}${values.length > 5 ? ', ...' : ''})`;
}
