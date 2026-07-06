import { CodeChunk } from './storeTypes';
import { SegmentedMiniSearchIndex } from './segmentedMiniSearchIndex';

export interface Bm25Result {
    id: string;
    filePath: string;
    score: number;
    text: string;
}

export class Bm25Store {
    private index: SegmentedMiniSearchIndex<{ id: string; filePath: string; text: string }>;

    constructor(dbDir: string) {
        this.index = new SegmentedMiniSearchIndex(dbDir, 'bm25_index', {
            fields: ['filePath', 'text'], // fields to index for full-text search
            storeFields: ['filePath', 'text'], // fields to return with search results
            idField: 'id',
            tokenize: (string) => string.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 0)
        });
    }

    async init(): Promise<void> {
        await this.index.init();
    }

    async insertChunks(chunks: CodeChunk[]): Promise<void> {
        if (chunks.length === 0) return;
        await this.index.addAllAsync(chunks.map(c => ({
            id: c.id,
            filePath: c.filePath,
            text: c.text
        })));
    }

    async deleteChunkById(id: string): Promise<void> {
        await this.index.discard(id);
    }

    async deleteChunksByIds(ids: string[]): Promise<void> {
        await this.index.discardMany(ids);
    }

    async clearAll(): Promise<void> {
        await this.index.clearAll();
    }

    /** See SegmentedMiniSearchIndex.beginRebuild(). */
    async beginRebuild(): Promise<void> {
        await this.index.beginRebuild();
    }

    /** See SegmentedMiniSearchIndex.commitRebuild(). */
    async commitRebuild(previousDocCount: number): Promise<boolean> {
        return this.index.commitRebuild(previousDocCount);
    }

    /** See SegmentedMiniSearchIndex.abortRebuild(). */
    async abortRebuild(): Promise<void> {
        await this.index.abortRebuild();
    }

    async search(query: string, topK: number = 10): Promise<Bm25Result[]> {
        const results = this.index.search(query, { combineWith: 'OR', prefix: true });
        return results.slice(0, topK).map(r => ({
            id: r.id as string,
            filePath: r.filePath as string,
            score: r.score,
            text: r.text as string
        }));
    }

    async getChunkCount(): Promise<number> {
        return this.index.documentCount;
    }
}
