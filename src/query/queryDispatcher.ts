import { RepositoryContext } from '../context/repositoryContext';

import { ConfidenceResult } from './confidenceScorer';
import { ExplainSelectionBackendResult, AnswerMetadata } from './answerMetadata';
import { ExecutionPlanner, PlanningRequest, ExecutionPlan } from './executionPlanner';
import { RetrievalOrchestrator, RetrievalOrchestrationResult } from './retrievalOrchestrator';
import { EvidencePacketBuilder, EvidencePacketBuilderStores } from './evidencePacketBuilder';
import { EvidenceAnswerSynthesizer } from './evidenceAnswerSynthesizer';
import { AnswerGate, AnswerGatePolicy } from './answerGate';
import { getProfile } from '../config/performanceConfig';
import { MentorOrchestrator } from '../mentor/mentorOrchestrator';
import { MentorInsightRenderer } from '../mentor/mentorInsightRenderer';
import { MemoryStoreFactory } from '../memory/memoryStoreFactory';
import { LanceDbMemoryRetriever } from '../memory/lanceDbMemoryRetriever';
import { InMemoryValueRepository } from '../memory/lifecycle/inMemoryValueRepository';
import { LifecycleAwareRetriever } from '../memory/lifecycle/lifecycleAwareRetriever';
import { AttributionFormatter } from './attributionFormatter';
import { SemanticCategory, EvidenceItem, EvidencePacket } from './evidencePacket';
import { EvidenceQueryTelemetrySink, EvidenceQueryTelemetrySnapshot } from './evidenceQueryTelemetry';
import { ConversationHistory } from './conversationHistory';

export interface ChatPipeline {
    query(
        question: string,
        abortSignal?: AbortSignal,
        onConfidence?: (confidence: ConfidenceResult) => Promise<void> | void
    ): AsyncGenerator<string>;
    explainSelection(
        filePath: string,
        selectedText: string,
        startLine: number,
        endLine: number,
        language: string,
        abortSignal?: AbortSignal,
        question?: string
    ): AsyncGenerator<string>;
    explainSelectionResult?(
        filePath: string,
        selectedText: string,
        startLine: number,
        endLine: number,
        language: string,
        abortSignal?: AbortSignal,
        question?: string
    ): Promise<ExplainSelectionBackendResult>;
}

export interface QueryDispatcherOptions {
    executionPlanner?: ExecutionPlanner;
    retrievalOrchestrator?: RetrievalOrchestrator;
    client?: PlanningRequest['client'];
    telemetrySink?: EvidenceQueryTelemetrySink;
    emitEvaluationContext?: boolean;
}

function policyFromVerificationPlan(plan: ExecutionPlan['verificationPlan']): AnswerGatePolicy {
    return {
        checkNumericClaims: plan.checkNumericClaims,
        checkQuotedStrings: plan.checkQuotedStrings,
        checkFilePaths: plan.checkFilePaths
    };
}

/** Computes a real confidence signal from packet coverage/item scores, replacing the
 * previously-hardcoded `level: 'high'` the evidence path always reported to the UI.
 * `packet.coverageScore` here is `matchedRequiredEvidence / plan.requiredEvidence.length`
 * (see EvidencePacketBuilder) -- a DIFFERENT metric from the "fact-type match ratio"
 * logged elsewhere in this file, which is diagnostic-only and does not feed this. */
function computeEvidenceConfidence(packet: EvidencePacket, explanation: string): ConfidenceResult {
    const allScores = [...packet.items, ...packet.facts].map(item => Number(item.score) || 0);
    const avgScore = allScores.length > 0 ? allScores.reduce((sum, value) => sum + value, 0) / allScores.length : 0;
    const distinctFiles = new Set([...packet.items, ...packet.facts].map(item => item.file));
    const topFilePaths = Array.from(distinctFiles).slice(0, 3);

    let level: 'high' | 'medium' | 'low' = 'low';
    if (packet.coverageScore >= 0.75 && avgScore > 0.75 && (packet.items.length + packet.facts.length) >= 3) {
        level = 'high';
    } else if (packet.coverageScore >= 0.4 && avgScore > 0.5) {
        level = 'medium';
    }

    return {
        level,
        topFiles: topFilePaths.map(p => p.split(/[\\/]/).pop() ?? p),
        topFilePaths,
        chunkCount: packet.items.length + packet.facts.length,
        avgScore,
        explanation
    };
}

