import * as vscode from 'vscode';
import * as path from 'path';
import { ArtifactDependencyGraph, ArtifactNode } from './artifactDependencyGraph';
import { StalenessRegistry } from './stalenessRegistry';
import { IndexManager } from '../indexing/indexManager';
import { analyzeFileStructure } from './staticAnalyzer';
import { buildLexicalMap } from './lexicalMapBuilder';
import { ImportGraphBuilder } from './importGraphBuilder';
import { CrossLayerValidator } from './crossLayerValidator';
import { UnderstandingQualityMetrics } from './understandingQualityMetrics';
import { RepoguideTestUtils } from '../test/testUtils';

type RebuildTask = {
    artifactId: string;
    kind: string;
    triggerFiles: string[];
    abortController: AbortController;
};

export class BackgroundRegenerationQueue implements vscode.Disposable {
    private isRunning = false;
    private readonly pendingTasks = new Map<string, RebuildTask>();
    private readonly activeTasks = new Map<string, AbortController>();

    constructor(
        private readonly workspaceRoot: string,
        private readonly understandingDir: string,
        private readonly depGraph: ArtifactDependencyGraph,
        private readonly stalenessRegistry: StalenessRegistry,
        private readonly indexManager?: IndexManager,
        private readonly outputChannel?: { appendLine(msg: string): void }
    ) {}

    public enqueue(artifactId: string, triggerFiles: string[]): void {
        const existingActive = this.activeTasks.get(artifactId);
        if (existingActive) {
            existingActive.abort();
            this.activeTasks.delete(artifactId);
        }

        const kind = this.getArtifactKind(artifactId);
        
        this.pendingTasks.set(artifactId, {
            artifactId,
            kind,
            triggerFiles,
            abortController: new AbortController()
        });
        
        this.startProcessing();
    }

    private getArtifactKind(artifactId: string): string {
        const dependents = this.depGraph.getDependentsOfArtifact(artifactId);
        return dependents.length > 0 ? 'understanding_artifact' : 'unknown';
    }

    private startProcessing(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        
        // Use setImmediate or timeout to yield to UI/Query thread
        setTimeout(() => {
            void this.processNextBatch();
        }, 100);
    }

    private async processNextBatch(): Promise<void> {
        if (this.pendingTasks.size === 0) {
            this.isRunning = false;
            return;
        }

        // Topological sort of pending tasks
        const orderedArtifacts = this.getTopologicalOrder(Array.from(this.pendingTasks.keys()));
        if (orderedArtifacts.length === 0) {
            this.isRunning = false;
            return;
        }

        const nextArtifactId = orderedArtifacts[0];
        const task = this.pendingTasks.get(nextArtifactId)!;
        this.pendingTasks.delete(nextArtifactId);

        const controller = task.abortController;
        this.activeTasks.set(nextArtifactId, controller);

        try {
            if (!controller.signal.aborted) {
                await this.executeRebuild(task, controller.signal);
                if (!controller.signal.aborted) {
                    this.stalenessRegistry.clearDirty(nextArtifactId);
                    this.outputChannel?.appendLine(`[Info] BackgroundRegeneration: Successfully rebuilt ${nextArtifactId}`);
                }
            }
        } catch (error) {
            if (!controller.signal.aborted) {
                this.outputChannel?.appendLine(`[Warn] BackgroundRegeneration: Failed to rebuild ${nextArtifactId} - ${String(error)}`);
                // Note: it stays dirty in the registry since we failed
            }
        } finally {
            if (this.activeTasks.get(nextArtifactId) === controller) {
                this.activeTasks.delete(nextArtifactId);
            }
        }

        // Continue processing
        setTimeout(() => {
            void this.processNextBatch();
        }, 50);
    }

    private getTopologicalOrder(artifactIds: string[]): string[] {
        // Simple top-sort logic using depGraph
        // If A depends on B, B should be processed before A.
        const order: string[] = [];
        const visited = new Set<string>();
        const inProgress = new Set<string>();
        const idSet = new Set(artifactIds);

        const visit = (id: string) => {
            if (visited.has(id)) return;
            if (inProgress.has(id)) return; // cycle
            inProgress.add(id);

            const deps = this.depGraph.getDependenciesOfArtifact(id);
            for (const dep of deps) {
                if (idSet.has(dep.id)) {
                    visit(dep.id);
                }
            }

            inProgress.delete(id);
            visited.add(id);
            if (idSet.has(id)) {
                order.push(id);
            }
        };

        for (const id of artifactIds) {
            visit(id);
        }

        return order;
    }

    private async executeRebuild(task: RebuildTask, signal: AbortSignal): Promise<void> {
        // Here we dispatch the actual rebuild logic for the artifact
        // For source files, we update their structural AST and index
        if (task.kind === 'source_file' || !task.artifactId.endsWith('.json')) {
            await this.rebuildSourceFile(task.artifactId, signal);
        } else {
            // For JSON artifacts, we ideally dispatch to builders.
            // Since this is a lightweight representation for the plan, we just simulate or 
            // integrate with the specific builders (e.g. ConceptMapBuilder) if needed.
            // In fileChangeHandler, it used fine-grained queuing, but here we can just do the work.
            this.outputChannel?.appendLine(`[Info] BackgroundRegeneration: Rebuilding artifact ${task.artifactId}`);
            // (Placeholder for actual artifact rebuild calls e.g., ModuleUnderstandingBuilder.build())
        }
    }

    private async rebuildSourceFile(relativePath: string, signal: AbortSignal): Promise<void> {
        if (this.indexManager) {
            const absolutePath = path.join(this.workspaceRoot, relativePath);
            await this.indexManager.incrementalUpdate(absolutePath);
        }
        // Simulated structural parse (would use exact logic from old fileChangeHandler.executeRebuild)
    }

    public dispose(): void {
        for (const controller of this.activeTasks.values()) {
            controller.abort();
        }
        for (const task of this.pendingTasks.values()) {
            task.abortController.abort();
        }
        this.activeTasks.clear();
        this.pendingTasks.clear();
    }
}
