import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../context/repositoryContext';

export interface FileManifestEntry {
    relativePath: string;
    size: number;
    mtimeMs: number;
    contentHash: string;
    indexedAt: string;
    language: string;
    role: string;
    unitCount: number;
    factCount: number;
    parseDiagnostics: string[];
}

export class IndexManifestStore {
    private manifestPath: string;
    private entries: Map<string, FileManifestEntry> = new Map();

    constructor(repoguideDir: string, private logger?: Logger) {
        this.manifestPath = path.join(repoguideDir, 'manifest.json');
    }

    async init(): Promise<void> {
        try {
            if (fs.existsSync(this.manifestPath)) {
                const data = await fs.promises.readFile(this.manifestPath, 'utf8');
                const parsed = JSON.parse(data) as FileManifestEntry[];
                for (const entry of parsed) {
                    this.entries.set(entry.relativePath, entry);
                }
            }
        } catch (e) {
            this.logger?.error(`Failed to load index manifest: ${e}`);
        }
    }

    async save(): Promise<void> {
        try {
            await fs.promises.mkdir(path.dirname(this.manifestPath), { recursive: true });
            const data = Array.from(this.entries.values());
            await fs.promises.writeFile(this.manifestPath, JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {
            this.logger?.error(`Failed to save index manifest: ${e}`);
        }
    }

    getEntry(relativePath: string): FileManifestEntry | undefined {
        return this.entries.get(relativePath);
    }

    setEntry(relativePath: string, entry: FileManifestEntry): void {
        this.entries.set(relativePath, entry);
    }

    removeEntry(relativePath: string): void {
        this.entries.delete(relativePath);
    }

    clear(): void {
        this.entries.clear();
    }

    getAllPaths(): string[] {
        return Array.from(this.entries.keys());
    }
}
