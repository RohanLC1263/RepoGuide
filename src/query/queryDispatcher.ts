import { RepositoryContext } from '../context/repositoryContext';

import { ConfidenceResult } from './confidenceScorer';
import { AnswerMetadata } from './answerMetadata';
import { ExecutionPlanner, PlanningRequest, ExecutionPlan } from './executionPlanner';
import { RetrievalOrchestrator, RetrievalOrchestrationResult, interleaveAndCapEvidence } from './retrievalOrchestrator';
import { EvidencePacketBuilder, EvidencePacketBuilderStores } from './evidencePacketBuilder';
import { EvidenceAnswerSynthesizer } from './evidenceAnswerSynthesizer';
import { renderWithheldAnswer } from './withheldAnswer';
import { AnswerGate, AnswerGatePolicy, FileUsageGraphLookup, NumericFact } from './answerGate';
import { extractSymbolsNearNumbers } from './numericClaimSymbols';
import { FactStore } from '../store/factStore';
import { resolvePresentTechnologies, TechnologyPresenceLookup } from './technologyClaimVerifier';
import { detectAbstention, findRetrievalGap } from './abstentionVerifier';
import { findOmittedFiles } from './multiHopCoverageVerifier';
import { CrossEncoderReranker, resolveRerankerBackend } from '../retrieval/crossEncoderReranker';
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
import { stripCitationMarkersToDisplayText } from './answerStreamTokens';

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
/**
 * Confidence badge derived from what the gate actually VERIFIED about the finished
 * answer, not merely from how much evidence was retrieved.
 *
 * `computeEvidenceConfidence` below scores retrieval volume/relevance
 * (`coverageScore`, avg item score, item count). That is a fine progress signal
 * while the pipeline runs, but it is not a correctness signal -- `coverageScore` was
 * already shown to be non-diagnostic of answer quality (9/12 real CraftConnect
 * answers scored 0 regardless of whether they were right), and in practice the same
 * "Low" badge covered both a fully-correct answer and one containing fabricated
 * dependents. A badge a developer reads as trust must track verification:
 *
 *   - gate blocked            -> low   (nothing was delivered as verified)
 *   - any unsupported claim   -> medium at best (something failed verification)
 *   - clean pass              -> retrieval volume decides high vs medium
 *
 * Emitted after the gate runs, superseding the in-flight estimate.
 */
