import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { walkFiles } from '../indexing/fileWalker';
// removed buildCallGraph
// removed CallGraphV1Builder
import { CallGraphBuilderV2 } from './callGraph/callGraphBuilderV2';
import { FlowExtractor } from './callGraph/flowExtractor';
// removed any
import { ConceptMapSearcher } from './conceptMapSearcher';
// removed generateFileUnderstanding
import {
    countValidFileUnderstandingCheckpoints,
    getFileUnderstandingCheckpointPath,
    getFileUnderstandingProgressStats,
    loadValidFileUnderstandingCheckpoint,
    writeFileUnderstandingCheckpoint
} from './fileUnderstandingCheckpoint';
import { ImportGraphBuilder } from './importGraphBuilder';
import { IncrementalUpdater } from './incrementalUpdater';
import { buildLexicalMap } from './lexicalMapBuilder';
// removed ModuleUnderstandingBuilder
// removed CallGraphGapFiller
// removed CallGraphValueFlowPass
import { CrossLayerValidator, ValidationReporter } from './crossLayerValidator';
// removed generateProjectComprehension
import { analyzeFileStructure } from './staticAnalyzer';
// removed BehavioralPathBuilder
import { EntryPointDetector } from './entryPointDetector';
import {
    DecoratorMapBuilder,
    InheritanceMapBuilder,
    TypeAnnotationMapBuilder
} from './typeDecoratorInheritanceBuilders';
import {
    hashManifestInput,
    loadUnderstandingManifest,
    markStageComplete,
    markStageFailed,
    markStageStarted,
    saveUnderstandingManifest,
    updateStage,
    UnderstandingManifest,
    UnderstandingStageName
} from './understandingManifest';
import {
    CallGraph,
    ConceptMap,
    FileStructure,
    FileUnderstanding,
    ModuleUnderstanding,
    ProjectUnderstanding
} from './types';
import { wrapArtifact, unwrapArtifact } from './schema-versions';

export class ComprehensionEngine {
    private workspaceRoot: string | null = null;
    private fileStructures = new Map<string, FileStructure>();
    private fileUnderstandings = new Map<string, FileUnderstanding>();
    private moduleUnderstandings = new Map<string, ModuleUnderstanding>();
    private callGraph: CallGraph | null = null;
    private projectUnderstanding: ProjectUnderstanding | null = null;
    private conceptMapBuilder?: any;
    private conceptMapSearcher = new ConceptMapSearcher(new Map(), createEmptyConceptMap());
    private callGraphBuilderV2: CallGraphBuilderV2;

    private repoguideDir: string;

    constructor(
        private outputChannel: vscode.OutputChannel | undefined,
        repoguideDir: string
    ) {
        this.repoguideDir = repoguideDir;
        this.callGraphBuilderV2 = new CallGraphBuilderV2(outputChannel, repoguideDir);
    }

