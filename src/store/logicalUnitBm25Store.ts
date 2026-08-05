import { LogicalUnit, LogicalUnitRole } from '../indexing/logicalUnitTypes';
import { SegmentedMiniSearchIndex } from './segmentedMiniSearchIndex';

interface IndexedUnit extends Record<string, unknown> {
    id: string;
    content: string;
    symbol: string;
    filePath: string;
    role: LogicalUnitRole;
    type: string;
    startLine: number;
    endLine: number;
    extractionMethod: string;
    parseStatus: string;
}

export class LogicalUnitBm25Store {
    private index: SegmentedMiniSearchIndex<IndexedUnit>;

    constructor(dbDir: string) {
        this.index = new SegmentedMiniSearchIndex<IndexedUnit>(dbDir, 'logical_unit_bm25', {
            fields: ['content', 'symbol', 'filePath'],
            storeFields: ['id', 'symbol', 'filePath', 'role', 'type', 'startLine', 'endLine', 'extractionMethod', 'parseStatus'],
            idField: 'id',
            tokenize: (string) => string.toLowerCase().split(/[^a-z0-9_]+/i).filter(t => t.length > 1)
        });
    }

    async init(): Promise<void> {
        await this.index.init();
    }

    async indexUnits(units: LogicalUnit[]): Promise<void> {
        if (units.length === 0) return;

        await this.index.addAllAsync(units.map(u => ({
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
    }

    async removeByFile(filePath: string): Promise<void> {
        const results = this.index.search(filePath, { fields: ['filePath'], combineWith: 'AND', prefix: false });
        const ids = results.filter(res => res.filePath === filePath).map(res => res.id as string);
        if (ids.length > 0) {
            await this.index.discardMany(ids);
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

        const results = this.index.search(query, {
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
        await this.index.clearAll();
    }

    /**
     * Rebuild-in-place alternative to clearAll() + indexUnits(). clearAll() empties
     * the live index immediately, so anything querying this same store instance --
     * the chat/retrieval pipeline shares it -- searches an empty index until
     * repopulation finishes. beginRebuild() stages into an inactive generation and
     * keeps serving the previous complete index until commitRebuild() swaps it
     * atomically. See SegmentedMiniSearchIndex.rebuildReadSnapshot.
     */
    async beginRebuild(): Promise<void> {
        await this.index.beginRebuild();
    }

    /** Returns false (and leaves the previous index live) if the rebuild produced
     *  nothing while the previous generation had documents. */
    /**
     * `expectedNonEmpty` makes the empty-index guard ABSOLUTE rather than relative.
     * `previousChunkCount > 0` alone cannot protect a FIRST run -- there is nothing to
     * compare against, so a pipeline that produced nothing (embeddings unreachable) would
     * commit an empty index and report success. Callers pass true when the walk found real
     * files, so "zero chunks from a repo that has files" is refused as the failure it is,
     * while a genuinely empty repository still commits cleanly.
     */
    async commitRebuild(previousDocCount: number, expectedNonEmpty = false): Promise<boolean> {
        return this.index.commitRebuild(previousDocCount, expectedNonEmpty);
    }

    async abortRebuild(): Promise<void> {
        await this.index.abortRebuild();
    }

    getIndexedCount(): number {
        return this.index.documentCount;
    }
}
