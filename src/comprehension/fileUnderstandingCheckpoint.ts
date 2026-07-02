import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FileStructure, FileUnderstanding } from './types';

export interface FileUnderstandingProgressStats {
    total: number;
    complete: number;
    cached: number;
    generated: number;
    remaining: number;
}

export function getFileUnderstandingCheckpointPath(
    understandingDir: string,
    filePath: string
): string {
    const normalizedPath = path.normalize(filePath);
    const hash = crypto
        .createHash('sha1')
        .update(normalizedPath)
        .digest('hex')
        .slice(0, 12);
    const safeName = normalizedPath
        .replace(/[^a-zA-Z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 100) || 'file';

    return path.join(understandingDir, 'files', `${safeName}-${hash}.json`);
}

export function loadValidFileUnderstandingCheckpoint(
    checkpointPath: string,
    expectedHash: string
): FileUnderstanding | null {
    if (!fs.existsSync(checkpointPath)) {
        return null;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as Partial<FileUnderstanding>;
        if (parsed.hash !== expectedHash || typeof parsed.filePath !== 'string' || parsed.schemaVersion !== '2.1') {
            return null;
        }
        return parsed as FileUnderstanding;
    } catch {
        return null;
    }
}

export function writeFileUnderstandingCheckpoint(
    checkpointPath: string,
    understanding: FileUnderstanding
): void {
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
    const tmpPath = checkpointPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(understanding, null, 2), 'utf8');
    fs.renameSync(tmpPath, checkpointPath);
}

export function getFileUnderstandingProgressStats(
    total: number,
    cached: number,
    generated: number
): FileUnderstandingProgressStats {
    const complete = cached + generated;
    return {
        total,
        complete,
        cached,
        generated,
        remaining: Math.max(0, total - complete)
    };
}

export function countValidFileUnderstandingCheckpoints(
    understandingDir: string,
    structures: FileStructure[]
): number {
    let count = 0;
    for (const structure of structures) {
        const checkpointPath = getFileUnderstandingCheckpointPath(understandingDir, structure.filePath);
        if (loadValidFileUnderstandingCheckpoint(checkpointPath, structure.hash)) {
            count += 1;
        }
    }
    return count;
}
