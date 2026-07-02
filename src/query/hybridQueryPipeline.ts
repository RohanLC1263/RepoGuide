import { Bm25Store } from '../store/bm25Store';
import { LanceStore } from '../store/lanceStore';
import { SymbolIndex } from '../indexing/symbolIndex';
import { IntentClassifier } from './intentClassifier';
import { ConversationHistory } from './conversationHistory';
import { HybridRetrievalFusion } from './hybridRetrievalFusion';
import { FeedbackCaptureService } from '../feedback/feedbackCaptureService';
import { CapturedContext } from '../evaluation/types';
import { parseAllLocations } from './responseParser';
import { ConfidenceResult } from './confidenceScorer';
import { ImportGraphSearcher } from '../comprehension/importGraphSearcher';
import { ComprehensionEngine } from '../comprehension/comprehensionEngine';
import { AnswerMetadata, ExplainSelectionBackendResult } from './answerMetadata';
import { NotesManager } from '../notes/notesManager';
import { RepositoryContext } from '../context/repositoryContext';

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
    explainSelectionResult?(
        filePath: string,
        selectedText: string,
        startLine: number,
        endLine: number,
        language: string,
        abortSignal?: AbortSignal,
        question?: string
    ): Promise<ExplainSelectionBackendResult>;
}

export class HybridQueryPipeline implements ChatPipeline {
    private readonly fusion: HybridRetrievalFusion;
    private readonly feedbackSessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    constructor(
        store: LanceStore,
        bm25Store: Bm25Store,
        repoguideDir: string,
        workspaceRoot: string,
        intentClassifier: IntentClassifier,
        private readonly history: ConversationHistory,
        private context: RepositoryContext,
        symbolIndex?: SymbolIndex,
        importGraphSearcher?: ImportGraphSearcher,
        comprehensionEngine?: ComprehensionEngine,
        private readonly feedbackCaptureService?: FeedbackCaptureService,
        notesManager?: NotesManager
    ) {
        this.fusion = new HybridRetrievalFusion(
            store,
            bm25Store,
            repoguideDir,
            workspaceRoot,
            intentClassifier,
            context,
            symbolIndex,
            importGraphSearcher,
            comprehensionEngine,
            history,
            notesManager
        );
    }

    async *query(
        question: string,
        abortSignal?: AbortSignal,
        onConfidence?: (confidence: ConfidenceResult) => Promise<void> | void
    ): AsyncGenerator<string> {
        const queryId = buildFeedbackId('query');
        const answerId = buildFeedbackId('answer');
        this.feedbackCaptureService?.detectCorrectiveFollowUp(question, this.feedbackSessionId);

        yield JSON.stringify({
            __type: 'feedbackContext',
            sessionId: this.feedbackSessionId,
            queryId,
            answerId
        });

        await onConfidence?.({
            level: 'medium',
            topFiles: [],
            topFilePaths: [],
            chunkCount: 0,
            avgScore: 0.7,
            explanation: 'Hybrid retrieval fusion is the active query pipeline.'
        });

        let answer = '';
        let capturedContext: CapturedContext | undefined;
        let answerMetadata: AnswerMetadata | undefined;
        for await (const token of this.fusion.query(question, [], [], { answerId })) {
            throwIfAborted(abortSignal);
            const parsedMetadata = parseAnswerMetadataToken(token);
            if (parsedMetadata) {
                answerMetadata = parsedMetadata;
                yield token;
                continue;
            }
            if (parseAnswerProvenanceToken(token)) {
                yield token;
                continue;
            }
            const parsedContext = parseCapturedContextToken(token);
            if (parsedContext) {
                capturedContext = parsedContext;
                continue;
            }
            answer += token;
            yield token;
        }

        this.history.add('user', question);
        this.history.add('assistant', answer);
        this.registerAnswer(question, queryId, answerId, answer, capturedContext);
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
        const queryText = question ?? `Explain selected code in ${filePath}`;
        const queryId = buildFeedbackId('query');
        const answerId = buildFeedbackId('answer');
        this.feedbackCaptureService?.detectCorrectiveFollowUp(queryText, this.feedbackSessionId);

        let answer = '';
        let capturedContext: CapturedContext | undefined;
        let answerMetadata: AnswerMetadata | undefined;
        for await (const token of this.fusion.explainSelection(
            filePath,
            selectedText,
            startLine,
            endLine,
            language,
            question
        )) {
            throwIfAborted(abortSignal);
            const parsedMetadata = parseAnswerMetadataToken(token);
            if (parsedMetadata) {
                answerMetadata = parsedMetadata;
                yield token;
                continue;
            }
            if (parseAnswerProvenanceToken(token)) {
                yield token;
                continue;
            }
            const parsedContext = parseCapturedContextToken(token);
            if (parsedContext) {
                capturedContext = parsedContext;
                continue;
            }
            answer += token;
            yield token;
        }

        this.history.add('user', queryText);
        this.history.add('assistant', answer);
        this.registerAnswer(queryText, queryId, answerId, answer, capturedContext);
    }

