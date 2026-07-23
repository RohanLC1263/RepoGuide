import { RepositoryContext } from '../context/repositoryContext';
import { EvidencePlan } from './evidencePlanTypes';
import { buildEvidencePlan } from './evidencePlanner';
import { scoreQueryComplexity } from './planning/complexityScorer';
import { buildLLMEvidencePlan } from './planning/llmEvidencePlanner';
import { LogicalUnitStore } from '../store/logicalUnitStore';

export type QueryCategory =
    | 'factual_lookup'
    | 'symbol_lookup'
    | 'dependency_analysis'
    | 'architectural_reasoning'
    | 'debugging'
    | 'investigation'
    | 'explain_selection'
    | 'documentation'
    | 'repository_exploration'
    | 'engineering_decision_support'
    | 'multi_step_reasoning';

export interface PlanningRequest {
    requestId: string;
    query: string;
    client: 'vscode' | 'mcp' | 'internal';
    workspaceRoot: string;
    repoguideDir: string;
    mode: 'answer' | 'raw_evidence' | 'investigation' | 'explain_selection' | 'documentation';
    selection?: {
        file: string;
        startLine: number;
        endLine: number;
        text: string;
        language?: string;
    };
    conversationContext?: Array<{ role: 'user' | 'assistant'; content: string }>;
    constraints?: {
        maxLatencyMs?: number;
        maxEvidenceItems?: number;
        requireFreshEvidence?: boolean;
        allowLLMPlanning?: boolean;
    };
}

export interface PlannerDiagnostic {
    level: 'info' | 'warn' | 'error';
    message: string;
}

export interface IntentResult {
    category: QueryCategory;
    queryType: EvidencePlan['queryType'];
}

export interface ComplexityResult {
    classification: 'simple' | 'complex';
    score: number;
    reasons: string[];
}

export type PlanningStrategyName = 'deterministic' | 'llm_decomposed' | 'fallback';

export interface PlanningStrategy {
    name: PlanningStrategyName;
    reason: string;
    llmUsed: boolean;
}

export type RepositoryKnowledgeType =
    | 'architecture_decision'
    | 'decision_outcome'
    | 'causal_explanation'
    | 'change_impact'
    | 'runtime_mapping'
    | 'incident_pattern'
    | 'knowledge_hotspot'
    | 'coverage_risk'
    | 'prediction_accountability'
    | 'developer_note'
    | 'ownership_expertise'
    | 'dependency_insight'
    | 'module_summary'
    | 'repository_pattern';

export type ExcludedEvidenceRole = 'test' | 'generated' | 'docs';

export interface RetrievalPlan {
    strategy: 'exact' | 'hybrid' | 'graph_expansion' | 'broad_semantic' | 'investigation' | 'runtime_augmented';
    targetSymbols: string[];
    targetFiles: string[];
    targetConcepts: string[];
    providerIds: string[];
    excludedRoles: ExcludedEvidenceRole[];
    preferredEvidenceTypes: string[];
    maxItems: number;
    maxLatencyMs: number;
    /** When set, hybrid retrieval uses the deterministic heuristic intent
     * classifier instead of the ~3.6s CPU-bound local-model classify call.
     * Set only on the gather_evidence path (see QueryDispatcher.gatherEvidencePacket);
     * ask_repoguide leaves it undefined and keeps model classification. */
    heuristicClassificationOnly?: boolean;
}

export interface RepositoryIntelligencePlan {
    enabled: boolean;
    knowledgeTypes: RepositoryKnowledgeType[];
    subjects: string[];
    requireValidated: boolean;
    includeStale: boolean;
    maxItems: number;
}

export interface EvidenceRequirement {
    type: string;
    required: boolean;
}

export interface VerificationPlan {
    requireAnswerGate: boolean;
    requiredEvidenceTypes: string[];
    /** Whether AnswerGate should block on numeric claims not found in evidence. Default true. */
    checkNumericClaims: boolean;
    /** Whether AnswerGate should block on quoted strings not found in evidence. Default true. */
    checkQuotedStrings: boolean;
    /** Whether AnswerGate should block on file paths not found in evidence. Default true. */
    checkFilePaths: boolean;
}

