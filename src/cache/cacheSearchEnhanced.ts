import { QACache, QAPair } from './qaCache';
import { ClassifiedIntent } from '../comprehension/types';

export interface EnhancedCacheHit {
    pair: QAPair;
    similarity: number;
    pairId: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

export function searchCacheEnhanced(
    queryEmbedding: number[],
    cache: QACache,
    classifiedIntent: ClassifiedIntent,
    threshold: number = 0.85
): EnhancedCacheHit | null {
    const index = cache.getSearchIndex();
    if (index.length === 0) {
        return null;
    }

    let bestId: number | null = null;
    let bestFinalScore = 0;

    for (const entry of index) {
        if (!entry.embedding || entry.embedding.length === 0) {
            continue;
        }
        const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
        if (similarity < threshold) {
            continue;
        }

        const intentMatch = entry.category === classifiedIntent.intent;
        const adjustedScore = similarity * (1 + (intentMatch ? 0.1 : 0));
        
        // At index level, we don't have answerQuality, assume 0.5 for index search
        // We'll fetch the real pair and re-calculate if needed, but this is a fast pre-filter
        const finalScore = adjustedScore * (0.85 + 0.5 * 0.15);

        if (bestId === null || finalScore > bestFinalScore) {
            bestFinalScore = finalScore;
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

    // Re-calculate true final score with the pair's actual quality
    const finalSimilarity = cosineSimilarity(queryEmbedding, pair.questionEmbedding);
    const intentMatch = pair.category === classifiedIntent.intent;
    const adjustedScore = finalSimilarity * (1 + (intentMatch ? 0.1 : 0));
    const quality = typeof pair.answerQuality === 'number' ? pair.answerQuality : 0.5;
    const finalScore = adjustedScore * (0.85 + quality * 0.15);

    return {
        pair,
        similarity: finalScore,
        pairId: bestId
    };
}
