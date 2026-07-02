import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Tracks file content hashes for incremental annotation.
 * A file needs re-annotation only when its hash changes.
 * Stores the registry at .repoguide/file_hashes.json
 */
export class MerkleHashTracker {
    private registry: Record<string, string> = {};
    private registryPath: string;
    private dirty = false;

    constructor(repoguideDir: string) {
        this.registryPath = path.join(repoguideDir, 'file_hashes.json');
    }

    /**
     * Load the hash registry from disk.
     */
    async init(): Promise<void> {
        if (fs.existsSync(this.registryPath)) {
            try {
                const raw = await fs.promises.readFile(this.registryPath, 'utf8');
                this.registry = JSON.parse(raw);
            } catch {
                this.registry = {};
            }
        }
    }

    /**
     * Compute sha256 hash of file content.
     */
    private computeHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * Check if a file's content has changed since we last recorded its hash.
     * Returns true if the file is new or its content has changed.
     */
    hasChanged(filePath: string, content: string): boolean {
        const currentHash = this.computeHash(content);
        const storedHash = this.registry[filePath];
        return storedHash !== currentHash;
    }

    /**
     * Update the stored hash for a file after successful annotation.
     */
    updateHash(filePath: string, content: string): void {
        this.registry[filePath] = this.computeHash(content);
        this.dirty = true;
    }

    /**
     * Get the stored hash for a file (used for annotation file naming).
     */
    getHash(filePath: string, content: string): string {
        return this.computeHash(content);
    }

    /**
     * From a list of file paths and their contents, return only those
     * whose content has changed since last annotation.
     */
    getChangedFiles(files: Array<{ filePath: string; content: string }>): string[] {
        return files
            .filter(f => this.hasChanged(f.filePath, f.content))
            .map(f => f.filePath);
    }

    /**
     * Remove a file from the hash registry (e.g. when file is deleted).
     */
    removeFile(filePath: string): void {
        delete this.registry[filePath];
        this.dirty = true;
    }

    /**
     * Persist the registry to disk if there are pending changes.
     */
    async save(): Promise<void> {
        if (!this.dirty) return;
        const dir = path.dirname(this.registryPath);
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(this.registryPath, JSON.stringify(this.registry, null, 2), 'utf8');
        this.dirty = false;
    }

    /**
     * Clear all tracked hashes.
     */
    clear(): void {
        this.registry = {};
        this.dirty = true;
    }

    /**
     * Get the total number of tracked files.
     */
    getTrackedCount(): number {
        return Object.keys(this.registry).length;
    }
}