export interface ConfidencePolicy {
    mode: EvidencePlan['confidence_mode'];
}

export interface FreshnessPolicy {
    requireFreshEvidence: boolean;
}

export interface FailurePolicy {
    plannerFailure: 'fallback' | 'fail';
    retrievalFailure: 'partial' | 'fail';
    synthesisFailure: 'fallback' | 'fail';
    validationFailure: 'block';
}

export interface PlannerMetadata {
    planner: 'regex' | 'llm' | 'fallback';
    createdAt: string;
}

export interface ExecutionPlan {
    planId: string;
    requestId: string;
    query: string;
    category: QueryCategory;
    intent: IntentResult;
    complexity: ComplexityResult;
    strategy: PlanningStrategy;
    retrievalPlan: RetrievalPlan;
    intelligencePlan: RepositoryIntelligencePlan;
    evidenceRequirements: EvidenceRequirement[];
    verificationPlan: VerificationPlan;
    confidencePolicy: ConfidencePolicy;
    freshnessPolicy: FreshnessPolicy;
    failurePolicy: FailurePolicy;
    diagnostics: PlannerDiagnostic[];
    metadata: PlannerMetadata;
    /** Temporary compatibility surface until EvidencePacketBuilder consumes only normalized orchestration output. */
    evidencePlan: EvidencePlan;
}

export class ExecutionPlanner {
    /**
     * `unitStore` is optional: callers that only exercise this class against a mock
     * context (smoke-test scripts) don't have a real store to validate hints against,
     * and degrade gracefully to the pre-validation behavior rather than being forced
     * to construct one just to satisfy this constructor.
     */
    constructor(private readonly context: RepositoryContext, private readonly unitStore?: LogicalUnitStore) {}

    async plan(request: PlanningRequest, inferenceModel: string): Promise<ExecutionPlan> {
        // Selection-seeded and directive-seeded modes bypass free-text query classification
        // entirely: there is no question to classify, only a selection or a fixed directive.
        if (request.mode === 'explain_selection' && request.selection) {
            return this.planExplainSelection(request);
        }
        if (request.mode === 'documentation') {
            return this.planDocumentation(request);
        }

        const conversationContext = request.conversationContext ?? [];
        const complexity = scoreQueryComplexity(request.query, conversationContext.length > 0);
        const allowLLMPlanning = request.constraints?.allowLLMPlanning !== false;
        let evidencePlan: EvidencePlan;
        let planner: PlannerMetadata['planner'] = 'regex';

        if (allowLLMPlanning && complexity.classification === 'complex') {
            evidencePlan = await buildLLMEvidencePlan(this.context, request.query, inferenceModel, conversationContext, this.unitStore);
            planner = 'llm';
        } else {
            evidencePlan = buildEvidencePlan(request.query);
        }

        const category = mapQueryTypeToCategory(evidencePlan.queryType);
        const maxItems = request.constraints?.maxEvidenceItems ?? 50;
        const maxLatencyMs = request.constraints?.maxLatencyMs ?? 2500;
        const providerIds = selectProviderIds(category);
        const verification = verificationPlanForMode(request.mode, evidencePlan.requiredEvidence);

        return {
            planId: buildPlanId(),
            requestId: request.requestId,
            query: request.query,
            category,
            intent: {
                category,
                queryType: evidencePlan.queryType
            },
            complexity,
            strategy: {
                name: planner === 'llm' ? 'llm_decomposed' : 'deterministic',
                reason: planner === 'llm' ? 'Complexity score selected LLM planning.' : 'Complexity score selected deterministic planning.',
                llmUsed: planner === 'llm'
            },
            retrievalPlan: {
                strategy: mapRetrievalStrategy(evidencePlan.retrievalStrategy),
                targetSymbols: evidencePlan.symbolHints,
                targetFiles: evidencePlan.fileHints,
                targetConcepts: [],
                providerIds,
                excludedRoles: evidencePlan.mustExcludeRoles as ExcludedEvidenceRole[],
                preferredEvidenceTypes: evidencePlan.requiredEvidence,
                maxItems,
                maxLatencyMs
            },
            intelligencePlan: {
                enabled: providerIds.includes('repository_brain'),
                knowledgeTypes: selectKnowledgeTypes(category),
                subjects: [...evidencePlan.symbolHints, ...evidencePlan.fileHints],
                requireValidated: true,
                includeStale: false,
                // Previously hardcoded to 0, which silently made RepositoryBrainProvider return
                // zero items on every request regardless of what was populated in the store.
                maxItems: providerIds.includes('repository_brain') ? 10 : 0
            },
            evidenceRequirements: evidencePlan.requiredEvidence.map(type => ({ type, required: true })),
            verificationPlan: verification,
            confidencePolicy: {
                mode: evidencePlan.confidence_mode
            },
            freshnessPolicy: {
                requireFreshEvidence: request.constraints?.requireFreshEvidence ?? false
            },
            failurePolicy: {
                plannerFailure: 'fallback',
                retrievalFailure: 'partial',
                synthesisFailure: 'fail',
                validationFailure: 'block'
            },
            diagnostics: evidencePlan.diagnostics.map(message => ({ level: 'info', message })),
            metadata: {
                planner,
                createdAt: new Date().toISOString()
            },
            evidencePlan
        };
    }

