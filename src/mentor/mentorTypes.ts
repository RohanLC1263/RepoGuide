import { ContextItem } from '../query/contextNormalizer';

export type MentorCapability = 
    | 'architecture_mentor'
    | 'change_mentor'
    | 'onboarding_mentor'
    | 'refactoring_mentor';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface MentorContext {
    capability: MentorCapability;
    architecturalEvidence: ContextItem[];
    communityEvidence: ContextItem[];
    dependencyEvidence: ContextItem[];
    behavioralEvidence: ContextItem[];
    memoryEvidence: ContextItem[];
    coverageScore: number;
    confidenceMode: 'exact' | 'grounded' | 'conceptual';
}

export interface ArchitectureRecommendation {
    type: 'architecture';
    majorComponents: string[];
    importantFiles: string[];
    suggestedReadingOrder: string[];
    architectureSummary: string;
}

export interface ChangeRecommendation {
    type: 'change';
    blastRadius: string[];
    affectedFiles: string[];
    affectedSymbols: string[];
    riskLevel: RiskLevel;
}

export interface OnboardingRecommendation {
    type: 'onboarding';
    modules: string[];
    learningPath: string[];
    firstFiles: string[];
}

export interface RefactoringRecommendation {
    type: 'refactoring';
    dependencyRisks: string[];
    largeModules: string[];
    warnings: string[];
    hotspots: string[];
}

export type MentorRecommendation = 
    | ArchitectureRecommendation 
    | ChangeRecommendation 
    | OnboardingRecommendation 
    | RefactoringRecommendation;

export interface MentorExplanationContext {
    recommendation: MentorRecommendation;
    supportingEvidence: ContextItem[];
    reasoningFactors: string[];
}