export class QueryDispatcher implements ChatPipeline {
    private packetBuilder: EvidencePacketBuilder;
    private synthesizer: EvidenceAnswerSynthesizer;
    private answerGate: AnswerGate;
    private mentorOrchestrator: MentorOrchestrator;
    private mentorRenderer: MentorInsightRenderer;
    private attributionFormatter: AttributionFormatter;
    private executionPlanner: ExecutionPlanner;
    private retrievalOrchestrator?: RetrievalOrchestrator;
    private client: PlanningRequest['client'];
    private telemetrySink?: EvidenceQueryTelemetrySink;
    private emitEvaluationContext: boolean;
    private lifecycleRetriever?: LifecycleAwareRetriever;

    private context: RepositoryContext;

    private async getMemoryRetriever(): Promise<LifecycleAwareRetriever> {
        if (this.lifecycleRetriever) return this.lifecycleRetriever;
        const workspaceRoot = this.context.workspaceRoot;
        const memoryStore = await MemoryStoreFactory.getMemoryStore(workspaceRoot);
        const valueRepo = new InMemoryValueRepository();
        const pureRetriever = new LanceDbMemoryRetriever(memoryStore);
        this.lifecycleRetriever = new LifecycleAwareRetriever(pureRetriever, valueRepo);
        return this.lifecycleRetriever;
    }

    constructor(
        private readonly history: ConversationHistory,
        stores: EvidencePacketBuilderStores,
        context?: RepositoryContext,
        options: QueryDispatcherOptions = {}
    ) {
        if (!context) { throw new Error('RepositoryContext must be provided'); }
        this.context = context;
        this.packetBuilder = new EvidencePacketBuilder(stores, this.context.workspaceRoot);
        this.executionPlanner = options.executionPlanner ?? new ExecutionPlanner(this.context);
        this.retrievalOrchestrator = options.retrievalOrchestrator;
        this.client = options.client ?? 'vscode';
        this.telemetrySink = options.telemetrySink;
        this.emitEvaluationContext = options.emitEvaluationContext ?? false;
        this.synthesizer = new EvidenceAnswerSynthesizer(this.context);
        this.answerGate = new AnswerGate();
        this.mentorOrchestrator = new MentorOrchestrator();
        this.mentorRenderer = new MentorInsightRenderer();
        this.attributionFormatter = new AttributionFormatter();
    }

    private conversationContextForPlanning(): Array<{ role: 'user' | 'assistant'; content: string }> {
        return this.history.getMessages().map(m => ({ role: m.role, content: m.content }));
    }

    async *query(
        question: string,
        abortSignal?: AbortSignal,
        onConfidence?: (confidence: ConfidenceResult) => Promise<void> | void
    ): AsyncGenerator<string> {
        yield* this.runEvidenceQuery(question, abortSignal, onConfidence);
    }