    async explainSelectionResult(
        filePath: string,
        selectedText: string,
        startLine: number,
        endLine: number,
        language: string,
        abortSignal?: AbortSignal,
        question?: string
    ): Promise<ExplainSelectionBackendResult> {
        let answer = '';
        let metadata: AnswerMetadata | undefined;
        for await (const token of this.explainSelection(
            filePath,
            selectedText,
            startLine,
            endLine,
            language,
            abortSignal,
            question
        )) {
            const parsedMetadata = parseAnswerMetadataToken(token);
            if (parsedMetadata) {
                metadata = parsedMetadata;
                continue;
            }
            if (parseAnswerProvenanceToken(token)) {
                continue;
            }
            if (parseCapturedContextToken(token)) {
                continue;
            }
            answer += token;
        }

        const sourceMetadata = metadata ?? {
            schema: 'repoguide.answer_metadata.v1' as const,
            mode: 'standard' as const,
            question: question ?? `Explain selected code in ${filePath}`,
            file_references: [{
                file: filePath,
                line_start: startLine,
                line_end: endLine,
                reason: 'Selected code range.',
                source: 'retrieval' as const
            }]
        };

        return {
            answer,
            selected_file: filePath,
            selected_line_start: startLine,
            selected_line_end: endLine,
            related_files: sourceMetadata.file_references.filter(ref => ref.file !== filePath),
            source_metadata: sourceMetadata,
            uncertainty_notes: extractUncertaintyNotes(answer)
        };
    }

    private registerAnswer(
        queryText: string,
        queryId: string,
        answerId: string,
        answer: string,
        capturedContext?: CapturedContext
    ): void {
        const locations = parseAllLocations(answer);
        this.feedbackCaptureService?.registerAnswer({
            sessionId: this.feedbackSessionId,
            queryId,
            answerId,
            queryText,
            timestamp: Date.now(),
            retrievedChunkIds: capturedContext?.retrievedChunkIds ?? [],
            retrievedArtifacts: capturedContext?.retrievedArtifacts ?? [],
            topCitedFiles: capturedContext?.topCitedFiles ?? [],
            citedFiles: capturedContext?.citedFiles ?? locations.map(location => location.filePath)
        });
    }
}

function parseCapturedContextToken(token: string): CapturedContext | undefined {
    const trimmed = token.trim();
    if (!trimmed.startsWith('{"__type":"shadowContext"')) {
        return undefined;
    }
    try {
        return JSON.parse(trimmed).context as CapturedContext;
    } catch {
        return undefined;
    }
}

function parseAnswerMetadataToken(token: string): AnswerMetadata | undefined {
    const trimmed = token.trim();
    if (!trimmed.startsWith('{"__type":"answerMetadata"')) {
        return undefined;
    }
    try {
        return JSON.parse(trimmed).metadata as AnswerMetadata;
    } catch {
        return undefined;
    }
}

function parseAnswerProvenanceToken(token: string): unknown | undefined {
    const trimmed = token.trim();
    if (!trimmed.startsWith('{"__type":"answerProvenance"')) {
        return undefined;
    }
    try {
        return JSON.parse(trimmed).provenance;
    } catch {
        return undefined;
    }
}

function extractUncertaintyNotes(answer: string): string[] {
    return answer
        .split(/\n+/)
        .map(line => line.trim())
        .filter(line => /\b(unclear|cannot|not clear|not certain|no evidence|stale|runtime|dynamic)\b/i.test(line))
        .slice(0, 5);
}

function throwIfAborted(abortSignal?: AbortSignal): void {
    if (!abortSignal?.aborted) {
        return;
    }
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    throw error;
}

function buildFeedbackId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
