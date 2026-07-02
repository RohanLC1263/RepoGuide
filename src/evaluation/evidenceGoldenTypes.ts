import { EvidencePacket } from '../query/evidencePacket';
import { MentorCapability } from '../mentor/mentorTypes';
export interface ExpectedFact {
    type: string;
    symbol?: string;
    value?: any; // exact value match if provided
}

export interface ExpectedSpan {
    filePattern: string; // Regex or exact file
    symbol?: string; // e.g. "MAX_RETRIES"
}

export interface MentorEvalExpectations {
    expectedCapability: MentorCapability | 'None';
    expectedRecommendationType?: string;
    requiredFields?: string[];
    requiredReasoningKeywords?: string[];
    allowNoMentor?: boolean;
}

export interface EvidenceTestCase {
    id: string;
    description: string;
    query: string;
    expectedSpans: ExpectedSpan[];
    expectedFacts: ExpectedFact[];
    prohibitedFilePatterns: string[];
    expectGap?: boolean;
    expectedAnswerGateOutcome?: 'pass' | 'blocked_or_revised';
    expectedMentorResult?: MentorEvalExpectations;
}

export interface EvidenceGateResults {
    caseId: string;
    gate1SpanPassed: boolean;
    gate2FactPassed: boolean;
    testLeak: boolean;
    diagnostics: string[];
    packet: EvidencePacket;

    // New detailed metrics
    evidencePrecisionAtK: number;
    evidenceRecallAtK: number;
    requiredEvidenceCoverage: number;
    constantExpansionFired: boolean;
    
    // Gate Metrics
    answerGatePass: boolean;
    unsupportedClaimRate: number;
    numericAccuracy: number;
    
    // Failure classification
    failureMode: 'none' | 'missing_fact' | 'missing_span' | 'test_leak' | 'unsupported_claim' | 'hallucinated_quote' | 'gap_failure' | 'mentor_routing_failure' | 'mentor_recommendation_failure' | 'other';

    // Mentor Specific Fields
    mentorEvaluated: boolean;
    mentorPass: boolean;
    mentorFailureReason?: string;
    mentorFailureType?: 'routing' | 'recommendation';
    expectedCapability?: string;
    actualCapability?: string;
    expectedRecommendationType?: string;
    actualRecommendationType?: string;
}

export interface EvidenceEvalReport {
    timestamp: string;
    gate1Score: number;
    gate2Score: number;
    testLeakRate: number;
    
    avgPrecisionAtK: number;
    avgRecallAtK: number;
    avgRequiredCoverage: number;
    constantExpansionRate: number;
    
    answerGatePassRate: number;
    avgUnsupportedClaimRate: number;
    avgNumericAccuracy: number;
    
    totalCases: number;
    results: EvidenceGateResults[];

    // Mentor Summary Metrics
    totalMentorTests: number;
    totalRoutingTests: number;
    mentorRoutingPassRate: number;
    mentorRecommendationPassRate: number;
    totalNoMentorTests: number;
    noMentorPassRate: number;
}

export interface EvidenceStabilityReport {
    timestamp: string;
    iterations: number;
    metrics: {
        gate1ScoreMean: number;
        gate1ScoreVariance: number;
        gate2ScoreMean: number;
        gate2ScoreVariance: number;
        answerGatePassRateMean: number;
        answerGatePassRateVariance: number;
    };
    passed: boolean;
}
