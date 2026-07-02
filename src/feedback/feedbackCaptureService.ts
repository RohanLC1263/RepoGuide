import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export type FeedbackEventType =
    | 'explicit_negative'
    | 'corrective_followup'
    | 'navigation_divergence'
    | 'cited_nonexistent_file';

export interface RetrievedArtifactRef {
    source: string;
    id: string;
}

export interface FeedbackEvent {
    id: string;
    timestamp: string;
    sessionId: string;
    queryId: string;
    eventType: FeedbackEventType;
    query: string;
    answerId: string;
    correctionText: string | null;
    navigatedToFile: string | null;
    nonexistentPath: string | null;
    retrievedChunkIds: string[];
    retrievedArtifacts: RetrievedArtifactRef[];
    topCitedFiles: string[];
}

export interface AnswerContext {
    sessionId: string;
    queryId: string;
    answerId: string;
    queryText: string;
    timestamp?: number;
    retrievedChunkIds?: string[];
    retrievedArtifacts?: RetrievedArtifactRef[];
    topCitedFiles?: string[];
    citedFiles?: string[];
}

interface StoredAnswerContext {
    sessionId: string;
    queryId: string;
    answerId: string;
    queryText: string;
    timestamp: number;
    retrievedChunkIds: string[];
    retrievedArtifacts: RetrievedArtifactRef[];
    topCitedFiles: string[];
    citedFiles: string[];
    divergenceLogged: boolean;
}

const CORRECTIVE_FOLLOW_UP_PATTERNS = [
    "that's wrong",
    'incorrect',
    'not right',
    "you're wrong",
    'wrong file',
    "that's not",
    "actually it's",
    'actually it is',
    'no, it',
    'that is not correct'
];

const NAVIGATION_WINDOW_MS = 30_000;

export class FeedbackCaptureService {
    private readonly feedbackDir: string;
    private readonly logFile: string;
    private readonly answersById = new Map<string, StoredAnswerContext>();
    private readonly latestAnswerBySession = new Map<string, StoredAnswerContext>();
    private lexicalMapCache: Set<string> | null = null;
    private readonly disposable: vscode.Disposable;

    constructor(
        private readonly workspaceRoot: string,
        private readonly understandingDir: string,
        private readonly outputChannel?: { appendLine(msg: string): void }
    ) {
        this.feedbackDir = path.join(workspaceRoot, '.repoguide', 'feedback');
        this.logFile = path.join(this.feedbackDir, 'feedback_events.jsonl');
        fs.mkdirSync(this.feedbackDir, { recursive: true });

        this.disposable = vscode.workspace.onDidOpenTextDocument(doc => {
            this.handleNavigation(doc);
        });
    }

    public dispose(): void {
        this.disposable.dispose();
    }

    public registerAnswer(context: AnswerContext): void {
        const stored: StoredAnswerContext = {
            sessionId: context.sessionId,
            queryId: context.queryId,
            answerId: context.answerId,
            queryText: context.queryText,
            timestamp: context.timestamp ?? Date.now(),
            retrievedChunkIds: context.retrievedChunkIds ?? [],
            retrievedArtifacts: context.retrievedArtifacts ?? [],
            topCitedFiles: normalizeFileList(context.topCitedFiles ?? []),
            citedFiles: normalizeFileList(context.citedFiles ?? []),
            divergenceLogged: false
        };

        this.answersById.set(stored.answerId, stored);
        this.answersById.set(stored.queryId, stored);
        this.latestAnswerBySession.set(stored.sessionId, stored);
        this.pruneOldAnswers();

        this.detectCitedNonexistentFiles(stored);
    }

    public logExplicitNegative(queryId: string, answerId: string, sessionId: string): void {
        const context = this.findAnswer(sessionId, queryId, answerId);
        this.appendEventFromContext(context, {
            eventType: 'explicit_negative',
            sessionId,
            queryId,
            answerId,
            correctionText: null,
            navigatedToFile: null,
            nonexistentPath: null
        });
    }

    public checkFollowUpQuery(queryText: string, sessionId: string, _newQueryId?: string): void {
        this.detectCorrectiveFollowUp(queryText, sessionId);
    }

    public detectCorrectiveFollowUp(messageText: string, sessionId: string): boolean {
        const context = this.latestAnswerBySession.get(sessionId);
        if (!context) {
            return false;
        }

        const lower = messageText.toLowerCase();
        if (!CORRECTIVE_FOLLOW_UP_PATTERNS.some(pattern => lower.includes(pattern))) {
            return false;
        }

        this.appendEventFromContext(context, {
            eventType: 'corrective_followup',
            correctionText: truncate(messageText, 200),
            navigatedToFile: null,
            nonexistentPath: null
        });
        return true;
    }

