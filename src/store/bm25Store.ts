import * as fs from 'fs';
import * as path from 'path';
import MiniSearch, { SearchResult } from 'minisearch';
import { CodeChunk } from './storeTypes';

export interface Bm25Result {
    id: string;
    filePath: string;
    score: number;
    text: string;
}

export class Bm25Store {
    private indexPath: string;
    private searcher: MiniSearch;

    constructor(dbDir: string) {
        this.indexPath = path.join(dbDir, 'bm25_index.json');
        this.searcher = this.createSearcher();
    }

    private createSearcher(): MiniSearch {
        return new MiniSearch({
            fields: ['filePath', 'text'], // fields to index for full-text search
            storeFields: ['filePath', 'text'], // fields to return with search results
            idField: 'id',
            tokenize: (string) => string.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 0)
        });
    }

    async init(): Promise<void> {
        if (fs.existsSync(this.indexPath)) {
            try {
                const data = await fs.promises.readFile(this.indexPath, 'utf8');
                this.searcher = MiniSearch.loadJSON(data, {
                    fields: ['filePath', 'text'],
                    storeFields: ['filePath', 'text'],
                    idField: 'id',
                    tokenize: (string) => string.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 0)
                });
            } catch (e) {
                console.warn(`[Warn] Failed to load BM25 index from ${this.indexPath}, starting fresh:`, e);
                this.searcher = this.createSearcher();
            }
        }
    }

    private async save(): Promise<void> {
        try {
            await fs.promises.writeFile(this.indexPath, JSON.stringify(this.searcher), 'utf8');
        } catch (e) {
            console.error(`[Error] Failed to save BM25 index to ${this.indexPath}:`, e);
        }
    }

    async insertChunks(chunks: CodeChunk[]): Promise<void> {
        if (chunks.length === 0) return;
        this.searcher.addAll(chunks.map(c => ({
            id: c.id,
            filePath: c.filePath,
            text: c.text
        })));
        await this.save();
    }

    async deleteChunkById(id: string): Promise<void> {
        if (this.searcher.has(id)) {
            this.searcher.discard(id);
            await this.save();
        }
    }

    async deleteChunksByIds(ids: string[]): Promise<void> {
        let changed = false;
        for (const id of ids) {
            if (this.searcher.has(id)) {
                this.searcher.discard(id);
                changed = true;
            }
        }
        if (changed) {
            await this.save();
        }
    }

    async clearAll(): Promise<void> {
        this.searcher.removeAll();
        if (fs.existsSync(this.indexPath)) {
            try {
                await fs.promises.unlink(this.indexPath);
            } catch (e) {
                // Ignore
            }
        }
        this.searcher = this.createSearcher();
    }

    async search(query: string, topK: number = 10): Promise<Bm25Result[]> {
        const results = this.searcher.search(query, { combineWith: 'OR', prefix: true });
        return results.slice(0, topK).map(r => ({
            id: r.id as string,
            filePath: r.filePath as string,
            score: r.score,
            text: r.text as string
        }));
    }

    async getChunkCount(): Promise<number> {
        return this.searcher.documentCount;
    }
}