    /**
     * Runs the comprehension stages this pass implements for real:
     * 'static_analysis' (produces FileStructure[] via analyzeFileStructure)
     * and 'call_graph_v1' (CallGraphBuilderV2.build()). The remaining
     * UNDERSTANDING_STAGES stay pending -- each represents its own
     * not-yet-rebuilt pass (module understanding, concept map, the
     * call_graph_v1 -> call_graph_v2 dynamic-dispatch gap-fill, etc.) and is
     * out of scope here. Each implemented stage is bracketed with
     * markStageStarted/Complete/Failed and skipped via inputHash when the
     * file set hasn't changed, so a repeat full index doesn't redo the work.
     */
    async runFullComprehension(workspaceRoot: string): Promise<void> {
        this.workspaceRoot = workspaceRoot;
        const understandingDir = this.getUnderstandingDir();
        if (!understandingDir) {
            return;
        }

        let manifest = await loadUnderstandingManifest(understandingDir, workspaceRoot);
        const { filePaths } = await walkFiles(workspaceRoot);

        const staticAnalysisInputHash = hashManifestInput(filePaths.slice().sort());
        const staticAnalysisStage = manifest.stages.static_analysis;
        if (staticAnalysisStage.status === 'complete' && staticAnalysisStage.inputHash === staticAnalysisInputHash) {
            // Skipping the rebuild still requires this engine instance to have
            // fileStructures in memory -- a fresh instance's map starts empty,
            // and the call_graph_v1 stage below depends on it being populated.
            this.fileStructures = new Map(
                ((await readJsonIfExists<FileStructure[]>(path.join(understandingDir, 'file-structures.json'))) ?? [])
                    .map(item => [item.filePath, item])
            );
            this.outputChannel?.appendLine(`[Info] Comprehension: static_analysis up to date, skipping (${this.fileStructures.size} file structures loaded from disk).`);
        } else {
            manifest = markStageStarted(manifest, 'static_analysis', staticAnalysisInputHash);
            await saveUnderstandingManifest(understandingDir, manifest);

            let filesAnalyzed = 0;
            let filesFailed = 0;
            const structures: FileStructure[] = [];
            for (const filePath of filePaths) {
                try {
                    const content = await fs.promises.readFile(filePath, 'utf-8');
                    const structure = analyzeFileStructure(filePath, content, workspaceRoot);
                    if (structure) {
                        structures.push(structure);
                        filesAnalyzed++;
                    }
                } catch (e) {
                    filesFailed++;
                    this.outputChannel?.appendLine(`[Warn] Comprehension: static_analysis failed for ${filePath}: ${e}`);
                }
            }
            this.fileStructures = new Map(structures.map(s => [s.filePath, s]));

            try {
                await this.saveAll();
                manifest = markStageComplete(manifest, 'static_analysis', ['file-structures.json'], { filesAnalyzed, filesFailed });
                this.outputChannel?.appendLine(`[Info] Comprehension: static_analysis complete (${filesAnalyzed} analyzed, ${filesFailed} failed).`);
            } catch (e) {
                manifest = markStageFailed(manifest, 'static_analysis', e);
                this.outputChannel?.appendLine(`[Warn] Comprehension: static_analysis stage failed to persist: ${e}`);
            }
            await saveUnderstandingManifest(understandingDir, manifest);
        }

        const callGraphInputHash = hashManifestInput(Array.from(this.fileStructures.keys()).sort());
        const callGraphStage = manifest.stages.call_graph_v1;
        if (callGraphStage.status === 'complete' && callGraphStage.inputHash === callGraphInputHash) {
            // Skipping the rebuild still needs getFlowExtractor() to work on
            // this engine instance -- neither build() nor loadExisting() may
            // have run yet on a freshly-constructed engine (loadExisting is
            // gated on project.json, which the project_synthesis stage --
            // out of scope here -- never produces), so hydrate from disk.
            await this.callGraphBuilderV2.load(workspaceRoot);
            this.outputChannel?.appendLine('[Info] Comprehension: call_graph_v1 up to date, skipping.');
            return;
        }

        manifest = markStageStarted(manifest, 'call_graph_v1', callGraphInputHash);
        await saveUnderstandingManifest(understandingDir, manifest);
        try {
            await this.callGraphBuilderV2.build(Array.from(this.fileStructures.values()), workspaceRoot);
            const stats = this.callGraphBuilderV2.getStats();
            manifest = markStageComplete(manifest, 'call_graph_v1', ['call_graph_v1.json'], { ...stats });
            this.outputChannel?.appendLine(`[Info] Comprehension: call_graph_v1 complete (${stats.totalFunctions} functions, ${stats.resolvedEdges} resolved edges).`);
        } catch (e) {
            manifest = markStageFailed(manifest, 'call_graph_v1', e);
            this.outputChannel?.appendLine(`[Warn] Comprehension: call_graph_v1 build failed: ${e}`);
        }
        await saveUnderstandingManifest(understandingDir, manifest);
    }

    async loadExisting(workspaceRoot: string): Promise<void> {
        this.workspaceRoot = workspaceRoot;
        const understandingDir = this.getUnderstandingDir();
        if (!understandingDir || !fs.existsSync(understandingDir)) {
            return;
        }

        this.fileStructures = new Map(
            ((await readJsonIfExists<FileStructure[]>(path.join(understandingDir, 'file-structures.json'))) ?? [])
                .map(item => [item.filePath, item])
        );
        this.fileUnderstandings = new Map(
            ((await readJsonIfExists<FileUnderstanding[]>(path.join(understandingDir, 'files.json'))) ?? [])
                .map(item => [item.filePath, item])
        );
        this.moduleUnderstandings = new Map(
            ((await readJsonIfExists<ModuleUnderstanding[]>(path.join(understandingDir, 'modules.json'))) ?? [])
                .map(item => [item.modulePath, item])
        );
        this.callGraph = await readJsonIfExists<CallGraph>(path.join(understandingDir, 'call-graph.json'));
        this.projectUnderstanding = await readJsonIfExists<ProjectUnderstanding>(path.join(understandingDir, 'project.json'));
        this.conceptMapBuilder = null;
        this.syncConceptMapSearcher();

        // Hydrate the v2 call graph builder so FlowExtractor is available at query time
        await this.callGraphBuilderV2.load(workspaceRoot);
    }

    async handleFileChange(filePath: string): Promise<void> { }

    getConceptMap(): { lookup(terms: string[]): string[] } {
        const map = this.projectUnderstanding?.concept_map ?? {};
        return {
            lookup(terms: string[]): string[] {
                const results: string[] = [];
                const normalizedTerms = terms.map(t => t.toLowerCase().trim());
                for (const [concept, filePaths] of Object.entries(map)) {
                    if (normalizedTerms.some(t => concept.includes(t) || t.includes(concept))) {
                        results.push(...filePaths);
                    }
                }
                return [...new Set(results)];
            }
        };
    }

    async getCallGraph(): Promise<CallGraph | null> {
        return this.callGraph;
    }

