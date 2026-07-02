
import { RepositoryContext } from '../context/repositoryContext';
import { QACache } from './qaCache';
import { FeedbackHandler } from './feedbackHandler';
import { ComprehensionEngine } from '../comprehension/comprehensionEngine';
import { ModuleUnderstanding, ProjectUnderstanding } from '../comprehension/types';
import { getProfile } from '../config/performanceConfig';
import { IdleDetector } from '../performance/idleDetector';
import { embedText } from '../ollama/embedder';
import { INFERENCE_MODEL_OPTIONS } from '../ollama/inferencer';

const VALID_CATEGORIES = new Set(['location', 'flow', 'architecture', 'explanation', 'debugging']);

export class ComprehensionQAGenerator {
    private isRunning = false;
    private shouldStop = false;

    constructor(
        private comprehensionEngine: ComprehensionEngine,
        private cache: QACache,
        private feedbackHandler: FeedbackHandler,
        private ollamaUrl: string,
        private idleDetector: IdleDetector,
        private context: RepositoryContext
    ) {}

    stop(): void {
        this.shouldStop = true;
    }

    async generateAll(workspaceRoot: string): Promise<void> {
        if (this.isRunning) {
            return;
        }

        const profile = getProfile();
        if (!profile.enableQACache) {
            this.context.logger.info('[Info] Comprehension Q&A generation skipped: Q&A cache disabled in current profile.');
            return;
        }
        if (!this.cache.isAvailable()) {
            this.context.logger.warn('[Warn] Comprehension Q&A generation skipped: cache backend unavailable.');
            return;
        }

        this.isRunning = true;
        this.shouldStop = false;

        let generatedCount = 0;

        try {
            const projectUnderstanding = this.comprehensionEngine.getProjectUnderstanding();
            if (!projectUnderstanding) {
                this.context.logger.warn('[Warn] Comprehension Q&A generation skipped: project understanding not available.');
                return;
            }

            const allModules = this.comprehensionEngine.getAllModuleUnderstandings();
            this.context.logger.info(
                `[Info] Comprehension Q&A generation started: ${allModules.length} modules`
            );

            const projectQuestions = await this.generateQuestionsFromModel(
                projectUnderstanding.purpose,
                projectUnderstanding.architecture_type,
                projectUnderstanding.key_concepts,
                this.buildProjectContextSummary(projectUnderstanding, allModules, workspaceRoot),
                projectUnderstanding.data_flow,
                12
            );

            for (const item of projectQuestions) {
                if (this.shouldStop) {
                    break;
                }
                await this.waitForIdle();
                if (this.shouldStop) {
                    break;
                }
                await this.generateAndStore(item.question, item.category, 'project');
                generatedCount += 1;
                await this.throttle(8000);
            }

            for (const module of allModules) {
                if (this.shouldStop) {
                    break;
                }

                const moduleQuestions = await this.generateQuestionsFromModel(
                    module.modulePurpose,
                    projectUnderstanding.architecture_type,
                    module.keyConcepts,
                    this.buildModuleContextSummary(module, workspaceRoot),
                    module.dataFlow,
                    5
                );

                for (const item of moduleQuestions) {
                    if (this.shouldStop) {
                        break;
                    }
                    await this.waitForIdle();
                    if (this.shouldStop) {
                        break;
                    }
                    await this.generateAndStore(item.question, item.category, module.modulePath);
                    generatedCount += 1;

                    if (generatedCount % 10 === 0) {
                        this.context.logger.info(
                            `[Info] Comprehension Q&A: ${generatedCount} pairs generated`
                        );
                    }

                    await this.throttle(8000);
                }
            }

            this.context.logger.info(
                `[Info] Comprehension Q&A generation complete. ${generatedCount} pairs. Cache total: ${this.cache.getCount()}.`
            );
        } finally {
            this.isRunning = false;
        }
    }

    private async generateQuestionsFromModel(
        purpose: string,
        architectureType: string,
        keyConcepts: string[],
        contextSummary: string,
        dataFlow: string,
        count: number
    ): Promise<Array<{ question: string; category: string }>> {
        const profile = getProfile();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const prompt = [
            'You are generating project-specific Q&A seeds for a code intelligence cache.',
            `Generate exactly ${count} distinct developer questions grounded in the project context below.`,
            'Mix question styles across location, flow, architecture, explanation, and debugging where appropriate.',
            'Questions must be concrete and answerable from code context, not generic programming advice.',
            '',
            'Return ONLY valid JSON array no markdown:',
            '[{"question": "...", "category": "location|flow|architecture|explanation|debugging"}]',
            '',
            `Purpose: ${purpose}`,
            `Architecture type: ${architectureType}`,
            `Key concepts: ${keyConcepts.join(', ') || 'none'}`,
            `Data flow: ${dataFlow || 'not specified'}`,
            'Context summary:',
            contextSummary
        ].join('\n');

        try {
            const response = await fetch(`${this.ollamaUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: profile.inferenceModel,
                    prompt,
                    stream: false,
                    options: { ...INFERENCE_MODEL_OPTIONS, num_predict: 600 },
                    keep_alive: '0'
                }),
                signal: controller.signal as RequestInit['signal']
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                return [];
            }

            const data = await response.json() as { response?: string };
            const cleaned = (data.response ?? '')
                .trim()
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/\s*```$/i, '')
                .trim();

            const parsed = JSON.parse(cleaned) as Array<{ question?: string; category?: string }>;
            if (!Array.isArray(parsed)) {
                return [];
            }

            return parsed
                .map(item => ({
                    question: typeof item.question === 'string' ? item.question.trim() : '',
                    category: normalizeCategory(item.category)
                }))
                .filter(item => item.question.length > 0)
                .slice(0, count);
        } catch {
            clearTimeout(timeoutId);
            return [];
        }
    }

