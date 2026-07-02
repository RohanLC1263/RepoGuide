import * as path from 'path';
import { CodeChunk } from '../store/storeTypes';
import { ScoredChunk } from './tokenBudget';

export interface ConfidenceResult {
    level: 'high' | 'medium' | 'low';
    topFiles: string[];
    topFilePaths: string[];
    chunkCount: number;
    avgScore: number;
    explanation: string;
}

export function score(trimmedChunks: CodeChunk[], scoredChunks: ScoredChunk[]): ConfidenceResult {
    const relevantScores = trimmedChunks
        .map(chunk => scoredChunks.find(candidate => candidate.chunk.id === chunk.id)?.score ?? 0)
        .filter(value => Number.isFinite(value));

    const avgScore = relevantScores.length > 0
        ? relevantScores.reduce((sum, value) => sum + value, 0) / relevantScores.length
        : 0;

    const orderedPaths = Array.from(new Set(trimmedChunks.map(chunk => chunk.filePath)));
    const topFilePaths = orderedPaths.slice(0, 3);
    const topFiles = topFilePaths.map(filePath => path.basename(filePath));
    const distinctFileCount = new Set(trimmedChunks.map(chunk => chunk.filePath)).size;

    let level: 'high' | 'medium' | 'low' = 'low';
    if (avgScore > 0.75 && trimmedChunks.length >= 3 && distinctFileCount <= 2) {
        level = 'high';
    } else if (avgScore > 0.55 && trimmedChunks.length >= 2) {
        level = 'medium';
    }

    const explanation = level === 'high'
        ? `Answer based on ${trimmedChunks.length} chunks from ${topFiles.join(', ')} with strong relevance.`
        : level === 'medium'
            ? `Answer based on ${trimmedChunks.length} chunks across ${distinctFileCount} files with moderate relevance.`
            : 'Limited relevant context found. Consider resyncing the index.';

    return {
        level,
        topFiles,
        topFilePaths,
        chunkCount: trimmedChunks.length,
        avgScore,
        explanation
    };
}