    getConceptMapSearcher(): ConceptMapSearcher {
        return this.conceptMapSearcher;
    }

    getFlowExtractor(): FlowExtractor | null {
        return this.callGraphBuilderV2.getFlowExtractor();
    }

    getAllModuleUnderstandings(): ModuleUnderstanding[] {
        return Array.from(this.moduleUnderstandings.values());
    }

    getFileUnderstanding(filePath: string): FileUnderstanding | null {
        const normalizedPath = path.normalize(filePath);
        return this.fileUnderstandings.get(normalizedPath) ?? this.fileUnderstandings.get(filePath) ?? null;
    }

    async updateConceptMapForFile(filePath: string, understandingDir: string): Promise<void> { }

    getProjectUnderstanding(): ProjectUnderstanding | null {
        return this.projectUnderstanding;
    }

    private getUnderstandingDir(): string | null {
        if (!this.repoguideDir) {
            return null;
        }
        return path.join(this.repoguideDir, 'understanding');
    }

    private async writeUnderstandingArtifact(name: string, data: unknown): Promise<void> {
        const understandingDir = this.getUnderstandingDir();
        if (!understandingDir) {
            return;
        }
        await fs.promises.mkdir(understandingDir, { recursive: true });
        const filePath = path.join(understandingDir, name);
        const tmpPath = filePath + '.tmp';
        const envelope = wrapArtifact(name, data);
        
        await fs.promises.writeFile(tmpPath, JSON.stringify(envelope, null, 2), 'utf8');
        await fs.promises.rename(tmpPath, filePath);
    }

    private async saveAll(): Promise<void> {
        const understandingDir = this.getUnderstandingDir();
        if (!understandingDir) {
            return;
        }

        await fs.promises.mkdir(understandingDir, { recursive: true });
        const moduleUnderstandingArray = Array.from(this.moduleUnderstandings.values());
        // Keyed dict keyed by moduleRelativePath — mirrors runFullComprehension output.
        const moduleUnderstandingDict = Object.fromEntries(
            moduleUnderstandingArray.map(m => [m.moduleRelativePath, m])
        );
        const writes: Array<{ name: string; data: unknown }> = [
            { name: 'file-structures.json', data: Array.from(this.fileStructures.values()) },
            { name: 'files.json', data: Array.from(this.fileUnderstandings.values()) },
            { name: 'modules.json', data: moduleUnderstandingArray },
            { name: 'module_understanding.json', data: moduleUnderstandingDict }
        ];

        if (this.callGraph) {
            writes.push({ name: 'call-graph.json', data: this.callGraph });
        }
        if (this.projectUnderstanding) {
            writes.push({ name: 'project.json', data: this.projectUnderstanding });
        }

        for (const { name, data } of writes) {
            try {
                const envelope = wrapArtifact(name, data);
                
                const filePath = path.join(understandingDir, name);
                const tmpPath = filePath + '.tmp';
                await fs.promises.writeFile(tmpPath, JSON.stringify(envelope, null, 2), 'utf8');
                await fs.promises.rename(tmpPath, filePath);
            } catch (e) {
                this.outputChannel?.appendLine(`[Error] Failed to save ${name}: ${e}`);
            }
        }
    }

    private syncConceptMapSearcher(): void {
        const understandingDir = this.getUnderstandingDir();
        if (understandingDir) {
            try {
                const mapPath = path.join(understandingDir, 'concept_map.json');
                if (fs.existsSync(mapPath)) {
                    const data = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
                    const map = data.data || data; // Handle envelope
                    const index = new Map<string, any[]>();
                    if (map && map.concepts) {
                        for (const concept of Object.values(map.concepts) as any[]) {
                            const canonical = concept.canonicalName.toLowerCase();
                            index.set(canonical, [concept]);
                            for (const syn of concept.synonyms) {
                                const lsyn = syn.toLowerCase();
                                const existing = index.get(lsyn) || [];
                                existing.push(concept);
                                index.set(lsyn, existing);
                            }
                        }
                    }
                    this.conceptMapSearcher.setData(index, map);
                    return;
                }
            } catch { /* ignore */ }
        }
        this.conceptMapSearcher.setData(new Map(), createEmptyConceptMap());
    }

}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        return unwrapArtifact<T>(parsed);
    } catch {
        return null;
    }
}

// groupByModule is no longer needed in engine — builder owns it

function countBy(values: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const value of values) {
        counts[value] = (counts[value] ?? 0) + 1;
    }
    return counts;
}

function findRunningStage(manifest: UnderstandingManifest): UnderstandingStageName | null {
    for (const [stage, state] of Object.entries(manifest.stages) as Array<[UnderstandingStageName, { status: string }]>) {
        if (state.status === 'running') {
            return stage;
        }
    }
    return null;
}

function createEmptyConceptMap(): ConceptMap {
    return {
        version: '',
        builtAt: '',
        projectRoot: '',
        concepts: [],
        synonymGroups: []
    };
}
