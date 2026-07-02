import * as crypto from 'crypto';

/**
 * Hashes a text string using SHA-256. Used for chunk-level change detection.
 */
export function hashText(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Generates a deterministic chunk ID from file path + start line.
 */
export function chunkId(filePath: string, startLine: number, disambiguator: string = ''): string {
    return crypto.createHash('sha256').update(`${filePath}:${startLine}:${disambiguator}`).digest('hex');
}

/**
 * Hashes the full content of a file for file-level change detection.
 * Used by gitWatcher to skip unchanged files without comparing chunks.
 */
export function hashFileContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}
