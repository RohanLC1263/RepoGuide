export interface PerformanceProfile {
    inferenceModel: string;
    planningModel: string;
    embeddingModel: string;
    tokenBudget: number;
    maxChunks: number;
    timeoutMs: number;
    enableQACache: boolean;
    enableMultiPass: boolean;
    draftMaxTokens: number;
    gapDetectionTimeout: number;
}

export const FAST_PROFILE: PerformanceProfile = {
    inferenceModel: 'qwen2.5-coder:7b',
    planningModel: 'qwen2.5-coder:3b',
    embeddingModel: 'nomic-embed-text',
    tokenBudget: 4000,
    maxChunks: 8,
    timeoutMs: 30000,
    enableQACache: false,  // 3b is fast enough, cache not needed
    enableMultiPass: false,
    draftMaxTokens: 0,
    gapDetectionTimeout: 0
};

export const DEEP_PROFILE: PerformanceProfile = {
    inferenceModel: 'qwen2.5-coder:7b',
    planningModel: 'qwen2.5-coder:3b',
    embeddingModel: 'nomic-embed-text',
    tokenBudget: 6000,
    maxChunks: 15,
    timeoutMs: 120000,
    enableQACache: true,
    enableMultiPass: true,
    draftMaxTokens: 250,
    gapDetectionTimeout: 4000
};

/**
 * Reads the current performance profile from user settings.
 * Uses dynamic require for vscode to stay compatible with
 * plain-Node test runners where vscode is unavailable.
 */
export function getProfile(): PerformanceProfile {
    try {
        // Dynamic require so module loads without vscode in unit tests
        const vscode = require('vscode') as typeof import('vscode');
        const config = vscode.workspace.getConfiguration('repoguide');
        const mode = config.get<string>('performanceMode', 'fast');
        return mode === 'deep' ? DEEP_PROFILE : FAST_PROFILE;
    } catch {
        // Fallback for unit tests
        return FAST_PROFILE;
    }
}