    public getRecentNegatives(hours: number): FeedbackEvent[] {
        if (!fs.existsSync(this.logFile)) {
            return [];
        }

        const cutoff = Date.now() - Math.max(0, hours) * 60 * 60 * 1000;
        const events: FeedbackEvent[] = [];

        try {
            const lines = fs.readFileSync(this.logFile, 'utf8').split(/\r?\n/);
            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }
                try {
                    const event = JSON.parse(line) as FeedbackEvent;
                    if (new Date(event.timestamp).getTime() >= cutoff) {
                        events.push(event);
                    }
                } catch {
                    continue;
                }
            }
        } catch (error) {
            this.outputChannel?.appendLine(`[Warn] FeedbackCapture: failed to read feedback events: ${String(error)}`);
        }

        return events;
    }

    public getFeedbackFilePath(): string {
        return this.logFile;
    }

    private handleNavigation(doc: vscode.TextDocument): void {
        if (doc.uri.scheme !== 'file') {
            return;
        }

        const navigatedPath = normalizePath(path.relative(this.workspaceRoot, doc.uri.fsPath));
        if (!navigatedPath || navigatedPath.startsWith('..') || navigatedPath.startsWith('.repoguide/')) {
            return;
        }

        for (const context of this.latestAnswerBySession.values()) {
            if (context.divergenceLogged) {
                continue;
            }
            if (Date.now() - context.timestamp > NAVIGATION_WINDOW_MS) {
                continue;
            }
            if (!this.detectNavigationDivergence(context, navigatedPath)) {
                continue;
            }

            this.appendEventFromContext(context, {
                eventType: 'navigation_divergence',
                correctionText: null,
                navigatedToFile: navigatedPath,
                nonexistentPath: null
            });
            context.divergenceLogged = true;
            return;
        }
    }

    private detectNavigationDivergence(context: StoredAnswerContext, navigatedPath: string): boolean {
        const top3 = context.topCitedFiles.slice(0, 3);
        if (top3.length === 0) {
            return true;
        }

        return !top3.some(citedFile => pathsReferToSameFile(citedFile, navigatedPath));
    }

    private detectCitedNonexistentFiles(context: StoredAnswerContext): void {
        const lexicalFiles = this.getLexicalMapFiles();
        if (lexicalFiles.size === 0) {
            return;
        }

        const answerCitedFiles = context.citedFiles.length > 0 ? context.citedFiles : context.topCitedFiles;
        for (const citedFile of answerCitedFiles) {
            if (!lexicalFiles.has(normalizeForLexicalMap(citedFile, this.workspaceRoot))) {
                this.appendEventFromContext(context, {
                    eventType: 'cited_nonexistent_file',
                    correctionText: null,
                    navigatedToFile: null,
                    nonexistentPath: citedFile
                });
            }
        }
    }

    private findAnswer(sessionId: string, queryId?: string, answerId?: string): StoredAnswerContext | undefined {
        if (answerId && this.answersById.has(answerId)) {
            return this.answersById.get(answerId);
        }
        if (queryId && this.answersById.has(queryId)) {
            return this.answersById.get(queryId);
        }
        return this.latestAnswerBySession.get(sessionId);
    }

    private appendEventFromContext(
        context: StoredAnswerContext | undefined,
        eventData: Pick<FeedbackEvent, 'eventType' | 'correctionText' | 'navigatedToFile' | 'nonexistentPath'> &
            Partial<Pick<FeedbackEvent, 'sessionId' | 'queryId' | 'answerId'>>
    ): void {
        const event: FeedbackEvent = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            sessionId: eventData.sessionId ?? context?.sessionId ?? 'unknown',
            queryId: eventData.queryId ?? context?.queryId ?? 'unknown',
            eventType: eventData.eventType,
            query: truncate(context?.queryText ?? '', 200),
            answerId: eventData.answerId ?? context?.answerId ?? 'unknown',
            correctionText: eventData.correctionText,
            navigatedToFile: eventData.navigatedToFile,
            nonexistentPath: eventData.nonexistentPath,
            retrievedChunkIds: context?.retrievedChunkIds ?? [],
            retrievedArtifacts: context?.retrievedArtifacts ?? [],
            topCitedFiles: context?.topCitedFiles ?? []
        };

        try {
            fs.appendFileSync(this.logFile, `${JSON.stringify(event)}\n`, 'utf8');
            this.outputChannel?.appendLine(`[Info] FeedbackCapture: captured ${event.eventType}`);
        } catch (error) {
            this.outputChannel?.appendLine(`[Warn] FeedbackCapture: failed to append event: ${String(error)}`);
        }
    }

    private getLexicalMapFiles(): Set<string> {
        if (this.lexicalMapCache) {
            return this.lexicalMapCache;
        }

        const files = new Set<string>();
        const lexicalMapPath = path.join(this.understandingDir, 'lexical_map.json');
        if (!fs.existsSync(lexicalMapPath)) {
            this.lexicalMapCache = files;
            return files;
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(lexicalMapPath, 'utf8')) as {
                files?: Record<string, unknown>;
                data?: { files?: Record<string, unknown> };
            };
            const mapFiles = parsed.files ?? parsed.data?.files ?? {};
            for (const filePath of Object.keys(mapFiles)) {
                files.add(normalizeForLexicalMap(filePath, this.workspaceRoot));
            }
        } catch (error) {
            this.outputChannel?.appendLine(`[Warn] FeedbackCapture: failed to load lexical map: ${String(error)}`);
        }

        this.lexicalMapCache = files;
        return files;
    }

    private pruneOldAnswers(): void {
        const cutoff = Date.now() - NAVIGATION_WINDOW_MS * 2;
        for (const [key, context] of this.answersById.entries()) {
            if (context.timestamp < cutoff) {
                this.answersById.delete(key);
            }
        }
    }
}

function truncate(text: string, maxLen: number): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length <= maxLen ? normalized : normalized.slice(0, maxLen);
}

function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeFileList(files: string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const file of files) {
        const value = normalizePath(file);
        if (!value || seen.has(value)) {
            continue;
        }
        seen.add(value);
        normalized.push(value);
    }
    return normalized;
}

function normalizeForLexicalMap(filePath: string, workspaceRoot: string): string {
    const rel = path.isAbsolute(filePath) ? path.relative(workspaceRoot, filePath) : filePath;
    return normalizePath(path.normalize(rel));
}

function pathsReferToSameFile(left: string, right: string): boolean {
    const a = normalizePath(left).toLowerCase();
    const b = normalizePath(right).toLowerCase();
    return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}