export function confidenceFromGate(
    packet: EvidencePacket,
    gateResult: Pick<GateResult, 'outcome' | 'unsupported_claims'>,
    explanation: string
): ConfidenceResult {
    const base = computeEvidenceConfidence(packet, explanation);
    const evidenceCount = packet.items.length + packet.facts.length;

    let level: ConfidenceResult['level'];
    if (gateResult.outcome === 'block') {
        level = 'low';
    } else if (gateResult.outcome === 'revise' || gateResult.unsupported_claims.length > 0) {
        // Delivered, but something failed verification or needed a caveat.
        level = 'medium';
    } else {
        // Clean pass. NOTE: this means "no fabricated numbers/quotes/code/paths were
        // caught", not "certified correct" -- the gate does not verify prose
        // relationship claims. High therefore reflects verification status plus real
        // grounding volume, and thin-evidence passes stay at medium.
        level = evidenceCount >= 3 ? 'high' : 'medium';
    }

    return { ...base, level };
}

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
    /** Live fact store, used ONLY to close the packet-bound numeric gap (LIMITATIONS.md §3.4).
     *  Optional so a dispatcher built without one behaves exactly as before. */
    private readonly factStore?: FactStore;
    private readonly textIndex?: TechnologyPresenceLookup;
    /** Resolved once: which known technologies actually exist in THIS repository.
     *  A property of the repo rather than of any query, so it is cached for the
     *  dispatcher's lifetime and keeps AnswerGate.verify() synchronous. */
    private presentTechnologies?: Set<string>;

    /**
     * Fetches `numeric_threshold` facts for the symbols this answer names near a number.
     *
     * Closes LIMITATIONS.md §3.4: the gate's numeric cross-check could only contradict a claimed
     * number when a matching fact was already in the evidence packet, so a wrong number whose
     * fact retrieval never surfaced passed unexamined -- the safety net having holes. The gate
     * stays synchronous and store-free; the async lookup lives here, in the caller.
     *
     * Fails soft: any store error yields [] and the gate simply behaves as it did before. A
     * verification aid must never be able to break answer delivery.
     */
    private async fetchSupplementalNumericFacts(answer: string): Promise<NumericFact[]> {
        if (!this.factStore) {
            return [];
        }
        const symbols = extractSymbolsNearNumbers(answer);
        if (symbols.length === 0) {
            return [];
        }
        try {
            const records = await this.factStore.findBySymbols(symbols);
            const out: NumericFact[] = [];
            for (const r of records) {
                if (r.factType !== 'numeric_threshold' || !r.symbol) {
                    continue;
                }
                const parsed = Number(r.value);
                if (!isNaN(parsed)) {
                    out.push({ symbol: r.symbol, value: parsed, file: r.filePath, line: r.startLine });
                }
            }
            return out;
        } catch (e) {
            this.context.logger.appendLine(`[Warn] Supplemental numeric-fact lookup failed: ${e}`);
            return [];
        }
    }

    private async getPresentTechnologies(): Promise<Set<string>> {
        if (!this.presentTechnologies) {
            this.presentTechnologies = await resolvePresentTechnologies(this.textIndex);
        }
        return this.presentTechnologies;
    }

    /**
     * Drops the cached technology-presence set so the next answer re-resolves it against
     * the current index. Must be called whenever the index changes underneath this
     * dispatcher (P1-2).
     *
     * WHY THIS MATTERS AND WHY IT IS A LIFECYCLE FIX, NOT A MATCHER FIX.
     * `technologyClaimVerifier` is deliberately precision-tuned -- read its header. Its
     * second precision constraint is that a technology is fabricated only if absent from
     * the REPOSITORY, never merely absent from the retrieved packet, precisely so a real
     * dependency that simply was not retrieved is never called invented. Resolving the
     * set once keeps `AnswerGate.verify()` synchronous, which is the right design.
     *
     * The bug was that "once" meant once per extension session, not once per index
     * generation. Add a real dependency, reindex without restarting VS Code, ask about
     * it, and the check compares a true claim against a snapshot taken before the
     * dependency existed -- so it HARD BLOCKS a correct answer. That converts the
     * verifier's own precision guarantee into exactly the false-block class this project
     * has already reverted checks for twice, via cache staleness rather than the matcher.
     *
     * Clearing the set is the whole fix: the next call re-resolves it lazily against the
     * rebuilt index. The matcher, the curated term list, and the negation handling are
     * untouched.
     */
    public invalidatePresentTechnologies(): void {
        this.presentTechnologies = undefined;
    }

    /**
     * An "I could not find that" answer is the one shape that reads as MORE trustworthy
     * the more wrong it is, and the gate cannot catch it -- there is nothing fabricated
     * in an abstention. Measured: asked where STT confidence averaging lives, the answer
     * said the evidence did not provide details; it is at stt_service.py:181. So before
     * an abstention is delivered clean, the real index is asked whether it knows of a
     * file the packet never contained. If it does, this is a retrieval gap being
     * reported as a fact about the codebase, and the answer says so.
     *
     * Lives here rather than in AnswerGate because the check is question-dependent and
     * therefore asynchronous; AnswerGate.verify() is deliberately synchronous.
     * Only ever downgrades pass -> revise; a correct abstention is left untouched.
     */
    private async flagRetrievalGapAbstention(
        question: string,
        packet: EvidencePacket,
        gateResult: GateResult
    ): Promise<void> {
        if (gateResult.outcome !== 'pass') {
            return;
        }
        const abstention = detectAbstention(gateResult.finalAnswer);
        if (!abstention) {
            return;
        }
        const gap = await findRetrievalGap(question, packet, this.textIndex);
        if (!gap) {
            return;
        }
        const caveat = `⚠️ RepoGuide could not find this in the evidence it retrieved, but the index does ` +
            `contain related code that was not retrieved for this question -- so this may be a ` +
            `retrieval gap rather than an absence. Worth checking: ${gap.candidateLocations.join(', ')}.

`;
        gateResult.finalAnswer = caveat + gateResult.finalAnswer;
        gateResult.diagnostics.push(
            `Abstention may be a retrieval gap: index has ${gap.candidateLocations.join(', ')}, absent from the packet.`
        );
        gateResult.outcome = 'revise';
    }

    /**
     * A deep-trace answer that drops a file the evidence kept talking about is an
     * incomplete trace, and nothing else in the gate notices -- every claim it DOES make
     * can be perfectly supported. Root-caused as the model omitting a file it was given,
     * not a packing bug (see multiHopCoverageVerifier.ts), so it is caught after the fact
     * rather than prompted away. Only downgrades pass -> revise.
     */
    private flagOmittedTraceFiles(
        question: string,
        packet: EvidencePacket,
        gateResult: GateResult
    ): void {
        if (gateResult.outcome !== 'pass') {
            return;
        }
        const omitted = findOmittedFiles(question, packet, gateResult.finalAnswer);
        if (omitted.length === 0) {
            return;
        }
        const listed = omitted.map(o => `${o.file} (${o.mentions} mentions)`).join(', ');
        gateResult.finalAnswer =
            `⚠️ This trace may be incomplete: the evidence repeatedly references ` +
            `${listed}, which this answer does not mention.

` + gateResult.finalAnswer;
        gateResult.diagnostics.push(`Multi-hop answer omits well-evidenced file(s): ${listed}.`);
        gateResult.outcome = 'revise';
    }

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
        this.factStore = stores.factStore;
        this.textIndex = stores.bm25Store;
        const rerankerBackend = resolveRerankerBackend(
            this.context.getConfig<string>('retrieval.reranker', 'bge')
        );
        this.packetBuilder = new EvidencePacketBuilder(
            stores,
            this.context.workspaceRoot,
            rerankerBackend === 'off'
                ? undefined
                : new CrossEncoderReranker(rerankerBackend, msg => this.context.logger.appendLine(msg))
        );
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

        // Supersede the in-flight (retrieval-volume) estimate with a badge that
        // reflects what the gate actually verified. Emitted here -- after gating,
        // before the first token is yielded -- because the UI binds the confidence
        // footer when the first token arrives.
        if (onConfidence) {
            await onConfidence(confidenceFromGate(packet, gateResult, `Verification: gate ${gateResult.outcome}.`));
        }

        let answer = gateResult.finalAnswer;


        if (gateResult.outcome === 'block') {
            yield JSON.stringify({
                __type: 'gateStatus',
                status: { ...deriveGateStatusOutcome(gateResult), mode: packet.plan.confidence_mode }
            });
            const blockedMessage = renderWithheldAnswer(packet, gateResult, 'the answer');
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
        // Trust-visibility (UX Part 3 design, item B): a gateStatus token so the UI
        // can show whether/how this answer was verified. Every gate-bearing surface
        // emits it -- chat (here), the decomposed merge (here), and explainSelection
        // (which yields the same token before delegating to the shared tail below).
        // The "Unverified" chip that deriveGateChipInfo falls back to when the token
        // is absent is now purely defensive: no production path skips it. See
        // webviews/sidebar/sidebar.js's gateStatus handler and
        // gateStatusRendering.js's deriveGateChipInfo for the rendering contract.
        const correctedGateStatus = deriveGateStatusOutcome(gateResult, decompositionContext);
        yield JSON.stringify({
            __type: 'gateStatus',
            status: { ...correctedGateStatus, mode: packet.plan.confidence_mode }
        });

        const answer = await this.finalizeApprovedAnswer(
            question,
            approvedAnswer,
            packet,
            gateResult,
            correctedGateStatus.outcome,
            decompositionContext !== undefined
        );

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

    /**
     * The canonical post-gate tail's SIDE EFFECTS, shared by every gate-approved
     * answer regardless of which surface delivers it: conversation-history
     * recording, mentor insights, citation-marker resolution, and the
     * query-evidence export an MCP session reads back via get_last_chat_evidence.
     * Returns the finalized answer text.
     *
     * WHY THIS IS SPLIT OUT (defect #11, 2026-08-04). `explainSelection` never
     * called `emitFinalAnswer` -- it hand-rolled a two-line partial copy of this
     * tail (history recording only). The result was a silent divergence of exactly
     * the shape CLAUDE.md's DoD #3 warns about: an explain-selection turn was
     * fully AnswerGate-verified but was invisible to `get_last_chat_evidence`, got
     * no mentor insights, and had no citation markers resolved -- and every future
     * addition to this tail would have missed that surface too. Keeping the
     * effects here (and only the typed side-band token yields in
     * `emitFinalAnswer`) is what makes "one canonical tail" enforceable across a
     * generator surface and a plain-text surface at the same time; see
     * `src/test/query/canonicalAnswerTail.test.ts`, which fails if a
     * gate-approved delivery path stops running it.
     */
    private async finalizeApprovedAnswer(
        question: string,
        approvedAnswer: string,
        packet: EvidencePacket,
        gateResult: GateResult,
        correctedOutcome: GateResult['outcome'],
        decomposed: boolean
    ): Promise<string> {
        let answer = approvedAnswer;

        // A gate-blocked refusal is not real conversational content — only record
        // gate-approved turns, so later follow-ups don't resolve against a refusal.
        // (Callers must not reach this method on a 'block' outcome.)
        this.history.add('user', question);
        this.history.add('assistant', answer);

        const mentorStartTime = performance.now();
        const mentorContext = this.mentorOrchestrator.run(packet, gateResult);
        if (mentorContext) {
            const insights = this.mentorRenderer.render(mentorContext);
            answer += insights;
        }
        const mentorLatency = performance.now() - mentorStartTime;
        this.context.logger.appendLine(`Mentor Integration Latency: ${mentorLatency.toFixed(2)} ms`);

        // Post-process citations
        answer = answer.replace(/\(ev-(\d+)\)/g, (match, idStr) => {
            const item = packet.items.find(i => String(i.id) === idStr) || packet.facts.find(f => String(f.id) === idStr);
            if (!item) return match;

            const relativePath = this.context.asRelativePath(item.file);
            const display = `[${relativePath}:${item.startLine}]`;

            return `___CITE___${item.file}|${item.startLine}|${item.endLine}|${display}___CITE_END___`;
        });

        // Query-evidence export (see queryEvidenceExporter.ts): a connected MCP
        // session can pull this instead of rediscovering the same context.
        // 'internal' is the eval-harness client (queryPipelineHarness.ts) --
        // deliberately excluded so evaluation runs don't pollute a file meant to
        // reflect real chat/MCP sessions. Exports the citation markers resolved
        // to their plain display text (the same strip mcpServer.ts's ask_repoguide
        // applies), not the raw markers a real client parses into links, and not
        // the pre-citation answer -- this is genuinely what the user saw.
        // Never allowed to affect answer delivery: any failure is caught and
        // logged, not surfaced to the caller.
        if (this.client !== 'internal') {
            try {
                const entry = buildEntry(
                    question,
                    stripCitationMarkersToDisplayText(answer),
                    packet,
                    { ...gateResult, outcome: correctedOutcome },
                    this.client,
                    decomposed
                );
                await exportQueryEvidence(this.context.repoguideDataDir ?? this.context.workspaceRoot, entry);
            } catch (e) {
                this.context.logger.appendLine(`[Warn] Query evidence export failed: ${e}`);
            }
        }

        return answer;
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
        const gateResult = this.answerGate.verify(answer, packet, policyFromVerificationPlan(executionPlan.verificationPlan), this.context.workspaceRoot, this.graphStore, await this.getPresentTechnologies(), await this.fetchSupplementalNumericFacts(answer));
        await this.flagRetrievalGapAbstention(question, packet, gateResult);
        this.flagOmittedTraceFiles(question, packet, gateResult);
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
            // Grounding is judged across ALL sub-answers combined: each sub-question retrieved
            // its own evidence, so any one packet understates what the question as a whole
            // actually found.
            const aggregatePacket = {
                ...results[0].packet,
                facts: results.flatMap(r => r.packet.facts),
                items: results.flatMap(r => r.packet.items)
            };
            yield renderWithheldAnswer(
                aggregatePacket,
                {
                    diagnostics: blocked.flatMap(b => b.gate.diagnostics),
                    unsupported_claims: blocked.flatMap(b => b.gate.unsupported_claims)
                },
                'any part of the answer'
            );
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
            // Same gate-derived badge as the single-shot path, using the SAME
            // decomposition-corrected outcome the gateStatus chip will show, so the
            // badge and the chip can never disagree with each other.
            const correctedForBadge = deriveGateStatusOutcome(outcome.finalGate ?? passed[0].gate, {
                blockedCount: blocked.length,
                usedFallback: outcome.usedFallback
            });
            await onConfidence(confidenceFromGate(
                outcome.unionPacket,
                { outcome: correctedForBadge.outcome, unsupported_claims: (outcome.finalGate ?? passed[0].gate).unsupported_claims },
                `Decomposed into ${total} parts (${passed.length} verified).`
            ));
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
        const effectiveQuestion = question ?? `Explain selected code in ${filePath}`;

        const draft = await this.synthesizer.synthesizeExplainSelection(packet, inferenceModel, this.history.getMessages());
        const gateResult = this.answerGate.verify(draft, packet, policyFromVerificationPlan(executionPlan.verificationPlan), this.context.workspaceRoot, this.graphStore, await this.getPresentTechnologies(), await this.fetchSupplementalNumericFacts(draft));

        // Same trust-visibility contract as the chat path (emitFinalAnswer): the
        // gateStatus token is emitted on BOTH outcomes, before any answer text, so
        // no delivered explanation is left looking unverified when it was in fact
        // gated. Consumers that render plain text route this token out of the text
        // stream -- see classifyExplainToken in src/ui/explainPanel.ts, and the
        // matching strip already present in evaluation/queryPipelineHarness.ts.
        const gateStatus = deriveGateStatusOutcome(gateResult);
        yield JSON.stringify({
            __type: 'gateStatus',
            status: { ...gateStatus, mode: packet.plan.confidence_mode }
        });

        if (gateResult.outcome === 'block') {
            yield renderWithheldAnswer(packet, gateResult, 'this explanation');
            return;
        }

        // Canonical shared tail -- identical to what emitFinalAnswer runs for chat.
        // Citation markers are resolved back to display text because this path's
        // consumer (ui/explainPanel.ts) renders with textContent and cannot turn
        // markers into links; the chat surface keeps the raw markers.
        const answer = await this.finalizeApprovedAnswer(
            effectiveQuestion,
            gateResult.finalAnswer,
            packet,
            gateResult,
            gateStatus.outcome,
            false
        );
        yield stripCitationMarkersToDisplayText(answer);
    }

    // REMOVED 2026-08-04 (defect #11): `explainSelectionResult()`. It duplicated
    // `explainSelection()`'s plan/retrieve/synthesize/gate sequence and then
    // hand-rolled its OWN answer-metadata and history tail -- a second
    // implementation of one capability (CLAUDE.md DoD #3) that no production code
    // ever invoked. The only reference outside its own definition was the
    // pass-through assignment in extension.ts's ChatPipeline object literal;
    // nothing called `queryPipeline.explainSelectionResult(...)` anywhere in the
    // tree. Removed rather than routed through the shared tail, because keeping an
    // uncalled second path alive is exactly the orphaned-subsystem pattern this
    // repo has a written history of. Recoverable from git if a structured
    // explain-selection result is ever actually needed; it should be built on top
    // of `explainSelection` + `finalizeApprovedAnswer`, not beside them.

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
        // P1-5: buffer the full answer and gate-verify it BEFORE yielding anything, instead of
        // streaming raw, unverified chunks straight to the user. This is not a new pattern --
        // it's the same "yield the full string answer as a single token for simplicity"
        // contract `emitFinalAnswer` already uses for chat and `explainSelection`, both pinned
        // by `canonicalAnswerTail.test.ts`. Bringing the documentation-report path in line with
        // it (rather than inventing a fourth variant) is what closes all three problems the
        // audit found together: raw `answer` was streamed while every gate correction lived
        // only in `finalAnswer` and was discarded; no `gateStatus` token meant the UI's
        // "Unverified" fallback chip was reachable from a real production path after all,
        // contradicting `emitFinalAnswer`'s own comment that it no longer was; and a `block`
        // outcome dumped the raw checker-diagnostics array straight into user-facing text, the
        // exact pattern `withheldAnswer.ts` replaced everywhere else.
        let answer = '';
        for await (const chunk of this.synthesizer.streamSynthesizeDocumentation(packet, inferenceModel, abortSignal)) {
            answer += chunk;
        }

        const gateResult = this.answerGate.verify(answer, packet, policyFromVerificationPlan(executionPlan.verificationPlan), this.context.workspaceRoot, this.graphStore, await this.getPresentTechnologies(), await this.fetchSupplementalNumericFacts(answer));

        // Same trust-visibility contract as every other gate-bearing surface (chat, decomposed
        // merge, explainSelection): a gateStatus token so the UI can render real verification
        // state instead of falling back to the defensive "Unverified" chip.
        yield JSON.stringify({
            __type: 'gateStatus',
            status: { ...deriveGateStatusOutcome(gateResult), mode: packet.plan.confidence_mode }
        });

        if (gateResult.outcome === 'block') {
            yield renderWithheldAnswer(packet, gateResult, 'the documentation report');
            return;
        }

        // `finalAnswer` carries every caveat/prefix the gate computed (thin-evidence caveat,
        // relation-contradiction correction, conceptual-coverage prefix); the raw `answer`
        // never did. A `revise` outcome previously produced nothing beyond the unmodified raw
        // text -- now it reads the same corrected content every other surface delivers.
        yield gateResult.finalAnswer;
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