    private planExplainSelection(request: PlanningRequest): ExecutionPlan {
        const selection = request.selection!;
        const category: QueryCategory = 'explain_selection';
        const providerIds = selectProviderIds(category);
        const maxItems = request.constraints?.maxEvidenceItems ?? 50;
        const maxLatencyMs = request.constraints?.maxLatencyMs ?? 2500;
        const targetConcepts = unique([
            ...extractIdentifierKeywords(selection.text).slice(0, 8),
            ...extractIdentifierKeywords(request.query).slice(0, 8)
        ]);
        const evidencePlan = buildSyntheticEvidencePlan(request.query || `Explain the selected code in ${selection.file}.`, 'behavior_explanation', 'grounded', targetConcepts);

        return {
            planId: buildPlanId(),
            requestId: request.requestId,
            query: request.query,
            category,
            intent: { category, queryType: evidencePlan.queryType },
            complexity: { classification: 'simple', score: 0, reasons: ['explain_selection mode bypasses free-text classification'] },
            strategy: { name: 'deterministic', reason: 'Selection-seeded plan; no query classification required.', llmUsed: false },
            retrievalPlan: {
                strategy: 'hybrid',
                targetSymbols: [],
                targetFiles: [selection.file],
                targetConcepts,
                providerIds,
                excludedRoles: [],
                preferredEvidenceTypes: [],
                maxItems,
                maxLatencyMs
            },
            intelligencePlan: {
                enabled: false,
                knowledgeTypes: [],
                subjects: [selection.file],
                requireValidated: true,
                includeStale: false,
                maxItems: 0
            },
            evidenceRequirements: [],
            verificationPlan: {
                requireAnswerGate: true,
                requiredEvidenceTypes: [],
                checkNumericClaims: true,
                checkQuotedStrings: true,
                checkFilePaths: true
            },
            confidencePolicy: { mode: 'grounded' },
            freshnessPolicy: { requireFreshEvidence: request.constraints?.requireFreshEvidence ?? false },
            failurePolicy: { plannerFailure: 'fallback', retrievalFailure: 'partial', synthesisFailure: 'fail', validationFailure: 'block' },
            diagnostics: [{ level: 'info', message: 'Planned via explain_selection fast path.' }],
            metadata: { planner: 'regex', createdAt: new Date().toISOString() },
            evidencePlan
        };
    }

