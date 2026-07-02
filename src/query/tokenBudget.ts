import { CodeChunk } from '../store/storeTypes';
import { getProfile } from '../config/performanceConfig';

export interface ScoredChunk { chunk: CodeChunk; score: number; }

// Hard limits regardless of settings
const MAX_CHARS_PER_CHUNK_DEFAULT = 1200;
const MAX_CHARS_PER_CHUNK_LOCATION = 2400;
const PROMPT_OVERHEAD_TOKENS = 2000;
const HARD_TOKEN_CEILING = 7000;

export function trimToTokenBudget(
    chunks: ScoredChunk[],
    budgetTokens?: number,
    maxChunksOverride?: number,
    intentType?: string
): CodeChunk[] {
    let tokenBudget: number;
    let maxChunks: number;
    try {
        const profile = getProfile();
        tokenBudget = budgetTokens ?? profile.tokenBudget;
        maxChunks = maxChunksOverride ?? profile.maxChunks;
    } catch {
        // Fallback for unit tests where vscode is not available
        tokenBudget = budgetTokens ?? 6000;
        maxChunks = maxChunksOverride ?? 8;
    }

    const charsPerChunk = intentType === 'location'
        ? MAX_CHARS_PER_CHUNK_LOCATION
        : MAX_CHARS_PER_CHUNK_DEFAULT;

    const sorted = [...chunks].sort((a, b) => {
        const scoreDiff = b.score - a.score;
        if (Math.abs(scoreDiff) > 0.0001) {
            return scoreDiff;
        }
        if (a.chunk.filePath !== b.chunk.filePath) {
            return a.chunk.filePath.localeCompare(b.chunk.filePath);
        }
        return a.chunk.startLine - b.chunk.startLine;
    });
    const effectiveBudget = Math.min(tokenBudget, HARD_TOKEN_CEILING) - PROMPT_OVERHEAD_TOKENS;

    let currentTokens = 0;
    const selected: CodeChunk[] = [];

    for (const item of sorted) {
        if (selected.length >= maxChunks) { break; }

        let chunkText = item.chunk.text;
        
        if (chunkText.length > charsPerChunk) {
            if (chunkText.length <= charsPerChunk * 3) {
                // Keep it whole
            } else {
                // Drop it completely rather than corrupting the code block
                continue;
            }
        }

        const tokens = Math.ceil(chunkText.length / 4);
        if (currentTokens + tokens > effectiveBudget) { continue; }

        currentTokens += tokens;
        selected.push({ ...item.chunk, text: chunkText });
    }

    return selected;
}