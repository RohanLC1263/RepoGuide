import * as fs from 'fs';
import * as path from 'path';
import MiniSearch, { SearchResult } from 'minisearch';
import { LogicalUnit, LogicalUnitRole } from '../indexing/logicalUnitTypes';

export class LogicalUnitBm25Store {
    private indexPath: string;
    private searcher: MiniSearch;

    constructor(dbDir: string) {
        this.indexPath = path.join(dbDir, 'logical_unit_bm25.json');
        this.searcher = this.createSearcher();
    }

    private createSearcher(): MiniSearch {
        return new MiniSearch({
            fields: ['content', 'symbol', 'filePath'],
            storeFields: ['id', 'symbol', 'filePath', 'role', 'type', 'startLine', 'endLine', 'extractionMethod', 'parseStatus'],
            idField: 'id',
            tokenize: (string) => string.toLowerCase().split(/[^a-z0-9_]+/i).filter(t => t.length > 1)
        });
    }

    async init(): Promise<void> {
        if (fs.existsSync(this.indexPath)) {
            try {
                const data = await fs.promises.readFile(this.indexPath, 'utf8');
                this.searcher = MiniSearch.loadJSON(data, {
                    fields: ['content', 'symbol', 'filePath'],
                    storeFields: ['id', 'symbol', 'filePath', 'role', 'type', 'startLine', 'endLine', 'extractionMethod', 'parseStatus'],
                    idField: 'id',
                    tokenize: (string) => string.toLowerCase().split(/[^a-z0-9_]+/i).filter(t => t.length > 1)
                });
            } catch (e) {
                console.warn(`[Warn] Failed to load LogicalUnit BM25 index from ${this.indexPath}, starting fresh:`, e);
                this.searcher = this.createSearcher();
            }
        }
    }

    private async save(): Promise<void> {
        try {
            await fs.promises.writeFile(this.indexPath, JSON.stringify(this.searcher), 'utf8');
        } catch (e) {
            console.error(`[Error] Failed to save LogicalUnit BM25 index to ${this.indexPath}:`, e);
        }
    }

    async indexUnits(units: LogicalUnit[]): Promise<void> {
        if (units.length === 0) return;
        
        await this.searcher.addAllAsync(units.map(u => ({
            id: u.id,
            content: u.content,
            symbol: u.symbol ?? "",
            filePath: u.filePath,
            role: u.role,
            type: u.type,
            startLine: u.startLine,
            endLine: u.endLine,
            extractionMethod: u.extractionMethod,
            parseStatus: u.parseStatus
        })));
        await this.save();
    }

    async removeByFile(filePath: string): Promise<void> {
        // MiniSearch doesn't have a direct way to discard by a field other than id.
        // We'd have to find them first, then discard them.
        // For simplicity and since MiniSearch is small enough, we can iterate all docs or filter.
        // MiniSearch doesn't expose the internal documents array directly in a stable way,
        // but we can search for the filePath, or we can just maintain it if needed.
        // Wait, MiniSearch exposes `documentCount`, `discard`.
        // Let's search for the exact file path to get the IDs.
        const results = this.searcher.search(filePath, { fields: ['filePath'], combineWith: 'AND', prefix: false });
        let changed = false;
        // Verify exact match
        for (const res of results) {
            if (res.filePath === filePath) {
                this.searcher.discard(res.id as string);
                changed = true;
            }
        }
        if (changed) {
            await this.save();
        }
    }

    async search(
        query: string,
        maxResults: number,
        options?: { excludeRoles?: LogicalUnitRole[] }
    ): Promise<Array<{
        unitId: string;
        symbol?: string;
        filePath: string;
        role: LogicalUnitRole;
        type: string;
        startLine: number;
        endLine: number;
        score: number;
    }>> {
        const excludeRoles = options?.excludeRoles ?? [];
        
        // Filter BEFORE returning (hard filter)
        const filterFn = (result: any) => {
            if (excludeRoles.length > 0 && excludeRoles.includes(result.role as LogicalUnitRole)) {
                return false;
            }
            return true;
        };

        const results = this.searcher.search(query, { 
            combineWith: 'OR', 
            prefix: true,
            filter: filterFn
        });

        return results.slice(0, maxResults).map(r => ({
            unitId: r.id as string,
            symbol: r.symbol ? (r.symbol as string) : undefined,
            filePath: r.filePath as string,
            role: r.role as LogicalUnitRole,
            type: r.type as string,
            startLine: r.startLine as number,
            endLine: r.endLine as number,
            score: r.score
        }));
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

    getIndexedCount(): number {
        return this.searcher.documentCount;
    }
}