    private planDocumentation(request: PlanningRequest): ExecutionPlan {
        const category: QueryCategory = 'documentation';
        const providerIds = selectProviderIds(category);
        const query = request.query || 'Generate a structured project overview covering purpose, tech stack, architecture, modules, entry points, and key files.';
        const evidencePlan = buildSyntheticEvidencePlan(query, 'architecture_analysis', 'conceptual', []);

        return {
            planId: buildPlanId(),
            requestId: request.requestId,
            query,
            category,
            intent: { category, queryType: evidencePlan.queryType },
            complexity: { classification: 'simple', score: 0, reasons: ['documentation mode bypasses free-text classification'] },
            strategy: { name: 'deterministic', reason: 'Directive-seeded plan; no query classification required.', llmUsed: false },
            retrievalPlan: {
                strategy: 'broad_semantic',
                targetSymbols: [],
                targetFiles: [],
                targetConcepts: [],
                providerIds,
                excludedRoles: ['test', 'generated'],
                preferredEvidenceTypes: [],
                maxItems: request.constraints?.maxEvidenceItems ?? 200,
                maxLatencyMs: request.constraints?.maxLatencyMs ?? 120000
            },
            intelligencePlan: {
                enabled: false,
                knowledgeTypes: [],
                subjects: [],
                requireValidated: true,
                includeStale: false,
                maxItems: 0
            },
            evidenceRequirements: [],
            verificationPlan: {
                requireAnswerGate: true,
                requiredEvidenceTypes: [],
                checkNumericClaims: false,
                checkQuotedStrings: false,
                checkFilePaths: true
            },
            confidencePolicy: { mode: 'conceptual' },
            freshnessPolicy: { requireFreshEvidence: false },
            failurePolicy: { plannerFailure: 'fallback', retrievalFailure: 'partial', synthesisFailure: 'fail', validationFailure: 'block' },
            diagnostics: [{ level: 'info', message: 'Planned via documentation fast path.' }],
            metadata: { planner: 'regex', createdAt: new Date().toISOString() },
            evidencePlan
        };
    }
}

