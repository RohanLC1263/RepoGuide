"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEEP_PROFILE = exports.FAST_PROFILE = void 0;
exports.getProfile = getProfile;
exports.FAST_PROFILE = {
    inferenceModel: 'qwen2.5-coder:7b',
    planningModel: 'qwen2.5-coder:3b',
    embeddingModel: 'nomic-embed-text',
    tokenBudget: 4000,
    maxChunks: 8,
    timeoutMs: 30000,
    enableQACache: false, // 3b is fast enough, cache not needed
    enableMultiPass: false,
    draftMaxTokens: 0,
    gapDetectionTimeout: 0
};
exports.DEEP_PROFILE = {
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
function getProfile() {
    try {
        // Dynamic require so module loads without vscode in unit tests
        var vscode = require('vscode');
        var config = vscode.workspace.getConfiguration('repoguide');
        var mode = config.get('performanceMode', 'fast');
        return mode === 'deep' ? exports.DEEP_PROFILE : exports.FAST_PROFILE;
    }
    catch (_a) {
        // Fallback for unit tests
        return exports.FAST_PROFILE;
    }
}
