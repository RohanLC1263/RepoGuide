import { RepositoryContext } from '../context/repositoryContext';

import { ConfidenceResult } from './confidenceScorer';
import { ExplainSelectionBackendResult, AnswerMetadata } from './answerMetadata';
import { ExecutionPlanner, PlanningRequest, ExecutionPlan } from './executionPlanner';
import { RetrievalOrchestrator, RetrievalOrchestrationResult, interleaveAndCapEvidence } from './retrievalOrchestrator';
import { EvidencePacketBuilder, EvidencePacketBuilderStores } from './evidencePacketBuilder';
import { EvidenceAnswerSynthesizer } from './evidenceAnswerSynthesizer';
import { AnswerGate, AnswerGatePolicy, FileUsageGraphLookup } from './answerGate';
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
import { ConversationHistory, Message } from './conversationHistory';
import { GateResult } from './answerGate';
import { SubAnswerMerger, SubTaskResult } from './subAnswerMerger';
import { retrySynthesisWithGateFeedback } from './subTaskRetry';
import { buildEntry, exportQueryEvidence } from './queryEvidenceExporter';

/**
 * Decomposition trigger gates. Decomposed generation costs ~2.5-3x single-shot
 * latency (measured on the hypothesis test), so single-shot is always the
 * default and BOTH independent signals must agree before decomposing:
 * the deterministic complexity scorer must rate the question well above the
 * LLM-planner routing threshold (2), AND the planner itself must have judged
 * the question multi-facet enough to emit 2+ validated sub-questions -- and
 * even then only for query types where a structured walkthrough is the
 * expected answer shape, never for single-fact lookups.
 */
/**
 * Per-provider retrieval cap AND the final aggregate cap retrieveRawEvidence()
 * truncates to after round-robin interleaving each provider's results (see
 * interleaveAndCapEvidence in retrievalOrchestrator.ts) -- a single source of
 * truth so the two can't drift apart. Without the aggregate step, RetrievalOrchestrator.execute()
 * only dedupes by id; it was possible for e.g. 5 providers to each return up
 * to this many items, unioning into far more than this number of results
 * (confirmed live: 137 items from retrieve_raw_evidence, 100 "facts" from
 * get_facts that were really facts + unfiltered flow_context items -- see
 * the FlowContextProvider.canHandle fix above).
 */
export const RAW_EVIDENCE_AGGREGATE_CAP = 50;

export const DECOMPOSITION_MIN_COMPLEXITY_SCORE = 5;
export const DECOMPOSABLE_QUERY_TYPES = new Set([
    'architecture_analysis',
    'behavior_explanation',
    'impact_analysis',
    'onboarding_analysis',
    'change_impact_prediction'
]);

/** Pure trigger predicate (config-independent), exported for direct testing and
 * for the trigger-rate validation tooling. */
export function decompositionEligible(
    complexityScore: number,
    queryType: string,
    subQuestions: string[] | undefined
): boolean {
    if (!subQuestions || subQuestions.length < 2) {
        return false;
    }
    if (complexityScore < DECOMPOSITION_MIN_COMPLEXITY_SCORE) {
        return false;
    }
    return DECOMPOSABLE_QUERY_TYPES.has(queryType);
}

/**
 * Pure derivation of the gateStatus token's {outcome, unsupportedCount} fields
 * from a GateResult, exported for direct testing (QueryDispatcher itself is too
 * dependency-heavy to construct in a unit test). Single source of truth for
 * emitFinalAnswer's gate-status yield, so the logic is defined once, not
 * duplicated between the yield site and its tests.
 *
 * `decompositionContext`, when present, corrects two cases where the raw
 * GateResult would otherwise read misleadingly for a decomposed answer:
 * SubAnswerMerger falling back to the sectioned display (its own
 * finalGate.outcome is 'block' even though what's delivered is real,
 * individually-verified content, never a raw refusal) and a merge that
 * disclosed one or more "Not covered" facets. Both are surfaced as 'revise'
 * (delivered with a caveat) -- never 'block' for content that was, in fact,
 * delivered to the user.
 */
