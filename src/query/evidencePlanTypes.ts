import { FactType } from '../indexing/factTypes';
import { LogicalUnitType, LogicalUnitRole } from '../indexing/logicalUnitTypes';

export type QueryType =
    | 'exact_constant'
    | 'threshold'
    | 'list_count'
    | 'fallback_chain'
    | 'dependency_injection'
    | 'symbol_location'
    | 'prompt_template'
    | 'config_surface'
    | 'behavior_explanation'
    | 'architecture_analysis'
    | 'onboarding_analysis'
    | 'test_query'
    | 'impact_analysis'
    | 'refactoring_analysis'
    | 'decision_outcome_analysis'
    | 'causal_analysis'
    | 'risk_analysis'
    | 'hotspot_analysis'
    | 'incident_analysis'
    | 'change_impact_prediction'
    | 'prediction_accountability'
    | 'runtime_intelligence'
    | 'unknown';

export type FileScope = 'implementation_only' | 'tests_only' | 'both' | 'docs_config_allowed';
export type RetrievalStrategy = 'exact_match' | 'hybrid' | 'pagerank_expansion' | 'broad_semantic';

export interface RetrievalTask {
    id: string;
    description: string;
    symbolHints: string[];
    fileHints: string[];
    requiredEvidence: string[];
}

export interface EvidencePlan {
    originalQuery: string;
    normalizedQuery: string;
    queryType: QueryType;
    retrievalTasks?: RetrievalTask[];
    /**
     * Ordered sub-questions for multi-facet questions, emitted by the LLM planner
     * only when the question genuinely spans multiple distinct facets (most
     * questions must not decompose). Validated + capped in llmEvidencePlanner;
     * QueryDispatcher additionally gates on complexity score and query type
     * before actually running a decomposed generation. Absent/empty means
     * single-shot.
     */
    subQuestions?: string[];
    requiredEvidence: string[];
    symbolHints: string[];
    fileHints: string[];
    phrases?: string[];
    factTypes: FactType[];
    unitTypes: LogicalUnitType[];
    fileScope: FileScope;
    retrievalStrategy: RetrievalStrategy;
    mustExcludeRoles: LogicalUnitRole[];
    diagnostics: string[];
    confidence_mode: 'exact' | 'grounded' | 'conceptual';
}