    private async generateAndStore(
        question: string,
        category: string,
        sourceModule: string
    ): Promise<void> {
        try {
            const questionEmbedding = await embedText(this.context, question);
            const existing = this.cache.getAll();

            for (const pair of existing) {
                if (pair.questionEmbedding.length === 0) {
                    continue;
                }
                if (cosineSim(questionEmbedding, pair.questionEmbedding) > 0.95) {
                    return;
                }
            }

            const projectUnderstanding = this.comprehensionEngine.getProjectUnderstanding();
            const relatedModules = this.pickRelevantModules(sourceModule);
            const prompt = this.buildAnswerPrompt(
                question,
                projectUnderstanding,
                relatedModules,
                sourceModule
            );

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);

            try {
                const response = await fetch(`${this.ollamaUrl}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: getProfile().inferenceModel,
                        prompt,
                        stream: false,
                        options: { ...INFERENCE_MODEL_OPTIONS, num_predict: 200 },
                        keep_alive: '0'
                    }),
                    signal: controller.signal as RequestInit['signal']
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    return;
                }

                const data = await response.json() as { response?: string };
                const answer = (data.response ?? '').trim();
                if (answer.length < 30) {
                    return;
                }

                this.cache.insert({
                    question,
                    answer,
                    filePath: sourceModule,
                    startLine: 0,
                    endLine: 0,
                    symbolName: sourceModule || 'project',
                    questionEmbedding,
                    generatedAt: new Date().toISOString(),
                    category: normalizeCategory(category),
                    sourceModule,
                    answerQuality: 0.5,
                    hitCount: 0
                });

                void this.feedbackHandler.hasStale();
            } catch {
                clearTimeout(timeoutId);
            }
        } catch (error) {
            this.context.logger.warn(`[Warn] Comprehension Q&A pair skipped: ${error}`);
        }
    }

    private async waitForIdle(): Promise<void> {
        const startedAt = Date.now();
        const maxWaitMs = 60000;

        while (!this.shouldStop && !this.idleDetector.isIdle()) {
            if (Date.now() - startedAt >= maxWaitMs) {
                this.context.logger.warn('[Warn] Comprehension Q&A idle wait timed out; continuing in background generation mode.');
                return;
            }
            await this.throttle(1000);
        }
    }

    private async throttle(ms: number = 8000): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    private buildProjectContextSummary(
        project: ProjectUnderstanding,
        modules: ModuleUnderstanding[],
        workspaceRoot: string
    ): string {
        const moduleLines = modules
            .slice(0, 8)
            .map(module => `- ${module.modulePath}: ${module.modulePurpose}`);

        return [
            `Workspace: ${workspaceRoot}`,
            `Project purpose: ${project.purpose}`,
            `Project modules: ${Object.keys(project.modules).length}`,
            `Entry points: ${project.entry_points.join(', ') || 'none'}`,
            `Concepts: ${project.key_concepts.join(', ') || 'none'}`,
            'Representative modules:',
            ...moduleLines
        ].join('\n');
    }

    private buildModuleContextSummary(module: ModuleUnderstanding, workspaceRoot: string): string {
        return [
            `Workspace: ${workspaceRoot}`,
            `Module path: ${module.modulePath}`,
            `Purpose: ${module.modulePurpose}`,
            `Files: ${module.filePaths.slice(0, 8).join(', ') || 'none'}`,
            `Key concepts: ${module.keyConcepts.join(', ') || 'none'}`,
            `Dependencies: ${module.externalDependencies.map(d => d.module).join(', ') || 'none'}`,
            `Data flow: ${module.dataFlow || 'not specified'}`
        ].join('\n');
    }

    private buildAnswerPrompt(
        question: string,
        projectUnderstanding: ProjectUnderstanding | null,
        relatedModules: ModuleUnderstanding[],
        sourceModule: string
    ): string {
        const moduleSummary = relatedModules
            .slice(0, 4)
            .map(module => `- ${module.modulePath}: ${module.modulePurpose}`)
            .join('\n');

        return [
            'You are generating a concise, project-specific answer for a repository Q&A cache.',
            'Keep the answer grounded in the provided project comprehension context.',
            'Do not invent files or functions. If context is thin, answer conservatively.',
            '',
            `Project purpose: ${projectUnderstanding?.purpose ?? 'unknown'}`,
            `Architecture type: ${projectUnderstanding?.architecture_type ?? 'unknown'}`,
            `Data flow: ${projectUnderstanding?.data_flow ?? 'unknown'}`,
            `Source module: ${sourceModule || 'project'}`,
            'Relevant modules:',
            moduleSummary || '- none',
            '',
            `Question: ${question}`
        ].join('\n');
    }

    private pickRelevantModules(sourceModule: string): ModuleUnderstanding[] {
        const allModules = this.comprehensionEngine.getAllModuleUnderstandings();
        if (!sourceModule || sourceModule === 'project') {
            return allModules.slice(0, 4);
        }

        const exact = allModules.find(module => module.modulePath === sourceModule);
        if (exact) {
            return [exact];
        }

        return allModules
            .filter(module => module.modulePath.includes(sourceModule) || sourceModule.includes(module.modulePath))
            .slice(0, 4);
    }
}

function normalizeCategory(category: string | undefined): string {
    const normalized = (category ?? '').trim().toLowerCase();
    return VALID_CATEGORIES.has(normalized) ? normalized : 'explanation';
}

function cosineSim(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        dot += a[index] * b[index];
        normA += a[index] * a[index];
        normB += b[index] * b[index];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dot / denominator;
}
