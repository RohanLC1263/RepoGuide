import { RepositoryContext } from '../context/repositoryContext';
import { SymbolIndex } from '../indexing/symbolIndex';
import { LanceStore } from '../store/lanceStore';
import { embedText } from '../ollama/embedder';
import { QACache } from './qaCache';
import { StatusBarManager } from '../ui/statusBar';
import { RequestQueue } from '../performance/requestQueue';
import { IdleDetector } from '../performance/idleDetector';
import { ModelManager } from '../performance/modelManager';
import { getProfile } from '../config/performanceConfig';
import { resolveOllamaUrl } from '../health/ollamaUrlSafety';

const GENERATION_PROMPT = (symbolName: string, language: string, code: string, filePath: string) => `
You are analyzing code from a project. Given this ${language} code for "${symbolName}" from file ${filePath}:

\`\`\`${language}
${code.substring(0, 1500)}
\`\`\`

Generate exactly 3 questions a developer would ask about this code, and answer each concisely.
Base answers ONLY on the code above. Be specific, cite line numbers when relevant.

Return ONLY valid JSON, no other text:
[
  {"question": "What does ${symbolName} do?", "answer": "..."},
  {"question": "How does ${symbolName} work step by step?", "answer": "..."},
  {"question": "What are the key responsibilities of ${symbolName}?", "answer": "..."}
]
`.trim();

export class QAGenerator {
    private isRunning = false;
    private shouldStop = false;
    private activeQueries = 0;
    private currentController: AbortController | null = null;

    constructor(
        private context: RepositoryContext,
        private symbolIndex: SymbolIndex,
        private store: LanceStore,
        private cache: QACache,
        private statusBar: StatusBarManager,
        private requestQueue?: RequestQueue,
        private idleDetector?: IdleDetector,
        private modelManager?: ModelManager
    ) {}

    async generateAll(workspaceRoot: string): Promise<void> {
        if (this.isRunning) {
            return;
        }
        this.isRunning = true;
        this.shouldStop = false;

        const profile = getProfile();
        if (!profile.enableQACache) {
            this.isRunning = false;
            return;
        }

        if (!this.cache.isAvailable()) {
            this.context.logger.warn('[Warn] Q&A pre-generation skipped because the cache backend is unavailable.');
            this.isRunning = false;
            return;
        }

        const stats = this.symbolIndex.getStats();
        this.context.logger.info(
            `[Info] Q&A pre-generation started for ${stats.totalSymbols} symbols.`
        );

        const ollamaUrl = resolveOllamaUrl(this.context);
        const model = profile.planningModel;

        if (this.modelManager) {
            const ready = await this.modelManager.ensureModelLoaded(model, ollamaUrl);
            if (!ready) {
                this.context.logger.warn('[Warn] Q&A pre-generation skipped because Ollama is unavailable.');
                this.isRunning = false;
                this.statusBar.restoreReady();
                return;
            }
        }

        let generated = 0;
        let skipped = 0;
        const allSymbols = this.symbolIndex.getAllSymbols();

        try {
            for (const symbol of allSymbols) {
                if (this.shouldStop) {
                    break;
                }

                await this.waitForIdle();

                const chunks = await this.store.getChunksByFile(symbol.filePath);
                const relevantChunk = chunks.find(c =>
                    c.startLine <= symbol.startLine && c.endLine >= symbol.startLine
                );

                if (!relevantChunk) {
                    skipped++;
                    continue;
                }

                try {
                    const prompt = GENERATION_PROMPT(
                        symbol.name,
                        relevantChunk.language,
                        relevantChunk.text,
                        symbol.filePath
                    );

                    const controller = new AbortController();
                    this.currentController = controller;
                    const timeoutId = setTimeout(() => controller.abort(), 90000);
                    let response: Response;
                    try {
                        response = await this.runGenerationRequest(`${ollamaUrl}/api/generate`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                model,
                                prompt,
                                stream: false,
                                keep_alive: this.modelManager?.getKeepAliveParam(true) ?? '60s'
                            }),
                            signal: controller.signal as RequestInit['signal']
                        });
                    } finally {
                        clearTimeout(timeoutId);
                        if (this.currentController === controller) {
                            this.currentController = null;
                        }
                    }

                    if (!response.ok) {
                        skipped++;
                        continue;
                    }

                    const data = await response.json() as { response?: string };
                    const text = stripMarkdownFences(data.response ?? '');
                    const pairs = parsePairs(text);

                    if (pairs.length === 0) {
                        skipped++;
                        continue;
                    }

                    for (const pair of pairs.slice(0, 3)) {
                        const questionEmbedding = await embedText(this.context, pair.question);
                        this.cache.insert({
                            question: pair.question,
                            answer: pair.answer,
                            filePath: symbol.filePath,
                            startLine: symbol.startLine,
                            endLine: symbol.endLine,
                            symbolName: symbol.name,
                            questionEmbedding,
                            generatedAt: new Date().toISOString()
                        });
                    }

                    generated++;
                    if (generated % 10 === 0) {
                        this.context.logger.info(
                            `[Info] Q&A pre-generation: ${generated}/${allSymbols.length} symbols processed. Cache has ${this.cache.getCount()} pairs.`
                        );
                    }

                    await new Promise(resolve => setTimeout(resolve, 5000));
                } catch (e) {
                    skipped++;
                    this.context.logger.warn(`[Warn] Q&A generation skipped ${symbol.name}: ${e}`);
                }
            }
        } finally {
            this.isRunning = false;
            this.statusBar.restoreReady();
        }

        this.context.logger.info(
            `[Info] Q&A pre-generation complete. ${generated} symbols processed, ${skipped} skipped, ${this.cache.getCount()} Q&A pairs cached.`
        );
    }

    stop(): void {
        this.shouldStop = true;
        this.currentController?.abort();
        this.currentController = null;
    }

    incrementActiveQueries(): void {
        this.activeQueries++;
        if (this.currentController) {
            this.context.logger.info('[Info] Q&A pre-generation paused for active user query.');
            this.currentController.abort();
            this.currentController = null;
        }
    }

    decrementActiveQueries(): void {
        this.activeQueries = Math.max(0, this.activeQueries - 1);
    }

    private async waitForIdle(): Promise<void> {
        while (
            (this.activeQueries > 0 || (this.idleDetector && !this.idleDetector.isIdle())) &&
            !this.shouldStop
        ) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    private async runGenerationRequest(url: string, init: RequestInit): Promise<Response> {
        if (this.requestQueue) {
            return this.requestQueue.enqueue(() => fetch(url, init));
        }
        return fetch(url, init);
    }
}

function stripMarkdownFences(text: string): string {
    return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function parsePairs(text: string): Array<{ question: string; answer: string }> {
    try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed
            .filter((pair): pair is { question: string; answer: string } =>
                typeof pair?.question === 'string' &&
                pair.question.trim().length > 0 &&
                typeof pair?.answer === 'string' &&
                pair.answer.trim().length > 0
            )
            .map(pair => ({
                question: pair.question.trim(),
                answer: pair.answer.trim()
            }));
    } catch {
        return [];
    }
}
