import * as path from 'path';
import {
    CapturedContext,
    EvalQuestionResult,
    EvalScores,
    GoldenQuestion,
    PipelineQuestionOutput
} from './types';
import {
    flowArtifactsContainExpectedPath,
    FlowArtifactState
} from './flowArtifactInspector';

const UNCERTAINTY_PATTERNS = [
    /\bnot enough\b/i,
    /\bdo not have enough\b/i,
    /\bdon't have enough\b/i,
    /\bcannot determine\b/i,
    /\bcan't determine\b/i,
    /\bunclear\b/i,
    /\bnot clear\b/i,
    /\bnot present\b/i,
    /\bnot in (?:the )?(?:provided|indexed|retrieved) context\b/i,
    /\bno evidence\b/i,
    /\bnot found\b/i,
    /\bI can't verify\b/i,
    /\bI cannot verify\b/i,
    /\bdoes not (?:directly )?(?:implement|provide|support|use|handle)\b/i,
    /\bdoesn't (?:directly )?(?:implement|provide|support|use|handle)\b/i,
    /\bnot natively supported\b/i,
    /\bnot (?:natively )?supported\b/i,
    /\bdoes not have built-?in support\b/i,
    /\bno built-?in support\b/i,
    /\bnot built (?:in|into)\b/i,
    /\bnot something built into\b/i
];

export interface ScoreQuestionInput {
    question: GoldenQuestion;
    output: PipelineQuestionOutput;
    shadowOutput?: PipelineQuestionOutput;
    flowArtifacts: FlowArtifactState;
    workspaceRoot: string;
}

export function scoreQuestion(input: ScoreQuestionInput): EvalQuestionResult {
    const notes: string[] = [];
    const { question, output, shadowOutput, flowArtifacts, workspaceRoot } = input;
    const locationAccuracy = scoreLocationAccuracy(question, output, workspaceRoot, notes);
    const grounding = scoreGrounding(question, output, workspaceRoot, notes);
    const honestUncertainty = scoreHonestUncertainty(question, output.answer, notes);
    const flow = scoreFlow(question, output.answer, flowArtifacts, workspaceRoot, notes);
    const provenanceAccuracy = null; // Manual review required
    const stalenessHandling = scoreStalenessHandling(question, output, notes);

    const scores: EvalScores = {
        locationAccuracy,
        grounding,
        honestUncertainty,
        flow,
        provenanceAccuracy,
        stalenessHandling
    };

    let shadowScores: EvalScores | undefined = undefined;
    let shadowNotes: string[] | undefined = undefined;
    if (shadowOutput) {
        const sNotes: string[] = [];
        shadowScores = {
            locationAccuracy: scoreLocationAccuracy(question, shadowOutput, workspaceRoot, sNotes),
            grounding: scoreGrounding(question, shadowOutput, workspaceRoot, sNotes),
            honestUncertainty: scoreHonestUncertainty(question, shadowOutput.answer, sNotes),
            flow: scoreFlow(question, shadowOutput.answer, flowArtifacts, workspaceRoot, sNotes),
            provenanceAccuracy: null,
            stalenessHandling: scoreStalenessHandling(question, shadowOutput, sNotes)
        };
        shadowNotes = sNotes;
    }

    return {
        id: question.id,
        type: question.type,
        question: question.question,
        expectedAnswer: question.expectedAnswer,
        answer: output.answer,
        controlEvents: output.controlEvents,
        capturedContext: output.capturedContext,
        confidence: output.confidence,
        scores,
        shadowScores,
        shadowAnswer: shadowOutput?.answer,
        shadowControlEvents: shadowOutput?.controlEvents,
        shadowCapturedContext: shadowOutput?.capturedContext,
        telemetry: output.telemetry,
        shadowTelemetry: shadowOutput?.telemetry,
        shadowNotes,
        notes
    };
}

