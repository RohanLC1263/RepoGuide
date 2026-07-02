export interface ContextFileEntry {
    filePath: string;
    hitCount: number;
    lastAccessedAt: number;
    startLine: number;
    endLine: number;
}

export class ContextAccumulator {
    private readonly entries = new Map<string, ContextFileEntry>();
    private readonly queryAccessMap = new Map<string, number>();
    private readonly maxEntries = 20;
    private queryCounter = 0;

    recordAccess(filePath: string, startLine: number, endLine: number): void {
        const existing = this.entries.get(filePath);
        const nextEntry: ContextFileEntry = existing
            ? {
                ...existing,
                hitCount: existing.hitCount + 1,
                lastAccessedAt: Date.now(),
                startLine,
                endLine
            }
            : {
                filePath,
                hitCount: 1,
                lastAccessedAt: Date.now(),
                startLine,
                endLine
            };

        this.entries.set(filePath, nextEntry);
        this.queryAccessMap.set(filePath, this.queryCounter);

        if (this.entries.size > this.maxEntries) {
            this.evictLeastRecentlyAccessed();
        }
    }

    getBoostScore(filePath: string): number {
        const lastQuery = this.queryAccessMap.get(filePath);
        if (lastQuery === undefined) {
            return 0;
        }

        const distance = this.queryCounter - lastQuery;
        if (distance <= 2) {
            return 0.3;
        }
        if (distance <= 5) {
            return 0.2;
        }
        if (distance <= 10) {
            return 0.1;
        }
        return 0;
    }

    incrementQueryCounter(): void {
        this.queryCounter += 1;
    }

    getRecentFiles(): string[] {
        return Array.from(this.entries.values())
            .filter(entry => {
                const lastQuery = this.queryAccessMap.get(entry.filePath);
                return lastQuery !== undefined && (this.queryCounter - lastQuery) <= 5;
            })
            .sort((a, b) => {
                const aQuery = this.queryAccessMap.get(a.filePath) ?? -1;
                const bQuery = this.queryAccessMap.get(b.filePath) ?? -1;
                return bQuery - aQuery;
            })
            .map(entry => entry.filePath);
    }

    clear(): void {
        this.entries.clear();
        this.queryAccessMap.clear();
        this.queryCounter = 0;
    }

    private evictLeastRecentlyAccessed(): void {
        let oldestFilePath: string | undefined;
        let oldestQuery = Number.POSITIVE_INFINITY;
        let oldestTimestamp = Number.POSITIVE_INFINITY;

        for (const [filePath, entry] of this.entries.entries()) {
            const lastQuery = this.queryAccessMap.get(filePath) ?? Number.NEGATIVE_INFINITY;
            if (
                lastQuery < oldestQuery ||
                (lastQuery === oldestQuery && entry.lastAccessedAt < oldestTimestamp)
            ) {
                oldestFilePath = filePath;
                oldestQuery = lastQuery;
                oldestTimestamp = entry.lastAccessedAt;
            }
        }

        if (oldestFilePath) {
            this.entries.delete(oldestFilePath);
            this.queryAccessMap.delete(oldestFilePath);
        }
    }
}
