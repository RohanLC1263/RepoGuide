import { QACache, QAPair } from './qaCache';

function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || a.length !== b.length) {
        return 0;
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

export interface CacheHit {
    pair: QAPair;
    similarity: number;
}

export function searchCache(
    queryEmbedding: number[],
    cache: QACache,
    threshold = 0.85
): CacheHit | null {
    const index = cache.getSearchIndex();
    if (index.length === 0) {
        return null;
    }

    let bestId: number | null = null;
    let bestSimilarity = 0;

    for (const entry of index) {
        const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
        if (similarity >= threshold && similarity > bestSimilarity) {
            bestSimilarity = similarity;
            bestId = entry.id;
        }
    }

    if (bestId === null) {
        return null;
    }

    const pair = cache.getById(bestId);
    if (!pair) {
        return null;
    }

    return { pair, similarity: bestSimilarity };
}