function scoreLocationAccuracy(
    question: GoldenQuestion,
    output: PipelineQuestionOutput,
    workspaceRoot: string,
    notes: string[]
): 0 | 1 | null {
    if (!question.requiresLocations) {
        return null;
    }

    const expected = question.expectedLocations ?? [];
    if (expected.length === 0) {
        notes.push('Question requires locations but has no expected locations.');
        return 0;
    }

    const haystack = buildLocationHaystack(output, workspaceRoot);
    const match = expected.some(location => {
        const fileMatched = haystack.includes(normalizePath(location.filePath, workspaceRoot));
        const symbolMatched = !location.symbolName ||
            haystack.includes(location.symbolName.toLowerCase()) ||
            output.answer.toLowerCase().includes(location.symbolName.toLowerCase());
        return fileMatched && symbolMatched;
    });

    if (!match) {
        notes.push('Expected location was not found in navigation, citations, retrieved context, or answer text.');
    }

    return match ? 1 : 0;
}

function scoreGrounding(
    question: GoldenQuestion,
    output: PipelineQuestionOutput,
    workspaceRoot: string,
    notes: string[]
): 0 | 1 | 2 {
    const context = output.capturedContext;
    const hasRetrievedContext =
        context.retrievedChunkIds.length > 0 ||
        context.retrievedArtifacts.length > 0 ||
        context.topCitedFiles.length > 0 ||
        context.citedFiles.length > 0;

    if (question.type === 'uncertainty') {
        return UNCERTAINTY_PATTERNS.some(pattern => pattern.test(output.answer)) ? 2 : 1;
    }

    if (!hasRetrievedContext && question.type !== 'explanation' && question.type !== 'orientation') {
        notes.push('No retrieved chunks or artifacts were captured for this answer.');
        return 0;
    }

    const expectedFiles = [
        ...(question.expectedLocations ?? []).map(location => location.filePath),
        ...(question.expectedFlow?.files ?? []),
        ...(question.type === 'explanation' && question.snippet ? [question.snippet.filePath] : [])
    ];
    if (expectedFiles.length === 0) {
        return scoreExpectedAnswerCoverage(question, output.answer, hasRetrievedContext, notes);
    }

    const locationHaystack = buildLocationHaystack(output, workspaceRoot);
    const expectedHits = expectedFiles.filter(file =>
        locationHaystack.includes(normalizePath(file, workspaceRoot)) ||
        output.answer.toLowerCase().includes(path.basename(file).toLowerCase())
    );

    if (expectedHits.length === expectedFiles.length) {
        return 2;
    }
    if (expectedHits.length > 0) {
        notes.push(`Partial grounding: ${expectedHits.length}/${expectedFiles.length} expected files surfaced.`);
        return 1;
    }

    notes.push('Retrieved context exists, but expected evidence files were not surfaced.');
    return 1;
}

function scoreExpectedAnswerCoverage(
    question: GoldenQuestion,
    answer: string,
    hasRetrievedContext: boolean,
    notes: string[]
): 0 | 1 | 2 {
    if (question.type !== 'orientation' && question.type !== 'explanation') {
        return hasRetrievedContext ? 1 : 0;
    }

    const expectedTerms = significantTerms(question.expectedAnswer);
    if (expectedTerms.length === 0) {
        return hasRetrievedContext ? 1 : 0;
    }

    const answerTerms = new Set(significantTerms(answer));
    const hits = expectedTerms.filter(term => answerTerms.has(term));
    const coverage = hits.length / expectedTerms.length;

    if (coverage >= 0.5) {
        return 2;
    }
    if (coverage >= 0.3) {
        notes.push(`Expected-answer coverage was partial: ${hits.length}/${expectedTerms.length} key terms matched.`);
        return 1;
    }

    notes.push(`Expected-answer coverage was weak: ${hits.length}/${expectedTerms.length} key terms matched.`);
    return hasRetrievedContext ? 1 : 0;
}

const STOP_TERMS = new Set([
    'the', 'and', 'that', 'with', 'from', 'this', 'into', 'they', 'then', 'than',
    'does', 'what', 'when', 'where', 'which', 'why', 'how', 'used', 'uses',
    'using', 'given', 'before', 'after', 'within', 'without', 'specific',
    'function', 'functions', 'file', 'files', 'defined', 'located'
]);

