import * as crypto from 'crypto';

/**
 * File-level hash cache stored in memory for the current session.
 * Maps absolute file path to the SHA-256 hash of the file content
 * at the time it was last indexed.
 */
const fileHashCache = new Map<string, string>();

/**
 * Records the file-level content hash after a file is indexed.
 */
export function setFileHash(filePath: string, contentHash: string): void {
    fileHashCache.set(filePath, contentHash);
}

/**
 * Gets the stored file-level content hash, or undefined if not known.
 */
export function getFileHash(filePath: string): string | undefined {
    return fileHashCache.get(filePath);
}

/**
 * Removes the file hash when a file is deleted from the index.
 */
export function deleteFileHash(filePath: string): void {
    fileHashCache.delete(filePath);
}

/**
 * Clears the entire hash cache (used during full re-index).
 */
export function clearFileHashes(): void {
    fileHashCache.clear();
}

/**
 * Pure reconciliation helper (testable without VS Code).
 * Compares workspace file list and store file list to determine
 * which files to add, check, or remove.
 */
export function reconcileFileLists(
    workspacePaths: string[],
    storePaths: string[]
): { toAdd: string[]; toCheck: string[]; toRemove: string[] } {
    const storeSet = new Set(storePaths);
    const workspaceSet = new Set(workspacePaths);

    const toAdd: string[] = [];
    const toCheck: string[] = [];
    const toRemove: string[] = [];

    for (const p of workspacePaths) {
        if (!storeSet.has(p)) {
            toAdd.push(p);
        } else {
            toCheck.push(p);
        }
    }

    for (const p of storePaths) {
        if (!workspaceSet.has(p)) {
            toRemove.push(p);
        }
    }

    return { toAdd, toCheck, toRemove };
}

/**
 * Determines whether a file needs re-indexing by comparing the current
 * file content hash to the stored file-level hash.
 */
export function fileNeedsReindex(currentContentHash: string, storedHash: string | undefined): boolean {
    if (!storedHash) {
        return true;
    }
    return currentContentHash !== storedHash;
}
