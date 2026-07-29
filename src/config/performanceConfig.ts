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
/**
 * Environment overrides, so a headless run (MCP server, evaluation harness) can select
 * models without a settings UI. Same pattern as REPOGUIDE_RERANKER and
 * REPOGUIDE_DETERMINISTIC; this is what lets one eval arm differ from another by exactly
 * one model.
 */
function envOverride(name: string): string | undefined {
    const value = process.env[name];
    return value && value.trim() !== '' ? value.trim() : undefined;
}

export function getProfile(): PerformanceProfile {
    const base = (() => {
        try {
            // Dynamic require so module loads without vscode in unit tests
            const vscode = require('vscode') as typeof import('vscode');
            const config = vscode.workspace.getConfiguration('repoguide');
            const mode = config.get<string>('performanceMode', 'fast');
            const profile = mode === 'deep' ? DEEP_PROFILE : FAST_PROFILE;
            // `repoguide.inferenceModel` and `repoguide.embeddingModel` have been declared
            // in package.json all along, but getProfile() previously returned the hardcoded
            // profile values and never read them -- embeddingModel in particular was read
            // nowhere in the codebase, so changing it did nothing. Honouring them here is
            // what makes an alternate generator or embedder selectable at all.
            return {
                ...profile,
                inferenceModel: config.get<string>('inferenceModel')?.trim() || profile.inferenceModel,
                embeddingModel: config.get<string>('embeddingModel')?.trim() || profile.embeddingModel
            };
        } catch {
            // Fallback for unit tests and any non-vscode host
            return { ...FAST_PROFILE };
        }
    })();

    return {
        ...base,
        inferenceModel: envOverride('REPOGUIDE_INFERENCE_MODEL') ?? base.inferenceModel,
        embeddingModel: envOverride('REPOGUIDE_EMBEDDING_MODEL') ?? base.embeddingModel
    };
}
