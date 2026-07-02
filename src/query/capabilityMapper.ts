import { QueryType } from './evidencePlanTypes';
import { MentorCapability } from '../mentor/mentorTypes';

export function queryTypeToCapability(queryType: QueryType): MentorCapability | 'None' {
    switch (queryType) {
        case 'impact_analysis':
            return 'change_mentor';
        case 'refactoring_analysis':
            return 'refactoring_mentor';
        case 'architecture_analysis':
            return 'architecture_mentor';
        case 'onboarding_analysis':
            return 'onboarding_mentor';
        case 'threshold':
        case 'list_count':
        case 'fallback_chain':
        case 'dependency_injection':
        case 'symbol_location':
        case 'prompt_template':
        case 'config_surface':
        case 'exact_constant':
        case 'behavior_explanation':
        case 'test_query':
        case 'unknown':
        default:
            return 'None';
    }
}
