import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileStructure, FunctionCallGraph } from '../types';
import { CallGraphTraverser } from './callGraphTraverser';
import { resolveEdges } from './edgeResolver';
import { FlowExtractor } from './flowExtractor';
import { extractFunctionNodes } from './functionNodeExtractor';
import { assembleGraph } from './graphAssembler';
import { wrapArtifact, unwrapArtifact } from '../schema-versions';

const GRAPH_FILE_NAME = 'call_graph_v1.json';

export class CallGraphBuilderV2 {
    private graph: FunctionCallGraph | null = null;
    private traverser: CallGraphTraverser | null = null;
    private extractor: FlowExtractor | null = null;
    private fileStructures = new Map<string, FileStructure>();

    constructor(
        private outputChannel?: vscode.OutputChannel,
        private repoguideDir?: string
    ) {}

    async build(
        fileStructures: FileStructure[],
        workspaceRoot: string
    ): Promise<FunctionCallGraph> {
        this.fileStructures = new Map(
            fileStructures.map(fileStructure => [path.normalize(fileStructure.filePath), fileStructure])
        );
        this.outputChannel?.appendLine('[Info] Call graph v2: extracting function nodes...');
        const allStructures = Array.from(this.fileStructures.values());
        const nodes = extractFunctionNodes(allStructures);

        this.outputChannel?.appendLine('[Info] Call graph v2: resolving edges...');
        const { edges, unresolvedCalls } = resolveEdges(nodes, allStructures);

        this.outputChannel?.appendLine('[Info] Call graph v2: assembling graph...');
        const graph = assembleGraph(nodes, edges, unresolvedCalls, workspaceRoot);

        await saveGraph(graph, this.getRepoguideDir(workspaceRoot));

        this.graph = graph;
        this.traverser = new CallGraphTraverser(graph);
        this.extractor = new FlowExtractor(graph, this.traverser, this.outputChannel);

        const stats = this.getStats();
        this.outputChannel?.appendLine(
            `[Info] Call graph v2 complete: ${stats.totalFunctions} functions, ` +
            `${stats.resolvedEdges} resolved edges, ${stats.unresolvedEdges} unresolved`
        );

        return graph;
    }

    async load(workspaceRoot: string): Promise<FunctionCallGraph | null> {
        const repoguideDir = this.getRepoguideDir(workspaceRoot);
        const graphFilePath = getGraphFilePath(repoguideDir);
        if (!fs.existsSync(graphFilePath)) {
            return null;
        }

        try {
            const content = await fs.promises.readFile(graphFilePath, 'utf8');
            const graph = unwrapArtifact<FunctionCallGraph>(JSON.parse(content));
            const fileStructures = await readFileStructures(repoguideDir);
            this.fileStructures = new Map(
                fileStructures.map(fileStructure => [path.normalize(fileStructure.filePath), fileStructure])
            );
            this.graph = graph;
            this.traverser = new CallGraphTraverser(graph);
            this.extractor = new FlowExtractor(graph, this.traverser, this.outputChannel);
            return graph;
        } catch {
            return null;
        }
    }

    async updateForFile(
        filePath: string,
        newFileStructure: FileStructure | null,
        workspaceRoot: string
    ): Promise<void> {
        if (!this.graph) {
            return;
        }

        const normalizedFilePath = path.normalize(filePath);
        if (newFileStructure) {
            this.fileStructures.set(normalizedFilePath, newFileStructure);
        } else {
            this.fileStructures.delete(normalizedFilePath);
        }

        const allStructures = Array.from(this.fileStructures.values());
        const nodes = extractFunctionNodes(allStructures);
        const { edges, unresolvedCalls } = resolveEdges(nodes, allStructures);
        const graph = assembleGraph(nodes, edges, unresolvedCalls, workspaceRoot);

        await saveGraph(graph, this.getRepoguideDir(workspaceRoot));

        this.graph = graph;
        this.traverser = new CallGraphTraverser(graph);
        this.extractor = new FlowExtractor(graph, this.traverser, this.outputChannel);
    }

    getTraverser(): CallGraphTraverser | null {
        return this.traverser;
    }

    getFlowExtractor(): FlowExtractor | null {
        return this.extractor;
    }

    getStats(): {
        totalFunctions: number;
        totalEdges: number;
        resolvedEdges: number;
        unresolvedEdges: number;
        entryPoints: number;
    } {
        if (!this.graph) {
            return {
                totalFunctions: 0,
                totalEdges: 0,
                resolvedEdges: 0,
                unresolvedEdges: 0,
                entryPoints: 0
            };
        }

        return {
            totalFunctions: Object.keys(this.graph.nodes).length,
            totalEdges: this.graph.edges.length,
            resolvedEdges: this.graph.edges.filter(edge => edge.isResolved).length,
            unresolvedEdges: this.graph.unresolvedCalls.length,
            entryPoints: this.graph.entryPoints.length
        };
    }

    private getRepoguideDir(workspaceRoot: string): string {
        return this.repoguideDir ?? path.join(workspaceRoot, '.repoguide');
    }
}

async function saveGraph(graph: FunctionCallGraph, repoguideDir: string): Promise<void> {
    await fs.promises.mkdir(repoguideDir, { recursive: true });
    const envelope = wrapArtifact(GRAPH_FILE_NAME, graph);
    await fs.promises.writeFile(
        getGraphFilePath(repoguideDir),
        JSON.stringify(envelope, null, 2),
        'utf8'
    );
}

function getGraphFilePath(repoguideDir: string): string {
    return path.join(repoguideDir, GRAPH_FILE_NAME);
}

async function readFileStructures(repoguideDir: string): Promise<FileStructure[]> {
    const fileStructuresPath = path.join(
        repoguideDir,
        'understanding',
        'file-structures.json'
    );
    if (!fs.existsSync(fileStructuresPath)) {
        return [];
    }

    try {
        const content = await fs.promises.readFile(fileStructuresPath, 'utf8');
        const parsed = unwrapArtifact<unknown>(JSON.parse(content));
        return Array.isArray(parsed) ? parsed as FileStructure[] : [];
    } catch {
        return [];
    }
}
