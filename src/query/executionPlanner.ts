import { RepositoryContext } from '../context/repositoryContext';
import { EvidencePlan } from './evidencePlanTypes';
import { buildEvidencePlan } from './evidencePlanner';
import { scoreQueryComplexity } from './planning/complexityScorer';
import { buildLLMEvidencePlan } from './planning/llmEvidencePlanner';

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
    mode: 'answer' | 'raw_evidence' | 'investigation' | 'explain_selection';
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
    constructor(private readonly context: RepositoryContext) {}

    async plan(request: PlanningRequest, inferenceModel: string): Promise<ExecutionPlan> {
        const complexity = scoreQueryComplexity(request.query);
        const allowLLMPlanning = request.constraints?.allowLLMPlanning !== false;
        let evidencePlan: EvidencePlan;
        let planner: PlannerMetadata['planner'] = 'regex';

        if (allowLLMPlanning && complexity.classification === 'complex') {
            evidencePlan = await buildLLMEvidencePlan(this.context, request.query, inferenceModel);
            planner = 'llm';
        } else {
            evidencePlan = buildEvidencePlan(request.query);
        }

        const category = mapQueryTypeToCategory(evidencePlan.queryType);
        const maxItems = request.constraints?.maxEvidenceItems ?? 50;
        const maxLatencyMs = request.constraints?.maxLatencyMs ?? 2500;
        const providerIds = selectProviderIds(category);

        return {
            planId: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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
                maxItems: 0
            },
            evidenceRequirements: evidencePlan.requiredEvidence.map(type => ({ type, required: true })),
            verificationPlan: {
                requireAnswerGate: true,
                requiredEvidenceTypes: evidencePlan.requiredEvidence
            },
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
            return ['symbol_index', 'logical_unit_store', 'program_graph', 'fact_store', 'hybrid_retrieval'];
        case 'architectural_reasoning':
        case 'debugging':
        case 'investigation':
        case 'engineering_decision_support':
        case 'multi_step_reasoning':
            return ['symbol_index', 'fact_store', 'logical_unit_store', 'program_graph', 'hybrid_retrieval', 'repository_brain'];
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