import * as fs from 'fs/promises';
import * as path from 'path';

export interface IndexMeta {
    lastFullIndexAt: string;
    lastSyncAt: string;
    chunkCount: number;
    fileCount: number;
    embeddingModel: string;
}

function getMetaPath(repoguideDir: string): string {
    return path.join(repoguideDir, 'meta.json');
}

export async function loadMeta(repoguideDir: string): Promise<IndexMeta | null> {
    try {
        const raw = await fs.readFile(getMetaPath(repoguideDir), 'utf8');
        return JSON.parse(raw) as IndexMeta;
    } catch {
        return null;
    }
}

export async function saveMeta(repoguideDir: string, meta: IndexMeta): Promise<void> {
    const metaPath = getMetaPath(repoguideDir);
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

export async function updateSyncTime(repoguideDir: string): Promise<void> {
    const existing = await loadMeta(repoguideDir);
    if (!existing) {
        return;
    }

    existing.lastSyncAt = new Date().toISOString();
    await saveMeta(repoguideDir, existing);
}