    private async *runEvidenceQuery(
        question: string,
        abortSignal?: AbortSignal,
        onConfidence?: (confidence: ConfidenceResult) => Promise<void> | void
    ): AsyncGenerator<string> {
        const telemetryStartedAt = performance.now();
        const telemetry: EvidenceQueryTelemetrySnapshot = {
            mode: 'evidence',
            question,
            timings: {}
        };
        const profile = getProfile();
        const inferenceModel = profile.inferenceModel;

        const planningStartedAt = performance.now();
        const executionPlan = await this.executionPlanner.plan({
            requestId: buildQueryRequestId(),
            query: question,
            client: this.client,
            workspaceRoot: this.context.workspaceRoot,
            repoguideDir: this.context.repoguideDataDir ?? this.context.workspaceRoot,
            mode: 'answer',
            conversationContext: this.conversationContextForPlanning(),
            constraints: {
                allowLLMPlanning: true
            }
        }, inferenceModel);
        telemetry.timings.planningMs = performance.now() - planningStartedAt;
        telemetry.executionPlan = executionPlan;
        const plan = executionPlan.evidencePlan;
        const complexity = executionPlan.complexity;

        if (executionPlan.metadata.planner === 'llm') {
            this.context.logger.info(`[Planner] Routed to LLM Planner (Score: ${complexity.score}, Reasons: ${complexity.reasons.join(', ')})`);
        } else {
            this.context.logger.info(`[Planner] Routed to Regex Planner (Score: ${complexity.score})`);
        }

        let retrievalResult: RetrievalOrchestrationResult | undefined;
        if (this.retrievalOrchestrator) {
            try {
                const retrievalStartedAt = performance.now();
                retrievalResult = await this.retrievalOrchestrator.execute(executionPlan);
                telemetry.timings.retrievalMs = performance.now() - retrievalStartedAt;
                telemetry.retrievalResult = retrievalResult;
                this.context.logger.appendLine(`[RetrievalOrchestrator] Providers invoked: ${retrievalResult.metadata.providersInvoked.join(', ') || 'none'}`);
            } catch (error) {
                this.context.logger.appendLine(`[RetrievalOrchestrator] Error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const packetStartedAt = performance.now();
        const packet = await this.packetBuilder.buildPacket(question, plan, retrievalResult);
        telemetry.timings.packetMs = performance.now() - packetStartedAt;
        telemetry.packet = packet;

        const factsCount = packet.facts.length;
        const factTypes = Array.from(new Set(packet.facts.map(f => f.type))).join(', ');
        const unitsCount = packet.items.length;

        const coveredTypes = new Set(packet.facts.map(f => f.type));
        let matches = 0;
        for (const ft of plan.factTypes) {
            if (coveredTypes.has(ft)) matches++;
        }
        // Log-only diagnostic: what fraction of the *planner's* requested fact
        // types actually got covered. Frequently and correctly "0.00" for broad
        // "explain X"/"what does Y do" questions, since the planner doesn't
        // identify specific structured fact-type targets for those -- that's not
        // a sign of missing evidence. This is NOT the number that drives the
        // confidence badge; see packet.coverageScore (computeEvidenceConfidence,
        // below) for that. Previously both were called "coverage", which made a
        // benign, expected 0.00 here look alarming and easy to conflate with the
        // real confidence-driving metric.
        const factTypeMatchRatio = plan.factTypes.length > 0 ? (matches / plan.factTypes.length).toFixed(2) : '0.00';

        this.context.logger.appendLine(`Query type: ${plan.queryType}`);
        this.context.logger.appendLine(`Symbol hints: ${plan.symbolHints.join(', ')}`);
        this.context.logger.appendLine(`Facts retrieved: ${factsCount} (${factTypes})`);
        this.context.logger.appendLine(`Units retrieved: ${unitsCount}`);
        this.context.logger.appendLine(`Fact-type match ratio: ${factTypeMatchRatio} (planner-requested fact types found; diagnostic only, does not affect confidence)`);

        if (onConfidence) {
            await onConfidence(computeEvidenceConfidence(packet, `Running Evidence Pipeline. Classified as ${plan.queryType}.`));
        }

        const memoryEnabled = this.context.getConfig<boolean>('memory.bridge.enabled', false);
        if (memoryEnabled) {
            try {
                const startTime = performance.now();
                const retriever = await this.getMemoryRetriever();
                const memories = await retriever.retrieve({
                    textQuery: question,
                    limit: 5
                });
                const endTime = performance.now();
                const retrievalDurationMs = endTime - startTime;

                let estimatedTokens = 0;
                for (const m of memories) {
                    estimatedTokens += Math.ceil(m.content.length / 4);
                    packet.items.push({
                        id: `memory_${m.id}`,
                        file: m.externalId || m.scopeKeys[0] || 'memory',
                        startLine: 1,
                        endLine: 1,
                        role: 'docs',
                        unitId: m.id,
                        symbol: '',
                        type: 'memory',
                        content: m.content,
                        retrieval_signal: 'memory_bridge',
                        semanticCategory: SemanticCategory.ARCHITECTURE,
                        score: 0.9,
                        confidence: 0.9,
                        extractionMethod: 'lancedb_memory'
                    });
                }

                this.context.logger.appendLine(`[Memory Bridge] Duration: ${retrievalDurationMs.toFixed(2)}ms`);
                this.context.logger.appendLine(`[Memory Bridge] Count: ${memories.length}`);
                this.context.logger.appendLine(`[Memory Bridge] Estimated Tokens: ${estimatedTokens}`);
            } catch (err) {
                this.context.logger.appendLine(`[Memory Bridge] Error retrieving memory: ${err}`);
            }
        }
        const synthesisStartedAt = performance.now();
        let answer = await this.synthesizer.synthesize(packet, inferenceModel, this.history.getMessages());
        telemetry.timings.synthesisMs = performance.now() - synthesisStartedAt;
        telemetry.synthesizedAnswer = answer;

        const gateStartedAt = performance.now();
        const gateResult = this.answerGate.verify(answer, packet, policyFromVerificationPlan(executionPlan.verificationPlan), this.context.workspaceRoot);
        telemetry.timings.answerGateMs = performance.now() - gateStartedAt;
        telemetry.answerGate = gateResult;
        telemetry.timings.totalMs = performance.now() - telemetryStartedAt;
        this.telemetrySink?.(telemetry);


        if (gateResult.outcome === 'block') {
            const blockedMessage = 'The evidence pipeline was unable to find exact evidence to support the answer. ' +
                'Gap: ' + gateResult.diagnostics.join(', ');
            yield blockedMessage;
            return;
        }

        answer = gateResult.finalAnswer;

        // A gate-blocked refusal is not real conversational content — only record
        // gate-approved turns, so later follow-ups don't resolve against a refusal.
        this.history.add('user', question);
        this.history.add('assistant', answer);

        const mentorStartTime = performance.now();
        const mentorContext = this.mentorOrchestrator.run(packet, gateResult);
        if (mentorContext) {
            const insights = this.mentorRenderer.render(mentorContext);
            answer += insights;
        }
        const mentorEndTime = performance.now();
        const mentorLatency = mentorEndTime - mentorStartTime;

        this.context.logger.appendLine(`Mentor Integration Latency: ${mentorLatency.toFixed(2)} ms`);

        // Post-process citations
        answer = answer.replace(/\(ev-(\d+)\)/g, (match, idStr) => {
            const item = packet.items.find(i => String(i.id) === idStr) || packet.facts.find(f => String(f.id) === idStr);
            if (!item) return match;

            const relativePath = this.context.asRelativePath(item.file);
            const display = `[${relativePath}:${item.startLine}]`;

            return `___CITE___${item.file}|${item.startLine}|${item.endLine}|${display}___CITE_END___`;
        });

        // Yield metadata
        const metadata: AnswerMetadata = {
            schema: 'repoguide.answer_metadata.v1',
            mode: 'evidence',
            question,
            file_references: packet.facts.map(f => ({
                file: f.file,
                line_start: f.startLine,
                line_end: f.endLine,
                reason: `Fact match: ${f.symbol || f.type}`,
                source: 'retrieval'
            }))
        };

        yield JSON.stringify({ __type: 'answerMetadata', metadata });
        if (this.emitEvaluationContext) {
            yield JSON.stringify({
                __type: 'shadowContext',
                context: {
                    retrievedChunkIds: packet.items.map(item => String(item.id)),
                    retrievedArtifacts: [],
                    topCitedFiles: Array.from(new Set(packet.items.slice(0, 5).map(item => item.file))),
                    citedFiles: Array.from(new Set([
                        ...packet.items.map(item => item.file),
                        ...packet.facts.map(fact => fact.file)
                    ]))
                }
            });
        }

        // Yield the full string answer as a single token for simplicity
        yield answer;
    }

    private async planAndRetrieveExplainSelection(
        filePath: string,
        selectedText: string,
        startLine: number,
        endLine: number,
        language: string,
        question?: string
    ): Promise<{ packet: EvidencePacket; executionPlan: ExecutionPlan }> {
        const executionPlan = await this.executionPlanner.plan({
            requestId: buildQueryRequestId(),
            query: question ?? '',
            client: this.client,
            workspaceRoot: this.context.workspaceRoot,
            repoguideDir: this.context.repoguideDataDir ?? this.context.workspaceRoot,
            mode: 'explain_selection',
            selection: { file: filePath, startLine, endLine, text: selectedText, language },
            conversationContext: this.conversationContextForPlanning(),
            constraints: { allowLLMPlanning: false }
        }, getProfile().inferenceModel);

        let retrievalResult: RetrievalOrchestrationResult | undefined;
        if (this.retrievalOrchestrator) {
            try {
                retrievalResult = await this.retrievalOrchestrator.execute(executionPlan);
            } catch (error) {
                this.context.logger.appendLine(`[RetrievalOrchestrator] explain_selection error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const packet = await this.packetBuilder.buildExplainSelectionPacket(
            { file: filePath, startLine, endLine, text: selectedText, language },
            executionPlan.evidencePlan,
            retrievalResult
        );
        return { packet, executionPlan };
    }

    async *explainSelection(
        filePath: string,
        selectedText: string,
        startLine: number,
        endLine: number,
        language: string,
        abortSignal?: AbortSignal,
        question?: string
    ): AsyncGenerator<string> {
        const { packet, executionPlan } = await this.planAndRetrieveExplainSelection(filePath, selectedText, startLine, endLine, language, question);
        const inferenceModel = getProfile().inferenceModel;

        let answer = await this.synthesizer.synthesizeExplainSelection(packet, inferenceModel, this.history.getMessages());
        const gateResult = this.answerGate.verify(answer, packet, policyFromVerificationPlan(executionPlan.verificationPlan), this.context.workspaceRoot);

        if (gateResult.outcome === 'block') {
            yield 'The evidence pipeline was unable to find exact evidence to support this explanation. Gap: ' + gateResult.diagnostics.join(', ');
            return;
        }

        answer = gateResult.finalAnswer;
        this.history.add('user', question ?? `Explain selected code in ${filePath}`);
        this.history.add('assistant', answer);
        yield answer;
    }

    async explainSelectionResult(
        filePath: string,
        selectedText: string,
        startLine: number,
        endLine: number,
        language: string,
        abortSignal?: AbortSignal,
        question?: string
    ): Promise<ExplainSelectionBackendResult> {
        const { packet, executionPlan } = await this.planAndRetrieveExplainSelection(filePath, selectedText, startLine, endLine, language, question);
        const inferenceModel = getProfile().inferenceModel;

        let answer = await this.synthesizer.synthesizeExplainSelection(packet, inferenceModel, this.history.getMessages());
        const gateResult = this.answerGate.verify(answer, packet, policyFromVerificationPlan(executionPlan.verificationPlan), this.context.workspaceRoot);
        answer = gateResult.outcome === 'block'
            ? 'The evidence pipeline was unable to find exact evidence to support this explanation. Gap: ' + gateResult.diagnostics.join(', ')
            : gateResult.finalAnswer;

        if (gateResult.outcome !== 'block') {
            this.history.add('user', question ?? `Explain selected code in ${filePath}`);
            this.history.add('assistant', answer);
        }

        const relatedFiles = packet.items
            .filter(item => item.file !== filePath)
            .slice(0, 5)
            .map(item => ({
                file: item.file,
                line_start: item.startLine,
                line_end: item.endLine,
                reason: 'Related context retrieved for the selected-code explanation.',
                source: 'retrieval' as const
            }));

        return {
            answer,
            selected_file: filePath,
            selected_line_start: startLine,
            selected_line_end: endLine,
            related_files: relatedFiles,
            source_metadata: {
                schema: 'repoguide.answer_metadata.v1',
                mode: 'evidence',
                question: question ?? `Explain selected code in ${filePath}`,
                file_references: relatedFiles
            },
            uncertainty_notes: gateResult.required_gaps
        };
    }

    /** Streams a whole-repository documentation report, routed through the canonical pipeline. */
    async *runDocumentationReport(abortSignal?: AbortSignal): AsyncGenerator<string> {
        const executionPlan = await this.executionPlanner.plan({
            requestId: buildQueryRequestId(),
            query: '',
            client: this.client,
            workspaceRoot: this.context.workspaceRoot,
            repoguideDir: this.context.repoguideDataDir ?? this.context.workspaceRoot,
            mode: 'documentation',
            constraints: { allowLLMPlanning: false }
        }, getProfile().inferenceModel);

        let retrievalResult: RetrievalOrchestrationResult | undefined;
        if (this.retrievalOrchestrator) {
            try {
                retrievalResult = await this.retrievalOrchestrator.execute(executionPlan);
            } catch (error) {
                this.context.logger.appendLine(`[RetrievalOrchestrator] documentation error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const packet: EvidencePacket = {
            query: executionPlan.query,
            plan: executionPlan.evidencePlan,
            items: retrievalResult?.items ?? [],
            facts: [],
            coverage: [],
            gaps: [],
            diagnostics: ['Documentation packet built successfully'],
            coverageScore: (retrievalResult?.items.length ?? 0) > 0 ? 1 : 0,
            matchedEvidenceTypes: []
        };

        const inferenceModel = getProfile().inferenceModel;
        let answer = '';
        for await (const chunk of this.synthesizer.streamSynthesizeDocumentation(packet, inferenceModel, abortSignal)) {
            answer += chunk;
            yield chunk;
        }

        const gateResult = this.answerGate.verify(answer, packet, policyFromVerificationPlan(executionPlan.verificationPlan), this.context.workspaceRoot);
        if (gateResult.outcome === 'block') {
            yield '\n\n[RepoGuide: documentation report could not be fully validated against retrieved evidence. ' + gateResult.diagnostics.join(', ') + ']';
        }
    }

/** Returns raw evidence for a query with no answer synthesis or gate validation — the
     * frozen contract's raw_evidence mode is defined as evidence-only, by design.
     * `forceProviderIds`/`targetSymbols` let callers with a known-narrow need (e.g. the
     * MCP get_dependents/get_facts tools) route to specific providers regardless of how
     * the free-text classifier would otherwise categorize the query. */
    async retrieveRawEvidence(
        query: string,
        options: { seedFiles?: string[]; targetSymbols?: string[]; forceProviderIds?: string[] } = {}
    ): Promise<EvidenceItem[]> {
        const executionPlan = await this.executionPlanner.plan({
            requestId: buildQueryRequestId(),
            query,
            client: this.client,
            workspaceRoot: this.context.workspaceRoot,
            repoguideDir: this.context.repoguideDataDir ?? this.context.workspaceRoot,
            mode: 'raw_evidence',
            constraints: { allowLLMPlanning: true, maxEvidenceItems: 50 }
        }, getProfile().inferenceModel);
        if (options.seedFiles && options.seedFiles.length > 0) {
            executionPlan.retrievalPlan.targetFiles = Array.from(new Set([...executionPlan.retrievalPlan.targetFiles, ...options.seedFiles]));
        }
        if (options.targetSymbols && options.targetSymbols.length > 0) {
            executionPlan.retrievalPlan.targetSymbols = Array.from(new Set([...executionPlan.retrievalPlan.targetSymbols, ...options.targetSymbols]));
        }
        if (options.forceProviderIds && options.forceProviderIds.length > 0) {
            executionPlan.retrievalPlan.providerIds = options.forceProviderIds;
        }

        if (!this.retrievalOrchestrator) {
            return [];
        }
        const retrievalResult = await this.retrievalOrchestrator.execute(executionPlan);
        return retrievalResult.items;
    }
}
function buildQueryRequestId(): string {
    return `query_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
