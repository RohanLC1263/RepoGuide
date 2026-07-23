import { EvidencePlan, QueryType, FileScope, RetrievalStrategy } from './evidencePlanTypes';
import { FactType } from '../indexing/factTypes';
import { LogicalUnitRole, LogicalUnitType } from '../indexing/logicalUnitTypes';

const STOPWORDS = new Set([
    'the', 'this', 'that', 'is', 'are', 'was', 'were', 'what', 'how', 'where', 'why', 'who',
    'which', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'about', 'of', 'and', 'or', 'not', 'do',
    'does', 'did', 'can', 'could', 'should', 'would', 'will', 'a', 'an'
]);

export function buildEvidencePlan(query: string): EvidencePlan {
    const normalizedQuery = normalize(query);
    const queryType = classifyQueryType(normalizedQuery);
    const { factTypes, unitTypes, requiredEvidence } = getEvidenceRequirements(queryType);
    
    // Hard suppression contract logic
    const isTest = queryType === 'test_query' || /test|mock|fixture|spec|stub/i.test(query);
    let mustExcludeRoles: LogicalUnitRole[] = [];
    let fileScope: FileScope = 'implementation_only';
    
    if (isTest) {
        fileScope = 'tests_only'; // Allow testing scope, test query can have both but tests_only fits pure test queries. If it's a mixed query we can set 'both'.
        if (/how does .* work/i.test(query) && isTest) fileScope = 'both'; 
    } else {
        mustExcludeRoles = ['test', 'generated'];
    }

    if (queryType === 'architecture_analysis' || queryType === 'onboarding_analysis' || queryType === 'config_surface') {
        fileScope = 'docs_config_allowed';
        mustExcludeRoles = ['test', 'generated'];
    }

    // Extract symbol hints (simple tokenization skipping stopwords)
    const symbolHints = extractSymbolHints(query);
    const fileHints = extractFileHints(query);

    let phrases: string[] = [];
    if (queryType === 'threshold' && symbolHints.some(h => h.toLowerCase() === 'threshold' || h.toLowerCase() === 'confidence')) {
        phrases.push('confidence_threshold', 'min_confidence', 'max_confidence', 'threshold_value', 'score_threshold');
    }

    let retrievalStrategy: RetrievalStrategy = 'hybrid';
    if (['exact_constant', 'threshold', 'list_count'].includes(queryType)) {
        retrievalStrategy = 'exact_match';
    } else if (['behavior_explanation', 'architecture_analysis', 'refactoring_analysis'].includes(queryType)) {
        retrievalStrategy = 'pagerank_expansion';
    } else if (queryType === 'onboarding_analysis') {
        retrievalStrategy = 'broad_semantic';
    }

    const diagnostics: string[] = [`Classified query as ${queryType}`];
    
    if (queryType === 'unknown') {
        diagnostics.push('Conservative plan used due to unknown query structure.');
    }

    let confidence_mode: 'exact' | 'grounded' | 'conceptual' = 'exact';
    if (['threshold', 'exact_constant', 'list_count', 'symbol_location', 'dependency_injection', 'config_surface'].includes(queryType)) {
        confidence_mode = 'exact';
    } else if (['fallback_chain', 'behavior_explanation', 'prompt_template', 'impact_analysis'].includes(queryType)) {
        confidence_mode = 'grounded';
    } else if (['architecture_analysis', 'onboarding_analysis', 'refactoring_analysis', 'test_query'].includes(queryType)) {
        confidence_mode = 'conceptual';
    }

    return {
        originalQuery: query,
        normalizedQuery,
        queryType,
        requiredEvidence,
        symbolHints,
        fileHints,
        phrases,
        factTypes,
        unitTypes,
        fileScope,
        retrievalStrategy,
        mustExcludeRoles,
        diagnostics,
        confidence_mode
    };
}

