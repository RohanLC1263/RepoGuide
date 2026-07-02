import { ConfidenceResult } from '../query/confidenceScorer';
import { AnswerContext, RetrievedArtifactRef } from '../feedback/feedbackCaptureService';
import { UnderstandingHealthReport } from '../comprehension/understandingHealthService';
import { EvidenceQueryTelemetrySnapshot } from '../query/evidenceQueryTelemetry';
import { ValidationReport } from './canonicalValidation';

/** Single-value type retained for report-shape backward compatibility
 * (evaluationMode is a persisted field in eval report JSON). There is only
 * one query pipeline now — 'legacy'/'compare' were removed along with
 * HybridQueryPipeline. */
export type EvalMode = 'evidence';

export type EvalQuestionType =
    | 'orientation'
    | 'location'
    | 'flow'
    | 'explanation'
    | 'uncertainty'
    | 'staleness';

export interface ExpectedLocation {
    filePath: string;
    symbolName?: string;
}

export interface ExpectedFlow {
    files: string[];
    symbols: string[];
    description: string;
}

export interface EvalSnippet {
    filePath: string;
    startLine: number;
    endLine: number;
    text?: string;
}

export interface UncertaintyExpectation {
    shouldAdmitUnknown: boolean;
    forbiddenConfidentClaims?: string[];
}

export interface GoldenQuestion {
    id: string;
    type: EvalQuestionType;
    question: string;
    expectedAnswer: string;
    requiresLocations: boolean;
    expectedLocations?: ExpectedLocation[];
    expectedFlow?: ExpectedFlow;
    snippet?: EvalSnippet;
    uncertaintyExpectation?: UncertaintyExpectation;
}

export interface GoldenQuestionSet {
    schemaVersion: '1.0';
    name: string;
    description?: string;
    targetRepoHint?: string;
    questions: GoldenQuestion[];
}

export interface EvalControlEvents {
    navigationResults: unknown[];
    cacheHit?: unknown;
    feedbackContext?: unknown;
    healthCaveats?: unknown[];
}

export interface CapturedContext {
    retrievedChunkIds: string[];
    retrievedArtifacts: RetrievedArtifactRef[];
    topCitedFiles: string[];
    citedFiles: string[];
}

export interface EvalScores {
    locationAccuracy: 0 | 1 | null;
    grounding: 0 | 1 | 2 | null;
    honestUncertainty: 0 | 1 | null;
    flow: 0 | 1 | 2 | null;
    provenanceAccuracy: 0 | 1 | 2 | null;
    stalenessHandling: 0 | 1 | null;
}

export interface EvalQuestionResult {
    id: string;
    type: EvalQuestionType;
    question: string;
    expectedAnswer: string;
    answer: string;
    controlEvents: EvalControlEvents;
    capturedContext: CapturedContext;
    confidence: ConfidenceResult | null;
    scores: EvalScores;
    shadowScores?: EvalScores;
    shadowAnswer?: string;
    shadowControlEvents?: EvalControlEvents;
    shadowCapturedContext?: CapturedContext;
    telemetry?: EvidenceQueryTelemetrySnapshot;
    shadowTelemetry?: EvidenceQueryTelemetrySnapshot;
    contractValidation?: ValidationReport;
    shadowContractValidation?: ValidationReport;
    shadowNotes?: string[];
    notes: string[];
    error?: string;
}

export interface ArtifactAvailability {
    vectorIndex: boolean;
    symbols: boolean;
    manifest: boolean;
    project: boolean;
    files: boolean;
    modules: boolean;
    conceptMap: boolean;
    callGraphV2: boolean;
    behavioralPaths: boolean;
    validationReport: boolean;
}

export interface EvalRunOptions {
    repoPath: string;
    questionsPath: string;
    mode?: EvalMode;
    threshold: number;
    prepare: boolean;
    useExistingArtifacts?: boolean;
    shadowEval?: boolean;
    outputDir?: string;
}

export interface RegressionAlert {
    dimension: string;
    previousScore: number;
    currentScore: number;
}

export interface EvalRunSummary {
    totalQuestions: number;
    threshold: number;
    overallScore: number;
    passed: boolean;
    byType: Record<string, {
        count: number;
        avgLocationAccuracy: number | null;
        avgGrounding: number | null;
        avgHonestUncertainty: number | null;
        avgFlow: number | null;
        avgProvenanceAccuracy: number | null;
        avgStalenessHandling: number | null;
        composite: number;
        avgShadowLocationAccuracy?: number | null;
        avgShadowGrounding?: number | null;
        avgShadowHonestUncertainty?: number | null;
        avgShadowFlow?: number | null;
        avgShadowProvenanceAccuracy?: number | null;
        avgShadowStalenessHandling?: number | null;
        shadowComposite?: number;
    }>;
    weakQuestionTypes: Array<{ type: string; composite: number; likelyCause: string }>;
    regressions: RegressionAlert[];
}

export interface EvalRunResult {
    schemaVersion: '1.0';
    runId: string;
    startedAt: string;
    completedAt: string;
    repoPath: string;
    repoguideDir: string;
    questionsPath: string;
    mode?: EvalMode;
    questionSetName: string;
    datasetVersion?: string;
    targetRepoHint?: string;
    evaluationMode: EvalMode;
    artifactAvailability: ArtifactAvailability;
    healthReport?: UnderstandingHealthReport;
    results: EvalQuestionResult[];
    architectureRegression: ValidationReport;
    summary: EvalRunSummary;
    previousRun?: {
        runId: string;
        overallScore: number;
        delta: number;
    };
}

export interface PipelineQuestionOutput {
    answer: string;
    controlEvents: EvalControlEvents;
    capturedContext: CapturedContext;
    confidence: ConfidenceResult | null;
    rawAnswerContexts: AnswerContext[];
    telemetry?: EvidenceQueryTelemetrySnapshot;
}
