import { CodeChunk } from '../store/storeTypes';
import { LocationData } from './responseParser';

interface LocationVisit {
    filePath: string;
    startLine: number;
    endLine: number;
    queryIndex: number;
}

export class SessionWorkingSet {
    private readonly recentChunks = new Map<string, CodeChunk>();
    private readonly activeFiles = new Set<string>();
    private readonly locationHistory: LocationVisit[] = [];
    private queryIndex = 0;

    incrementQueryIndex(): void {
        this.queryIndex += 1;
    }

    addChunks(chunks: CodeChunk[]): void {
        for (const chunk of chunks) {
            if (this.recentChunks.has(chunk.id)) {
                this.recentChunks.delete(chunk.id);
            }
            this.recentChunks.set(chunk.id, chunk);

            while (this.recentChunks.size > 30) {
                const oldestKey = this.recentChunks.keys().next().value as string | undefined;
                if (!oldestKey) {
                    break;
                }
                this.recentChunks.delete(oldestKey);
            }
        }
    }

    addLocations(locations: LocationData[]): void {
        for (const location of locations) {
            this.activeFiles.add(location.filePath);
            this.locationHistory.push({
                filePath: location.filePath,
                startLine: location.startLine,
                endLine: location.endLine,
                queryIndex: this.queryIndex
            });
        }
    }

    getActiveFileChunks(): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        for (const chunk of this.recentChunks.values()) {
            if (this.activeFiles.has(chunk.filePath)) {
                chunks.push(chunk);
            }
        }
        return chunks;
    }

    getSessionSummary(): string {
        return `Session: ${this.activeFiles.size} active files, ${this.recentChunks.size} cached chunks, ${this.locationHistory.length} locations visited`;
    }

    clear(): void {
        this.recentChunks.clear();
        this.activeFiles.clear();
        this.locationHistory.length = 0;
        this.queryIndex = 0;
    }

    getQueryIndex(): number {
        return this.queryIndex;
    }
}
