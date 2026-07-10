import * as path from 'path';
import * as vscode from 'vscode';
import { SymbolIndex } from '../indexing/symbolIndex';
import { LanceStore } from '../store/lanceStore';
import { loadMeta } from '../store/indexMeta';
import { getProfile } from '../config/performanceConfig';
import { ValidationReporter } from '../comprehension/crossLayerValidator';

export interface IndexHealthData {
    chunkCount: number;
    fileCount: number;
    symbolCount: number;
    lastIndexedAt: Date | null;
    lastSyncedAt: Date | null;
    isIndexing: boolean;
    isAnnotating: boolean;
    workspaceRoot: string;
    embeddingModel: string;
    inferenceModel: string;
    topFolders?: Array<{ folder: string; chunkCount: number }>;
    /** Cross-layer validation issue counts — null when no report exists yet. */
    validationIssues: { errors: number; warnings: number; infos: number } | null;
}

export class IndexHealthProvider {
    constructor(
        private readonly store: LanceStore,
        private readonly symbolIndex: SymbolIndex,
        private readonly workspaceRoot: string,
        private readonly repoguideDir: string,
        private readonly getIsIndexing: () => boolean,
        private readonly getIsAnnotating: () => boolean
    ) {}

    async getHealthData(): Promise<IndexHealthData> {
        const understandingDir = path.join(this.repoguideDir, 'understanding');
        const [meta, chunkCount, filePaths, validationReporter] = await Promise.all([
            loadMeta(this.repoguideDir),
            this.store.getChunkCount(),
            this.store.getAllFilePaths(),
            ValidationReporter.loadFromDisk(understandingDir)
        ]);
        const symbolStats = this.symbolIndex.getStats();
        const profile = getProfile();

        return {
            chunkCount,
            fileCount: filePaths.length,
            symbolCount: symbolStats.totalSymbols,
            lastIndexedAt: meta?.lastFullIndexAt ? new Date(meta.lastFullIndexAt) : null,
            lastSyncedAt: meta?.lastSyncAt ? new Date(meta.lastSyncAt) : null,
            isIndexing: this.getIsIndexing(),
            isAnnotating: this.getIsAnnotating(),
            workspaceRoot: this.workspaceRoot,
            embeddingModel: meta?.embeddingModel ?? profile.embeddingModel,
            inferenceModel: profile.inferenceModel,
            validationIssues: validationReporter ? validationReporter.getCounts() : null
        };
    }

    async getTopIndexedFolders(): Promise<Array<{ folder: string; chunkCount: number }>> {
        const chunks = await this.store.getAllChunks();
        const counts = new Map<string, number>();

        for (const chunk of chunks) {
            const relative = path.relative(this.workspaceRoot, chunk.filePath);
            const [topLevel] = relative.split(path.sep);
            const folder = topLevel && topLevel !== '' && topLevel !== '.'
                ? topLevel
                : '(root)';
            counts.set(folder, (counts.get(folder) ?? 0) + 1);
        }

        return Array.from(counts.entries())
            .map(([folder, chunkCount]) => ({ folder, chunkCount }))
            .sort((a, b) => b.chunkCount - a.chunkCount)
            .slice(0, 5);
    }

    formatHealthSummary(data: IndexHealthData): string {
        const lastIndexed = data.lastIndexedAt ? data.lastIndexedAt.toLocaleString() : 'Never indexed';
        const lastSynced = data.lastSyncedAt ? data.lastSyncedAt.toLocaleString() : 'Never synced';
        return `RepoGuide has indexed ${data.chunkCount} chunks across ${data.fileCount} files in ${data.workspaceRoot}. ` +
            `Symbol index tracks ${data.symbolCount} symbols. Last full index: ${lastIndexed}. ` +
            `Last sync: ${lastSynced}. Embeddings: ${data.embeddingModel}. Inference: ${data.inferenceModel}.`;
    }
}