export function deriveGateStatusOutcome(
    gateResult: Pick<GateResult, 'outcome' | 'unsupported_claims'>,
    decompositionContext?: { blockedCount: number; usedFallback: boolean }
): { outcome: GateResult['outcome']; unsupportedCount: number } {
    let outcome = gateResult.outcome;
    if (decompositionContext && (decompositionContext.blockedCount > 0 || decompositionContext.usedFallback)) {
        outcome = 'revise';
    }
    return {
        outcome,
        unsupportedCount: gateResult.unsupported_claims.length + (decompositionContext?.blockedCount ?? 0)
    };
}

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
    private readonly graphStore?: FileUsageGraphLookup;

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
        this.graphStore = stores.programGraphStore;
        this.packetBuilder = new EvidencePacketBuilder(stores, this.context.workspaceRoot);
        this.executionPlanner = options.executionPlanner ?? new ExecutionPlanner(this.context, stores.unitStore);
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

        if (this.shouldDecompose(executionPlan)) {
            yield* this.runDecomposedQuery(question, executionPlan, telemetry, telemetryStartedAt, inferenceModel, abortSignal, onConfidence);
            return;
        }

        const { packet, gateResult } = await this.generateForPlan(question, executionPlan, this.history.getMessages(), telemetry, onConfidence);
        telemetry.timings.totalMs = performance.now() - telemetryStartedAt;
        this.telemetrySink?.(telemetry);
        let answer = gateResult.finalAnswer;


        if (gateResult.outcome === 'block') {
            yield JSON.stringify({
                __type: 'gateStatus',
                status: { ...deriveGateStatusOutcome(gateResult), mode: packet.plan.confidence_mode }
            });
            const blockedMessage = 'The evidence pipeline was unable to find exact evidence to support the answer. ' +
                'Gap: ' + gateResult.diagnostics.join(', ');
            yield blockedMessage;
            return;
        }

        yield* this.emitFinalAnswer(question, gateResult.finalAnswer, packet, gateResult);
    }

    /**
     * Shared tail for every approved answer (single-shot and decomposed):
     * history recording, mentor insights, citation post-processing, metadata
     * emission, and the final answer yield.
     *
     * `decompositionContext`, when present, means this call is the decomposed
     * merge path (see runDecomposedQuery). It corrects the gateStatus token's
     * outcome for two cases where the raw underlying GateResult would otherwise
     * read misleadingly: SubAnswerMerger falling back to the sectioned display
     * (its own finalGate.outcome is 'block' even though what's actually delivered
     * here is real, individually-verified content, never a raw refusal) and a
     * merge that disclosed one or more "Not covered" facets. Both are surfaced
     * as 'revise' (delivered with a caveat), matching what the user actually
     * receives -- never 'block' for content that was, in fact, delivered.
     */
    private async *emitFinalAnswer(
        question: string,
        approvedAnswer: string,
        packet: EvidencePacket,
        gateResult: GateResult,
        decompositionContext?: { blockedCount: number; usedFallback: boolean }
    ): AsyncGenerator<string> {
        let answer = approvedAnswer;

        // Trust-visibility (UX Part 3 design, item B): a gateStatus token so the UI
        // can show whether/how this answer was verified, and an explicit "Unverified"
        // chip when this token never arrives at all (e.g. the legacy explainSelection
        // path, which does not call emitFinalAnswer) -- that absence is itself an
        // honest signal, not something to hide. See webviews/sidebar/sidebar.js's
        // gateStatus handler and gateStatusRendering.js's deriveGateChipInfo for the
        // rendering side of this contract.
        const correctedGateStatus = deriveGateStatusOutcome(gateResult, decompositionContext);
        yield JSON.stringify({
            __type: 'gateStatus',
            status: { ...correctedGateStatus, mode: packet.plan.confidence_mode }
        });

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

        // Query-evidence export (see queryEvidenceExporter.ts): a connected MCP
        // session can pull this instead of rediscovering the same context.
        // 'internal' is the eval-harness client (queryPipelineHarness.ts) --
        // deliberately excluded so evaluation runs don't pollute a file meant to
        // reflect real chat/MCP sessions. Exports the citation markers resolved
        // to their plain display text (the same "___CITE___file|start|end|
        // display___CITE_END___" -> display strip used by mcpServer.ts's
        // ask_repoguide), not the raw markers a real client parses into links,
        // and not the pre-citation answer -- this is genuinely what the user saw.
        // Never allowed to affect answer delivery: any failure is caught and
        // logged, not surfaced to the generator's consumer.
        if (this.client !== 'internal') {
            try {
                const exportAnswer = answer.replace(
                    /___CITE___(.*?)\|(.*?)\|(.*?)\|(.*?)___CITE_END___/g,
                    (_match, _file, _startLine, _endLine, display) => display
                );
                const entry = buildEntry(
                    question,
                    exportAnswer,
                    packet,
                    { ...gateResult, outcome: correctedGateStatus.outcome },
                    this.client,
                    decompositionContext !== undefined
                );
                await exportQueryEvidence(this.context.repoguideDataDir ?? this.context.workspaceRoot, entry);
            } catch (e) {
                this.context.logger.appendLine(`[Warn] Query evidence export failed: ${e}`);
            }
        }

        // Yield the full string answer as a single token for simplicity
        yield answer;
    }

    /**
     * Decomposition trigger: single-shot is the default; decomposing requires the
     * deterministic complexity score AND the planner's own multi-facet judgment
     * to independently agree, and only for query types whose expected answer
     * shape is a structured walkthrough. Kill-switch: repoguide.decomposition.enabled.
     */
    private shouldDecompose(executionPlan: ExecutionPlan): boolean {
        if (!this.context.getConfig<boolean>('decomposition.enabled', true)) {
            return false;
        }
        return decompositionEligible(
            executionPlan.complexity.score,
            executionPlan.evidencePlan.queryType,
            executionPlan.evidencePlan.subQuestions
        );
    }

    /**
     * The single-question generation core shared by the single-shot path and each
     * decomposed sub-question: retrieval -> packet -> memory bridge -> synthesis
     * -> AnswerGate. Selection/budgeting all happens downstream in
     * buildEvidenceMessages(); this method owns none of it.
     */
    private async generateForPlan(
        question: string,
        executionPlan: ExecutionPlan,
        history: Message[],
        telemetry?: EvidenceQueryTelemetrySnapshot,
        onConfidence?: (confidence: ConfidenceResult) => Promise<void> | void
    ): Promise<{ packet: EvidencePacket; gateResult: GateResult; answer: string }> {
        const plan = executionPlan.evidencePlan;
        const inferenceModel = getProfile().inferenceModel;

        let retrievalResult: RetrievalOrchestrationResult | undefined;
        if (this.retrievalOrchestrator) {
            try {
                const retrievalStartedAt = performance.now();
                retrievalResult = await this.retrievalOrchestrator.execute(executionPlan);
                if (telemetry) {
                    telemetry.timings.retrievalMs = performance.now() - retrievalStartedAt;
                    telemetry.retrievalResult = retrievalResult;
                }
                this.context.logger.appendLine(`[RetrievalOrchestrator] Providers invoked: ${retrievalResult.metadata.providersInvoked.join(', ') || 'none'}`);
            } catch (error) {
                this.context.logger.appendLine(`[RetrievalOrchestrator] Error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const packetStartedAt = performance.now();
        const packet = await this.packetBuilder.buildPacket(question, plan, retrievalResult);
        if (telemetry) {
            telemetry.timings.packetMs = performance.now() - packetStartedAt;
            telemetry.packet = packet;
        }

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
        // confidence badge; see packet.coverageScore (computeEvidenceConfidence)
        // for that. Previously both were called "coverage", which made a
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
        const answer = await this.synthesizer.synthesize(packet, inferenceModel, history);
        if (telemetry) {
            telemetry.timings.synthesisMs = performance.now() - synthesisStartedAt;
            telemetry.synthesizedAnswer = answer;
        }

        const gateStartedAt = performance.now();
        const gateResult = this.answerGate.verify(answer, packet, policyFromVerificationPlan(executionPlan.verificationPlan), this.context.workspaceRoot, this.graphStore);
        if (telemetry) {
            telemetry.timings.answerGateMs = performance.now() - gateStartedAt;
            telemetry.answerGate = gateResult;
        }
        return { packet, gateResult, answer };
    }

    /**
     * Decomposed generation: each sub-question runs the full single-question core
     * (its own retrieval, packet, synthesis, and MANDATORY AnswerGate pass), then
     * the gate-approved sub-answers are merged and the merged whole is verified
     * again by SubAnswerMerger against the union of the sub-packets. Blocked
     * sub-answers become explicit "not covered" disclosures, never silent holes.
     * Progress surfaces through the existing typed side-band yields.
     */
    private async *runDecomposedQuery(
        masterQuestion: string,
        masterPlan: ExecutionPlan,
        telemetry: EvidenceQueryTelemetrySnapshot,
        telemetryStartedAt: number,
        inferenceModel: string,
        abortSignal?: AbortSignal,
        onConfidence?: (confidence: ConfidenceResult) => Promise<void> | void
    ): AsyncGenerator<string> {
        const subQuestions = masterPlan.evidencePlan.subQuestions!;
        const total = subQuestions.length;
        this.context.logger.info(`[Decomposition] Running ${total} sub-questions (complexity ${masterPlan.complexity.score}, type ${masterPlan.evidencePlan.queryType}).`);
        yield JSON.stringify({ __type: 'progressUpdate', progress: { stage: 'decomposed', total, subQuestions } });

        const throwIfAborted = () => {
            if (abortSignal?.aborted) {
                const error = new Error('The operation was aborted');
                error.name = 'AbortError';
                throw error;
            }
        };

        const results: SubTaskResult[] = [];
        const subOutcomes: Array<{ question: string; gateOutcome: GateResult['outcome']; elapsedMs: number }> = [];
        for (let i = 0; i < total; i++) {
            throwIfAborted();
            const subQuestion = subQuestions[i];
            yield JSON.stringify({ __type: 'progressUpdate', progress: { stage: 'sub_start', index: i + 1, total, question: subQuestion } });
            const startedAt = performance.now();
            // Sub-questions are already focused; the regex planner suffices and
            // avoids N additional LLM planning calls.
            const subPlan = await this.executionPlanner.plan({
                requestId: buildQueryRequestId(),
                query: subQuestion,
                client: this.client,
                workspaceRoot: this.context.workspaceRoot,
                repoguideDir: this.context.repoguideDataDir ?? this.context.workspaceRoot,
                mode: 'answer',
                constraints: { allowLLMPlanning: false }
            }, inferenceModel);
            // Sub-generations see no conversation history: each must stand alone,
            // and only the final merged answer becomes a conversation turn.
            const generated = await this.generateForPlan(subQuestion, subPlan, []);
            const packet = generated.packet;
            let gateResult = generated.gateResult;

            // One retry per blocked sub-task, with the gate's rejection reasons in
            // the prompt. Retry semantics chosen from the measured mechanism
            // (subTaskFlakinessProbe.ts): retrieval on this path is bit-stable and
            // generation near-deterministic on an identical prompt, so blind
            // re-retrieve/re-sample reproduces the same block -- only a CHANGED
            // prompt (same packet + concrete feedback) can flip a persistent
            // failure pattern like fabricated illustrative fences.
            if (gateResult.outcome === 'block') {
                throwIfAborted();
                this.context.logger.info(`[Decomposition] Sub ${i + 1}/${total} blocked (${gateResult.diagnostics[0] ?? 'no diagnostic'}); retrying once with gate feedback.`);
                const retry = await retrySynthesisWithGateFeedback(
                    packet,
                    gateResult,
                    policyFromVerificationPlan(subPlan.verificationPlan),
                    messages => this.synthesizer.synthesizeFromMessages(messages, inferenceModel, abortSignal),
                    this.answerGate,
                    this.context.workspaceRoot
                );
                if (retry.recovered) {
                    gateResult = retry.gate;
                }
            }

            const elapsedMs = performance.now() - startedAt;
            results.push({ question: subQuestion, answer: gateResult.finalAnswer, packet, gate: gateResult });
            subOutcomes.push({ question: subQuestion, gateOutcome: gateResult.outcome, elapsedMs });
            this.context.logger.info(`[Decomposition] Sub ${i + 1}/${total} gate=${gateResult.outcome} in ${Math.round(elapsedMs)}ms`);
            yield JSON.stringify({ __type: 'progressUpdate', progress: { stage: 'sub_done', index: i + 1, total, outcome: gateResult.outcome } });
        }

        const passed = results.filter(r => r.gate.outcome !== 'block');
        const blocked = results.filter(r => r.gate.outcome === 'block');

        if (passed.length === 0) {
            telemetry.decomposition = { subQuestions, subOutcomes, mergeUsedFallback: false };
            telemetry.timings.totalMs = performance.now() - telemetryStartedAt;
            this.telemetrySink?.(telemetry);
            const aggregateUnsupported = blocked.reduce((sum, b) => sum + b.gate.unsupported_claims.length, 0);
            yield JSON.stringify({
                __type: 'gateStatus',
                status: { outcome: 'block', unsupportedCount: aggregateUnsupported, mode: masterPlan.evidencePlan.confidence_mode }
            });
            yield 'The evidence pipeline was unable to find exact evidence to support any part of the answer. ' +
                'Gaps: ' + blocked.map(b => `[${b.question}] ${b.gate.diagnostics.join(', ')}`).join(' | ');
            return;
        }

        throwIfAborted();
        yield JSON.stringify({ __type: 'progressUpdate', progress: { stage: 'merging', parts: passed.length, blocked: blocked.length } });
        const merger = new SubAnswerMerger(
            messages => this.synthesizer.synthesizeFromMessages(messages, inferenceModel, abortSignal),
            this.answerGate
        );
        const outcome = await merger.merge(
            masterQuestion,
            masterPlan.evidencePlan,
            passed,
            blocked,
            policyFromVerificationPlan(masterPlan.verificationPlan),
            this.context.workspaceRoot
        );
        for (const diagnostic of outcome.diagnostics) {
            this.context.logger.info(`[Decomposition] ${diagnostic}`);
        }

        telemetry.decomposition = {
            subQuestions,
            subOutcomes,
            mergeUsedFallback: outcome.usedFallback,
            finalGateOutcome: outcome.finalGate?.outcome
        };
        telemetry.answerGate = outcome.finalGate ?? passed[0].gate;
        telemetry.synthesizedAnswer = outcome.answer;
        telemetry.timings.totalMs = performance.now() - telemetryStartedAt;
        this.telemetrySink?.(telemetry);

        if (onConfidence) {
            await onConfidence(computeEvidenceConfidence(outcome.unionPacket, `Decomposed into ${total} parts (${passed.length} verified).`));
        }

        yield* this.emitFinalAnswer(masterQuestion, outcome.answer, outcome.unionPacket, outcome.finalGate ?? passed[0].gate, {
            blockedCount: blocked.length,
            usedFallback: outcome.usedFallback
        });
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
        const gateResult = this.answerGate.verify(answer, packet, policyFromVerificationPlan(executionPlan.verificationPlan), this.context.workspaceRoot, this.graphStore);

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
        const gateResult = this.answerGate.verify(answer, packet, policyFromVerificationPlan(executionPlan.verificationPlan), this.context.workspaceRoot, this.graphStore);
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

        const gateResult = this.answerGate.verify(answer, packet, policyFromVerificationPlan(executionPlan.verificationPlan), this.context.workspaceRoot, this.graphStore);
        if (gateResult.outcome === 'block') {
            yield '\n\n[RepoGuide: documentation report could not be fully validated against retrieved evidence. ' + gateResult.diagnostics.join(', ') + ']';
        }
    }

/** Returns raw evidence for a query with no answer synthesis or gate validation — the
     * frozen contract's raw_evidence mode is defined as evidence-only, by design.
     * `forceProviderIds`/`targetSymbols` let callers with a known-narrow need (e.g. the
     * MCP get_dependents/get_facts tools) route to specific providers regardless of how
     * the free-text classifier would otherwise categorize the query.
     *
     * RetrievalOrchestrator.execute() itself only dedupes by id across providers, with
     * no aggregate cap — each provider independently honors maxEvidenceItems, so N
     * providers can union into up to N * RAW_EVIDENCE_AGGREGATE_CAP items (confirmed
     * live: 137 items from a single retrieve_raw_evidence call). Since this method's
     * only production callers are the MCP tools (retrieve_raw_evidence/get_dependents/
     * get_facts), the round-robin interleave-and-cap is applied here, not inside
     * execute() itself, which chat/investigationEngine/planAnalyzer/doc-report also
     * call for answer-synthesis packet building and must not be affected. */

    /**
     * Runs the SAME pipeline the chat/answer path runs -- ExecutionPlanner -> Retrieval-
     * Orchestrator -> EvidencePacketBuilder -- and returns the fully-built, ranked
     * EvidencePacket, but STOPS BEFORE answer synthesis. This is the intermediate object
     * synthesize() would otherwise consume; exposing it lets an MCP caller (e.g. Claude
     * Desktop) do the final reasoning itself instead of receiving a local-model narrative
     * (which carries the disclosed branch-logic ceiling, LIMITATIONS.md §1.1). This path is
     * FULLY LOCAL-MODEL-FREE: no answer synthesis, no AnswerGate, and -- deliberately --
     * deterministic (regex) query planning rather than LLM planning. Measured: LLM planning
     * dominated latency at ~200s+ per call in the e2e, unacceptable for an interactive MCP
     * tool, and its query decomposition adds little when the CALLER does the reasoning. So
     * gather_evidence trades slightly less tailored provider routing for being fast and
     * having zero local-model reasoning of any kind -- which matches the tool's whole point.
     */
    async gatherEvidencePacket(question: string): Promise<EvidencePacket> {
        const inferenceModel = getProfile().inferenceModel;
        const t0 = performance.now();
        const executionPlan = await this.executionPlanner.plan({
            requestId: buildQueryRequestId(),
            query: question,
            client: this.client,
            workspaceRoot: this.context.workspaceRoot,
            repoguideDir: this.context.repoguideDataDir ?? this.context.workspaceRoot,
            mode: 'answer',
            conversationContext: this.conversationContextForPlanning(),
            constraints: { allowLLMPlanning: false }
        }, inferenceModel);
        const planMs = performance.now() - t0;

        // gather_evidence fast path: use the heuristic intent classifier in hybrid
        // retrieval rather than the ~3.6s CPU-bound local-model classify call. This
        // tool hands raw ranked evidence to the *calling* Claude model to reason over
        // (no local synthesis), so it tolerates rougher strategy-weight selection in
        // exchange for cutting the single largest latency component. ask_repoguide's
        // own path is unaffected (it never sets this flag). TRADEOFF: heuristic
        // (pattern-based) intent/concept extraction vs model-based -- flagged for review.
        executionPlan.retrievalPlan.heuristicClassificationOnly = true;

        const retrievalStartedAt = performance.now();
        let retrievalResult: RetrievalOrchestrationResult | undefined;
        if (this.retrievalOrchestrator) {
            retrievalResult = await this.retrievalOrchestrator.execute(executionPlan);
        }
        const retrievalMs = performance.now() - retrievalStartedAt;

        const packetStartedAt = performance.now();
        const packet = await this.packetBuilder.buildPacket(question, executionPlan.evidencePlan, retrievalResult);
        const packetMs = performance.now() - packetStartedAt;

        const perProvider = (retrievalResult?.metadata.providerTimings ?? [])
            .slice().sort((a, b) => b.ms - a.ms)
            .map(t => `${t.id}=${t.ms.toFixed(0)}ms`).join(', ');
        this.context.logger.appendLine(
            `[gather_evidence timing] plan=${planMs.toFixed(0)}ms retrieval=${retrievalMs.toFixed(0)}ms packetBuild=${packetMs.toFixed(0)}ms ` +
            `| per-provider: ${perProvider || 'none'}`
        );
        return packet;
    }

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
            constraints: { allowLLMPlanning: true, maxEvidenceItems: RAW_EVIDENCE_AGGREGATE_CAP }
        }, getProfile().inferenceModel);
        if (options.seedFiles && options.seedFiles.length > 0) {
            executionPlan.retrievalPlan.targetFiles = Array.from(new Set([...executionPlan.retrievalPlan.targetFiles, ...options.seedFiles]));
        }
        if (options.targetSymbols && options.targetSymbols.length > 0) {
            executionPlan.retrievalPlan.targetSymbols = Array.from(new Set([...executionPlan.retrievalPlan.targetSymbols, ...options.targetSymbols]));
        }
        if (options.forceProviderIds && options.forceProviderIds.length > 0) {
            executionPlan.retrievalPlan.providerIds = options.forceProviderIds;
            // Mark these as force-selected so a provider whose canHandle self-gates
            // on query category (program_graph) doesn't decline a request the caller
            // deliberately routed to it -- e.g. get_dependents forces program_graph
            // for a bare symbol that classifies as repository_exploration.
            executionPlan.retrievalPlan.forcedProviderIds = options.forceProviderIds;
        }

        if (!this.retrievalOrchestrator) {
            return [];
        }
        const retrievalResult = await this.retrievalOrchestrator.execute(executionPlan);
        return interleaveAndCapEvidence(retrievalResult.providerResults, RAW_EVIDENCE_AGGREGATE_CAP);
    }
}
function buildQueryRequestId(): string {
    return `query_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
