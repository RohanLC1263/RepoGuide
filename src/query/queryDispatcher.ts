import { RepositoryContext } from '../context/repositoryContext';

import * as path from 'path';
import { ChatPipeline, HybridQueryPipeline } from './hybridQueryPipeline';
import { ConfidenceResult } from './confidenceScorer';
import { ExplainSelectionBackendResult, AnswerMetadata } from './answerMetadata';
import { ExecutionPlanner, PlanningRequest } from './executionPlanner';
import { RetrievalOrchestrator, RetrievalOrchestrationResult } from './retrievalOrchestrator';
import { EvidencePacketBuilder, EvidencePacketBuilderStores } from './evidencePacketBuilder';
import { EvidenceAnswerSynthesizer } from './evidenceAnswerSynthesizer';
import { AnswerGate } from './answerGate';
import { getProfile } from '../config/performanceConfig';
import { MentorOrchestrator } from '../mentor/mentorOrchestrator';
import { MentorInsightRenderer } from '../mentor/mentorInsightRenderer';
import { MemoryContext } from '../memory/memoryTypes';
import { MemoryStoreFactory } from '../memory/memoryStoreFactory';
import { LanceDbMemoryRetriever } from '../memory/lanceDbMemoryRetriever';
import { InMemoryValueRepository } from '../memory/lifecycle/inMemoryValueRepository';
import { LifecycleAwareRetriever } from '../memory/lifecycle/lifecycleAwareRetriever';
import { AttributionPayload } from './attributionTypes';
import { AttributionFormatter } from './attributionFormatter';
import { SemanticCategory } from './evidencePacket';
import { EvidenceQueryTelemetrySink, EvidenceQueryTelemetrySnapshot } from './evidenceQueryTelemetry';

export interface QueryDispatcherOptions {
    executionPlanner?: ExecutionPlanner;
    retrievalOrchestrator?: RetrievalOrchestrator;
    client?: PlanningRequest['client'];
    telemetrySink?: EvidenceQueryTelemetrySink;
    emitEvaluationContext?: boolean;
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
        private legacyPipeline: ChatPipeline,
        stores: EvidencePacketBuilderStores,
        context?: RepositoryContext,
        options: QueryDispatcherOptions = {}
    ) {
        if (!context) { throw new Error('RepositoryContext must be provided'); }
        this.context = context;
        this.packetBuilder = new EvidencePacketBuilder(stores);
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

    async *query(
        question: string,
        abortSignal?: AbortSignal,
        onConfidence?: (confidence: ConfidenceResult) => Promise<void> | void
    ): AsyncGenerator<string> {
        const architecture = this.context.getConfig<string>('queryArchitecture', 'evidence');

        if (architecture === 'evidence') {
            yield* this.runEvidenceQuery(question, abortSignal, onConfidence);
        } else {
            yield* this.legacyPipeline.query(question, abortSignal, onConfidence);
        }
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
        
        // Let UI know we are using the evidence pipeline
        if (onConfidence) {
            await onConfidence({
                level: 'high',
                topFiles: [],
                topFilePaths: [],
                chunkCount: 0,
                avgScore: 0,
                explanation: `Running Evidence Pipeline. Classified as ${plan.queryType}.`
            });
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
        const coverageScore = plan.factTypes.length > 0 ? (matches / plan.factTypes.length).toFixed(2) : '0.00';

        this.context.logger.appendLine(`Query type: ${plan.queryType}`);
        this.context.logger.appendLine(`Symbol hints: ${plan.symbolHints.join(', ')}`);
        this.context.logger.appendLine(`Facts retrieved: ${factsCount} (${factTypes})`);
        this.context.logger.appendLine(`Units retrieved: ${unitsCount}`);
        this.context.logger.appendLine(`Coverage: ${coverageScore}`);
        
        if (onConfidence) {
            await onConfidence({
                level: 'high',
                topFiles: [],
                topFilePaths: [],
                chunkCount: packet.items.length + packet.facts.length,
                avgScore: 0,
                explanation: `Running Evidence Pipeline. Classified as ${plan.queryType}.`
            });
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
        let answer = await this.synthesizer.synthesize(packet, inferenceModel);
        telemetry.timings.synthesisMs = performance.now() - synthesisStartedAt;
        telemetry.synthesizedAnswer = answer;
        
        const gateStartedAt = performance.now();
        const gateResult = this.answerGate.verify(answer, packet);
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

        // Attribution formatter logic removed, memories are now cited via EvidencePacket

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

    async *explainSelection(
        filePath: string,
        selectedText: string,
        startLine: number,
        endLine: number,
        language: string,
        abortSignal?: AbortSignal,
        question?: string
    ): AsyncGenerator<string> {
        // Evidence pipeline does not explicitly handle code selection yet, delegate to legacy
        yield* this.legacyPipeline.explainSelection(filePath, selectedText, startLine, endLine, language, abortSignal, question);
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
        if (this.legacyPipeline.explainSelectionResult) {
            return this.legacyPipeline.explainSelectionResult(filePath, selectedText, startLine, endLine, language, abortSignal, question);
        }
        throw new Error('explainSelectionResult is not implemented by legacyPipeline.');
    }
}
function buildQueryRequestId(): string {
    return `query_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}