function buildPlanId(): string {
    return `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function verificationPlanForMode(mode: PlanningRequest['mode'], requiredEvidenceTypes: string[]): VerificationPlan {
    if (mode === 'investigation') {
        // Investigation/plan-analysis reports contain the engine's own computed confidence
        // and likelihood numbers, not claims about evidence — checking them against packet
        // content would spuriously block. File-path citations still get checked: a
        // hallucinated file in a detective report is a real risk.
        return {
            requireAnswerGate: true,
            requiredEvidenceTypes,
            checkNumericClaims: false,
            checkQuotedStrings: false,
            checkFilePaths: true
        };
    }
    if (mode === 'raw_evidence') {
        // No answer is synthesized for raw_evidence requests, so gate checks are moot —
        // QueryDispatcher.retrieveRawEvidence() never calls AnswerGate. Recorded here for
        // diagnostic clarity only.
        return {
            requireAnswerGate: false,
            requiredEvidenceTypes,
            checkNumericClaims: false,
            checkQuotedStrings: false,
            checkFilePaths: false
        };
    }
    return {
        requireAnswerGate: true,
        requiredEvidenceTypes,
        checkNumericClaims: true,
        checkQuotedStrings: true,
        checkFilePaths: true
    };
}

function buildSyntheticEvidencePlan(
    query: string,
    queryType: EvidencePlan['queryType'],
    confidence_mode: EvidencePlan['confidence_mode'],
    symbolHints: string[]
): EvidencePlan {
    return {
        originalQuery: query,
        normalizedQuery: query.toLowerCase(),
        queryType,
        requiredEvidence: [],
        symbolHints,
        fileHints: [],
        phrases: [],
        factTypes: [],
        unitTypes: [],
        fileScope: 'both',
        retrievalStrategy: 'hybrid',
        mustExcludeRoles: [],
        diagnostics: [],
        confidence_mode
    };
}

/** Shared with prompt-side selection handling; exported so callers don't duplicate keyword extraction. */
export function extractIdentifierKeywords(text: string): string[] {
    const keywords = new Set<string>();
    const allCapsMatches = text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [];
    for (const m of allCapsMatches) keywords.add(m);
    const snakeMatches = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
    for (const m of snakeMatches) keywords.add(m);
    const pascalMatches = text.match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g) || [];
    for (const m of pascalMatches) keywords.add(m);
    const camelMatches = text.match(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g) || [];
    for (const m of camelMatches) keywords.add(m);
    return Array.from(keywords);
}

function unique<T>(values: T[]): T[] {
    return Array.from(new Set(values));
}

function mapRetrievalStrategy(strategy: EvidencePlan['retrievalStrategy']): RetrievalPlan['strategy'] {
    switch (strategy) {
        case 'exact_match':
            return 'exact';
        case 'pagerank_expansion':
            return 'graph_expansion';
        case 'broad_semantic':
            return 'broad_semantic';
        case 'hybrid':
        default:
            return 'hybrid';
    }
}

function mapQueryTypeToCategory(queryType: EvidencePlan['queryType']): QueryCategory {
    switch (queryType) {
        case 'exact_constant':
        case 'threshold':
        case 'list_count':
        case 'prompt_template':
        case 'config_surface':
            return 'factual_lookup';
        case 'symbol_location':
            return 'symbol_lookup';
        case 'impact_analysis':
        case 'change_impact_prediction':
            return 'dependency_analysis';
        case 'architecture_analysis':
        case 'onboarding_analysis':
        case 'refactoring_analysis':
            return 'architectural_reasoning';
        case 'runtime_intelligence':
        case 'incident_analysis':
            return 'debugging';
        case 'prediction_accountability':
        case 'decision_outcome_analysis':
        case 'causal_analysis':
        case 'risk_analysis':
        case 'hotspot_analysis':
            return 'engineering_decision_support';
        default:
            return 'repository_exploration';
    }
}

function selectProviderIds(category: QueryCategory): string[] {
    switch (category) {
        case 'factual_lookup':
            return ['symbol_index', 'fact_store', 'logical_unit_store', 'hybrid_retrieval'];
        case 'symbol_lookup':
            return ['symbol_index', 'logical_unit_store', 'fact_store', 'hybrid_retrieval'];
        case 'dependency_analysis':
            return ['symbol_index', 'logical_unit_store', 'program_graph', 'fact_store', 'hybrid_retrieval', 'flow_context'];
        case 'architectural_reasoning':
        case 'debugging':
            return ['symbol_index', 'fact_store', 'logical_unit_store', 'program_graph', 'hybrid_retrieval', 'repository_brain', 'flow_context'];
        case 'investigation':
        case 'engineering_decision_support':
        case 'multi_step_reasoning':
            return ['symbol_index', 'fact_store', 'logical_unit_store', 'program_graph', 'hybrid_retrieval', 'repository_brain'];
        case 'explain_selection':
            return ['symbol_index', 'fact_store', 'logical_unit_store', 'program_graph', 'hybrid_retrieval'];
        case 'documentation':
            return ['lance_store'];
        case 'repository_exploration':
            // The default/fallback category, plus flow_context: the regex
            // planner classifies "trace the execution flow"/"how does X work"
            // style questions as queryType 'behavior_explanation' or 'unknown',
            // both of which land here (see flowContextProvider.ts's comment).
            return ['symbol_index', 'fact_store', 'logical_unit_store', 'hybrid_retrieval', 'flow_context'];
        default:
            return ['symbol_index', 'fact_store', 'logical_unit_store', 'hybrid_retrieval'];
    }
}

function selectKnowledgeTypes(category: QueryCategory): RepositoryKnowledgeType[] {
    switch (category) {
        case 'architectural_reasoning':
            return ['architecture_decision', 'module_summary', 'repository_pattern', 'dependency_insight'];
        case 'debugging':
        case 'investigation':
            return ['incident_pattern', 'runtime_mapping', 'causal_explanation'];
        case 'engineering_decision_support':
            return ['decision_outcome', 'change_impact', 'coverage_risk', 'prediction_accountability', 'knowledge_hotspot'];
        case 'multi_step_reasoning':
            return ['architecture_decision', 'causal_explanation', 'dependency_insight', 'repository_pattern'];
        default:
            return [];
    }
}