function normalize(query: string): string {
    return query.toLowerCase().replace(/[.,?;!'"()]/g, '').trim();
}

/**
 * Deterministic, keyword-driven query-type classifier. Exported so the mentor-appendix
 * gate can cross-check it against the LLM planner's queryType: on complex questions the
 * LLM planner can mislabel an "explain X ... how it affects Y" question as impact_analysis
 * (attaching an irrelevant Change-Impact appendix), whereas this classifier reliably lands
 * such questions on behavior_explanation. Callers pass the RAW query; it is lowercased here.
 */
export function classifyQueryType(query: string): QueryType {
    const normalizedQuery = query.toLowerCase();
    if (/\b(threshold|limit|max|min)\b/i.test(normalizedQuery)) return 'threshold';
    if (/\b(how many|count|length|size)\b/i.test(normalizedQuery)) return 'list_count';
    if (/\b(fallback|failover|default|retry)\b/i.test(normalizedQuery)) return 'fallback_chain';
    if (/\b(onboard|new developer|getting started|learning path|where should i start|read first)\b/i.test(normalizedQuery)) return 'onboarding_analysis';
    if (/\bwhere\b.*?\b(defined|located|initialized)\b|\bwhere\b/i.test(normalizedQuery)) return 'symbol_location';
    if (/\b(inject|constructor|init|initializ|parameter)\b/i.test(normalizedQuery)) return 'dependency_injection';
    if (/\b(prompt|template|instruction)\b/i.test(normalizedQuery)) return 'prompt_template';
    if (/\b(config|env|variable)\b/i.test(normalizedQuery)) return 'config_surface';
    if (/\b(constant|value of)\b/i.test(normalizedQuery)) return 'exact_constant';
    if (/\b(structure|architecture|overview|folder|purpose|major components|important components)\b/i.test(normalizedQuery)) return 'architecture_analysis';
    if (/\b(what happens if i modify|what happens if i change|how risky is changing|risk of changing|predict impact)\b/i.test(normalizedQuery)) return 'change_impact_prediction';
    if (/\b(refactor|refactoring|hotspots?|technical debt|architectural debt|cleanup|risky modules?|risky)\b/i.test(normalizedQuery)) return 'refactoring_analysis';
    // impact_analysis is checked BEFORE behavior_explanation: its verbs are specific
    // ("what depends on", "blast radius", "what breaks if"), and the broadened "what is/are"
    // explanation trigger below would otherwise swallow "what is the blast radius of ..." as a
    // plain explanation. Specific-intent verbs must win over the general "what is" phrasing.
    if (/\b(what depends on|what uses|what calls|what imports|who uses|what breaks if|impact of changing|impact of modifying|where is this used|instantiates|blast radius|blast)\b/i.test(normalizedQuery)) return 'impact_analysis';
    if (/\b(how does|explain|what does|what is|what are|what's|behavior)\b/i.test(normalizedQuery)) return 'behavior_explanation';
    if (/\b(test|mock|spec)\b/i.test(normalizedQuery)) return 'test_query';
    if (/\b(accurate|trust|brier score|prediction quality|false positive rate|false negative rate|prediction drift)\b/i.test(normalizedQuery)) return 'prediction_accountability';
    if (/\b(runtime components|runtime failures|runtime risks|runtime health|unhealthy components|degraded runtime)\b/i.test(normalizedQuery)) return 'runtime_intelligence';
    
    // Fallbacks
    if (/threshold|limit|max|min/i.test(normalizedQuery) && !/admin/i.test(normalizedQuery)) return 'threshold';
    
    return 'unknown';
}

function getEvidenceRequirements(queryType: QueryType): { factTypes: FactType[], unitTypes: LogicalUnitType[], requiredEvidence: string[] } {
    let factTypes: FactType[] = [];
    let unitTypes: LogicalUnitType[] = [];
    let requiredEvidence: string[] = [];

    switch (queryType) {
        case 'threshold':
            factTypes = ['numeric_threshold', 'constant'];
            requiredEvidence = ['fact evidence', 'source span evidence'];
            break;
        case 'list_count':
            factTypes = ['list_count', 'list_literal'];
            requiredEvidence = ['fact evidence', 'source span evidence'];
            break;
        case 'fallback_chain':
            factTypes = ['fallback_chain'];
            unitTypes = ['function', 'method'];
            requiredEvidence = ['fallback order facts', 'source span evidence'];
            break;
        case 'dependency_injection':
            factTypes = ['dependency_injection', 'instantiation'];
            unitTypes = ['class', 'function'];
            requiredEvidence = ['instantiation details', 'DI parameters'];
            break;
        case 'symbol_location':
            factTypes = ['instantiation', 'assignment', 'exported_symbol'];
            requiredEvidence = ['symbol evidence', 'line spans'];
            break;
        case 'prompt_template':
            factTypes = ['prompt_template', 'string_literal'];
            requiredEvidence = ['exact prompt string'];
            break;
        case 'config_surface':
            factTypes = ['config_value', 'environment_variable'];
            requiredEvidence = ['configuration keys'];
            break;
        case 'exact_constant':
            factTypes = ['constant'];
            requiredEvidence = ['fact evidence', 'source span evidence'];
            break;
        case 'behavior_explanation':
            factTypes = ['guard_clause', 'fallback_chain', 'call_site'];
            unitTypes = ['function', 'method', 'class'];
            requiredEvidence = ['function/method/class units', 'fallback/guard facts'];
            break;
        case 'architecture_analysis':
        case 'onboarding_analysis':
        case 'refactoring_analysis':
        case 'prediction_accountability':
        case 'runtime_intelligence':
            unitTypes = ['whole_file_fallback'];
            requiredEvidence = ['annotations', 'readme', 'community summaries'];
            break;
        case 'test_query':
            unitTypes = ['function', 'class'];
            requiredEvidence = ['test implementations'];
            break;
        case 'impact_analysis':
            unitTypes = ['function', 'class', 'method'];
            requiredEvidence = ['logical_unit', 'call_site'];
            break;
        case 'unknown':
            factTypes = [];
            unitTypes = [];
            requiredEvidence = ['structured gaps'];
            break;
    }

    return { factTypes, unitTypes, requiredEvidence };
}

function extractSymbolHints(query: string): string[] {
    const tokens = query.split(/[^a-zA-Z0-9_]/).filter(t => t.length > 2);
    const hints = new Set<string>();
    for (const t of tokens) {
        if (!STOPWORDS.has(t.toLowerCase())) {
            hints.add(t);
        }
    }
    return Array.from(hints);
}

function extractFileHints(query: string): string[] {
    const matches = query.match(/[\w-]+\.(ts|js|py|md|json|yml|yaml|go|java|cpp|rs)/g);
    return matches ? Array.from(new Set(matches)) : [];
}