function significantTerms(text: string): string[] {
    const normalized = text
        .replace(/`([^`]+)`/g, ' $1 ')
        .toLowerCase()
        .replace(/[^a-z0-9_./-]+/g, ' ');
    const terms = normalized
        .split(/\s+/)
        .map(term => stemTerm(normalizeVerbInflection(term.trim())))
        .filter(term => term.length >= 4 && !STOP_TERMS.has(term));
    return Array.from(new Set(terms));
}

function normalizeVerbInflection(term: string): string {
    let t = term;
    
    // -tion and -sion mapping to base form
    if (t.endsWith('tion')) {
        t = t.slice(0, -3);
    } else if (t.endsWith('sion')) {
        t = t.slice(0, -4) + 'd';
    }
    
    // -ing
    if (t.endsWith('ing')) {
        const stem = t.slice(0, -3);
        if (stem.length >= 4) t = stem;
    }
    // -ed
    else if (t.endsWith('ed')) {
        const stem = t.slice(0, -2);
        if (stem.length >= 4) t = stem;
    }
    // -s
    else if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('is') && !t.endsWith('us')) {
        if (t.endsWith('es') && !t.endsWith('sses')) {
            const stem = t.slice(0, -2);
            if (stem.length >= 4) t = stem;
            else {
                const stemS = t.slice(0, -1);
                if (stemS.length >= 4) t = stemS;
            }
        } else {
            const stem = t.slice(0, -1);
            if (stem.length >= 4) t = stem;
        }
    }

    // unify trailing 'e'
    if (t.endsWith('e') && t.length >= 5) {
        t = t.slice(0, -1);
    }
    
    // unify double consonants
    if (t.length >= 4 && t[t.length-1] === t[t.length-2]) {
        t = t.slice(0, -1);
    }

    return t;
}

function stemTerm(term: string): string {
    return term
        .replace(/(?:ing|ations|ation|ments|ment|ers|ors|ies|s)$/i, suffix => {
            if (suffix.toLowerCase() === 'ies') {
                return 'y';
            }
            return '';
        });
}

function scoreHonestUncertainty(
    question: GoldenQuestion,
    answer: string,
    notes: string[]
): 0 | 1 | null {
    if (question.type !== 'uncertainty') {
        return null;
    }

    const lower = answer.toLowerCase();
    const forbiddenClaims = question.uncertaintyExpectation?.forbiddenConfidentClaims ?? [];
    const madeForbiddenClaim = forbiddenClaims.some(claim => containsForbiddenConfidentClaim(lower, claim));
    const admitsUncertainty = UNCERTAINTY_PATTERNS.some(pattern => pattern.test(answer));

    if (madeForbiddenClaim) {
        notes.push('Answer contains a forbidden confident claim for an uncertainty question.');
    }
    if (!admitsUncertainty) {
        notes.push('Answer did not clearly admit uncertainty.');
    }

    return admitsUncertainty && !madeForbiddenClaim ? 1 : 0;
}

function containsForbiddenConfidentClaim(answerLower: string, rawClaim: string): boolean {
    const claim = rawClaim.toLowerCase().trim();
    if (!claim) {
        return false;
    }

    let index = answerLower.indexOf(claim);
    while (index >= 0) {
        const windowStart = Math.max(0, index - 90);
        const windowEnd = Math.min(answerLower.length, index + claim.length + 90);
        const window = answerLower.slice(windowStart, windowEnd);

        if (isNegatedOrHypothetical(window)) {
            index = answerLower.indexOf(claim, index + claim.length);
            continue;
        }

        return true;
    }

    return false;
}

function isNegatedOrHypothetical(window: string): boolean {
    return /\b(?:does not|doesn't|do not|don't|did not|not|no)\b.{0,80}\b(?:implement|provide|support|use|handle|involve|include|mention|detail|describe|directly|built|evidence|found|information)\b/.test(window) ||
        /\b(?:no|not any|without)\b.{0,80}\b(?:information|details?|evidence|context)\b/.test(window) ||
        /\b(?:custom|example|you can|you could|typically|would|might|outside|separately|instead)\b/.test(window);
}

const STALENESS_PATTERNS = [
    /\bstale\b/i,
    /\bdirty\b/i,
    /\boutdated\b/i,
    /\bout of date\b/i,
    /\bmay not reflect\b/i,
    /\bmight not reflect\b/i,
    /\brecently modified\b/i,
    /\brecently changed\b/i,
    /\bwas recently modified\b/i,
    /\bwas recently changed\b/i,
    /\bmight be outdated\b/i,
    /\bmay be outdated\b/i,
    /\bnot (?:been )?reindex/i,
    /\bartifacts? (?:may|might|could) (?:be )?(?:stale|outdated|incomplete)/i,
    /\brebuild\b.*\bindex\b/i,
    /\bindex\b.*\brebuild\b/i,
    /\bnot up to date\b/i,
    /\bmay not describe\b.*\b(?:the execution|the path|accurately)\b/i,
    /\banswer may not (?:be accurate|reflect)\b/i,
    /\brel(?:ies|y) on code search (?:only|alone)\b/i,
    /\bflow trace (?:not available|unavailable|missing)\b/i,
    /\bno flow trace\b/i,
    /\bartifacts? (?:are|were) deleted\b/i,
    /\bafter (?:deleting|removing) (?:the|those) (?:files|artifacts)\b/i,
    /\bindex (?:has not|hasn't) been (?:rebuilt|updated|rerun)\b/i
];

function scoreStalenessHandling(
    question: GoldenQuestion,
    output: PipelineQuestionOutput,
    notes: string[]
): 0 | 1 | null {
    if (question.type !== 'staleness') {
        return null;
    }

    const stalenessHaystack = [
        output.answer,
        ...(output.controlEvents.healthCaveats ?? []).map(caveat => JSON.stringify(caveat))
    ].join('\n');
    const containsStaleCaveat = STALENESS_PATTERNS.some(pattern => pattern.test(stalenessHaystack));

    if (!containsStaleCaveat) {
        notes.push('Staleness question: answer responded with full confidence and did not include a staleness caveat.');
        return 0;
    }

    notes.push('Staleness question: answer correctly included a staleness caveat.');
    return 1;
}

function scoreFlow(
    question: GoldenQuestion,
    answer: string,
    flowArtifacts: FlowArtifactState,
    workspaceRoot: string,
    notes: string[]
): 0 | 1 | 2 | null {
    if (question.type !== 'flow') {
        return null;
    }

    const expected = question.expectedFlow;
    if (!expected) {
        notes.push('Flow question has no expected flow.');
        return 0;
    }

    const artifactScore = flowArtifactsContainExpectedPath(
        flowArtifacts,
        expected.files,
        expected.symbols,
        workspaceRoot
    );
    notes.push(...artifactScore.notes);

    if (artifactScore.score === 0) {
        return 0;
    }

    const answerLower = answer.toLowerCase();
    const answerFileHits = expected.files.filter(file =>
        answerLower.includes(path.basename(file).toLowerCase()) ||
        answerLower.includes(normalizePath(file, workspaceRoot))
    );
    const answerSymbolHits = expected.symbols.filter(symbol =>
        answerLower.includes(symbol.toLowerCase())
    );
    const expectedCount = expected.files.length + expected.symbols.length;
    const answerHits = answerFileHits.length + answerSymbolHits.length;

    if (expectedCount > 0 && answerHits === 0) {
        notes.push('Flow artifacts partially exist, but answer did not describe expected flow evidence.');
        return 1;
    }

    return artifactScore.score;
}

function buildLocationHaystack(output: PipelineQuestionOutput, workspaceRoot: string): string {
    const values: string[] = [];
    values.push(output.answer);
    values.push(...output.capturedContext.topCitedFiles);
    values.push(...output.capturedContext.citedFiles);
    values.push(...output.capturedContext.retrievedArtifacts.map(artifact => artifact.id));

    for (const nav of output.controlEvents.navigationResults) {
        values.push(JSON.stringify(nav));
    }

    return values
        .map(value => normalizePath(value, workspaceRoot))
        .join('\n');
}

function normalizePath(value: string, workspaceRoot: string): string {
    const normalized = value.replace(/\\/g, '/').toLowerCase();
    const root = workspaceRoot.replace(/\\/g, '/').toLowerCase();
    return normalized.startsWith(root + '/')
        ? normalized.slice(root.length + 1)
        : normalized;
}

export function emptyCapturedContext(): CapturedContext {
    return {
        retrievedChunkIds: [],
        retrievedArtifacts: [],
        topCitedFiles: [],
        citedFiles: []
    };
}
