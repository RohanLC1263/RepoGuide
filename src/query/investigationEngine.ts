import { RepositoryContext, Logger } from '../context/repositoryContext';

import * as path from 'path';
import { streamChat } from '../ollama/inferencer';
import { AnnotationSignal } from '../comprehension/fileAnnotationEngine';
import { CodeChunk } from '../store/storeTypes';
import { HybridRetrievalFusion } from './hybridRetrievalFusion';
import { ErrorAnchor, preprocessError, PreprocessedError } from './errorPreprocessor';
import { TerminalErrorRecord } from '../watchers/terminalErrorService';
import { ExecutionPlanner, PlanningRequest } from './executionPlanner';
import { RetrievalOrchestrator } from './retrievalOrchestrator';
import { EvidenceItem, EvidencePacket } from './evidencePacket';
import { AnswerGate } from './answerGate';
import { NormalizedEvidenceItem } from './normalizedEvidence';
import { getProfile } from '../config/performanceConfig';

export interface InvestigationPath {
    id: string;
    label: string;
    query: string;
    preferredSignals: AnnotationSignal[];
    retrievedFiles: string[];
    retrievedChunkIds: string[];
    matchedAnnotationSignals: AnnotationSignal[];
}

export interface InvestigationHypothesis {
    title: string;
    confidence: 'high' | 'medium' | 'low';
    evidenceFiles: string[];
    reasoning: string;
    nextChecks: string[];
}

export interface InvestigationEvidenceItem {
    id: string;
    file?: string;
    line_start?: number;
    line_end?: number;
    excerpt: string;
    why_it_matters: string;
    source: 'direct_file_anchor' | 'bm25_error_search' | 'symbol_anchor' | 'package_config' | 'annotation' | 'hybrid_retrieval';
}

export interface StructuredHypothesis {
    text: string;
    confidence: number;
    evidence_ids: string[];
}

export interface AlternativeHypothesis {
    text: string;
    likelihood: number;
    evidence_ids: string[];
    reasoning: string;
}

export interface TerminalInvestigationInput {
    problem_description?: string;
    terminal_output?: string;
    cwd?: string;
    terminal_error?: TerminalErrorRecord;
}

export interface InvestigationReport {
    problem: string;
    terminal_error?: TerminalErrorRecord;
    primary_hypothesis: StructuredHypothesis;
    evidence_trail: InvestigationEvidenceItem[];
    alternative_hypotheses: AlternativeHypothesis[];
    cannot_determine: string[];
    next_checks: string[];
    preprocessed_error?: PreprocessedError;
    question: string;
    investigatedAt: string;
    paths: InvestigationPath[];
    hypotheses: InvestigationHypothesis[];
    answer: string;
}

export interface InvestigationOptions {
    maxPaths?: number;
    abortSignal?: AbortSignal;
}

interface PathSpec {
    id: string;
    label: string;
    query: string;
    preferredSignals: AnnotationSignal[];
}

export class InvestigationEngine {
    private readonly answerGate = new AnswerGate();

    constructor(
        private readonly context: RepositoryContext,
        private readonly history: any,
        private readonly intentClassifier: any,
        private readonly hybridRetrieval: HybridRetrievalFusion,
        private readonly executionPlanner: ExecutionPlanner,
        private readonly retrievalOrchestrator: RetrievalOrchestrator,
        private readonly client: PlanningRequest['client'] = 'vscode',
        private readonly terminalErrorService?: any
    ) {}

    async investigate(question: string, options: InvestigationOptions = {}): Promise<InvestigationReport> {
        const pathSpecs = this.buildInvestigationPaths(question).slice(0, options.maxPaths ?? 4);
        const retrieved = await this.retrievePaths(pathSpecs);
        const hypotheses = buildInitialHypotheses(question, retrieved);
        let answer = await this.generateDetectiveReport(question, retrieved, hypotheses, options.abortSignal);

        // Route the final report through AnswerGate before returning. Relaxed policy:
        // the engine's own confidence/likelihood numbers aren't claims about evidence and
        // would spuriously trip numeric checking, but hallucinated file citations in the
        // evidence trail are a real risk and still get checked.
        const gatePacket = buildInvestigationGatePacket(question, retrieved);
        const gateResult = this.answerGate.verify(answer, gatePacket, {
            checkNumericClaims: false,
            checkQuotedStrings: false,
            checkFilePaths: true
        });
        if (gateResult.outcome !== 'pass') {
            answer = gateResult.finalAnswer;
        }

        const evidenceTrail = buildEvidenceTrailFromRetrieved(retrieved);
        const cannotDetermine = extractCannotDetermine(answer);

        return {
            problem: question,
            primary_hypothesis: {
                text: hypotheses[0]?.reasoning ?? 'The top retrieved files are the strongest current hypothesis.',
                confidence: confidenceNumber(hypotheses[0]?.confidence ?? 'low'),
                evidence_ids: evidenceTrail.slice(0, 3).map(item => item.id)
            },
            evidence_trail: evidenceTrail,
            alternative_hypotheses: hypotheses.slice(1).map((hypothesis, index) => ({
                text: hypothesis.title,
                likelihood: confidenceNumber(hypothesis.confidence),
                evidence_ids: evidenceTrail.slice(index + 1, index + 4).map(item => item.id),
                reasoning: hypothesis.reasoning
            })),
            cannot_determine: cannotDetermine,
            next_checks: unique(hypotheses.flatMap(hypothesis => hypothesis.nextChecks)).slice(0, 6),
            question,
            investigatedAt: new Date().toISOString(),
            paths: retrieved.map(item => item.path),
            hypotheses,
            answer
        };
    }

    async investigateTerminal(input: TerminalInvestigationInput, options: InvestigationOptions = {}): Promise<InvestigationReport> {
        const problem = input.problem_description?.trim() ||
            input.terminal_error?.command ||
            'Investigate the terminal error.';
        const terminalOutput = input.terminal_output ?? input.terminal_error?.output ?? '';
        const preprocessed = preprocessError(terminalOutput, problem);
        const evidenceTrail = await this.retrieveTerminalEvidence(preprocessed, input.cwd ?? input.terminal_error?.cwd);
        const compactEvidence = evidenceTrail.slice(0, 12);
        const primary = buildTerminalPrimaryHypothesis(problem, preprocessed, compactEvidence);
        const alternatives = buildTerminalAlternatives(preprocessed, compactEvidence);
        const cannotDetermine = buildTerminalCannotDetermine(preprocessed, compactEvidence, terminalOutput);
        const nextChecks = buildTerminalNextChecks(preprocessed, compactEvidence);
        let answer = formatStructuredInvestigationReport(problem, input.terminal_error, primary, compactEvidence, alternatives, cannotDetermine, nextChecks);

        // Same relaxed AnswerGate policy as investigate(): the report's own confidence
        // percentages aren't evidence claims, but hallucinated file citations still block.
        // formatStructuredInvestigationReport() is deterministic template code with no LLM
        // call, so hallucination risk is low here — but the frozen contract doesn't carve
        // out an exception for deterministic synthesis, and gate validation is cheap.
        const terminalGatePacket = buildTerminalGatePacket(problem, compactEvidence);
        const terminalGateResult = this.answerGate.verify(answer, terminalGatePacket, {
            checkNumericClaims: false,
            checkQuotedStrings: false,
            checkFilePaths: true
        });
        if (terminalGateResult.outcome !== 'pass') {
            answer = terminalGateResult.finalAnswer;
        }

        return {
            problem,
            terminal_error: input.terminal_error,
            primary_hypothesis: primary,
            evidence_trail: compactEvidence,
            alternative_hypotheses: alternatives,
            cannot_determine: cannotDetermine,
            next_checks: nextChecks,
            preprocessed_error: preprocessed,
            question: problem,
            investigatedAt: new Date().toISOString(),
            paths: [{
                id: 'terminal-error',
                label: 'Terminal Error Evidence',
                query: preprocessed.search_queries.join(' | '),
                preferredSignals: preprocessed.preferred_annotation_signals,
                retrievedFiles: unique(compactEvidence.map(item => item.file).filter((file): file is string => !!file)),
                retrievedChunkIds: compactEvidence.map(item => item.id),
                matchedAnnotationSignals: []
            }],
            hypotheses: [{
                title: 'Terminal-grounded primary hypothesis',
                confidence: primary.confidence >= 0.75 ? 'high' : primary.confidence >= 0.5 ? 'medium' : 'low',
                evidenceFiles: unique(compactEvidence.map(item => item.file).filter((file): file is string => !!file)),
                reasoning: primary.text,
                nextChecks
            }],
            answer
        };
    }

    private buildInvestigationPaths(question: string): PathSpec[] {
        const normalized = question.trim();
        const quotedTerms = Array.from(normalized.matchAll(/`([^`]+)`/g)).map(match => match[1]);
        const quotedFocus = quotedTerms.length > 0 ? quotedTerms.join(', ') : normalized;
        const problemSignals = inferProblemSignals(normalized);

        return [
            {
                id: 'direct',
                label: 'Direct Evidence',
                query: normalized,
                preferredSignals: problemSignals
            },
            {
                id: 'entrypoints',
                label: 'Entrypoints And Callers',
                query: `Find entrypoints, callers, and public APIs related to ${quotedFocus}. Original investigation: ${normalized}`,
                preferredSignals: unique<AnnotationSignal>(['external_call', 'async_pattern', ...problemSignals])
            },
            {
                id: 'flow',
                label: 'Execution Flow',
                query: `Trace the execution flow and data handoff for ${quotedFocus}. Original investigation: ${normalized}`,
                preferredSignals: unique<AnnotationSignal>(['mutates_state', 'async_pattern', 'side_effects', ...problemSignals])
            },
            {
                id: 'failure-modes',
                label: 'Failure Modes',
                query: `Find error handling, edge cases, guards, and tests related to ${quotedFocus}. Original investigation: ${normalized}`,
                preferredSignals: unique<AnnotationSignal>(['error_boundary', 'security_sensitive', 'performance_critical', ...problemSignals])
            }
        ];
    }

    private async retrievePaths(pathSpecs: PathSpec[]): Promise<Array<{ path: InvestigationPath; items: EvidenceItem[] }>> {
        const results: Array<{ path: InvestigationPath; items: EvidenceItem[] }> = [];

        for (const spec of pathSpecs) {
            this.context.logger.info(`[Investigation] Retrieving path: ${spec.label}`);
            const items = await this.retrieveViaOrchestrator(spec.query);
            const biasedItems = applyAnnotationSignalBias(items, spec.preferredSignals, this.context.logger);
            const retrievedFiles = unique(
                biasedItems.filter(item => item.type !== 'annotation' && item.type !== 'community_summary').map(item => item.file)
            ).slice(0, 8);
            const retrievedChunkIds = unique(biasedItems.map(item => item.id));
            const matchedAnnotationSignals = unique(
                biasedItems
                    .filter(item => item.type === 'annotation')
                    .flatMap(item => extractAnnotationSignals(item))
                    .filter((signal): signal is AnnotationSignal => spec.preferredSignals.includes(signal as AnnotationSignal))
            );
            results.push({
                path: {
                    id: spec.id,
                    label: spec.label,
                    query: spec.query,
                    preferredSignals: spec.preferredSignals,
                    retrievedFiles,
                    retrievedChunkIds,
                    matchedAnnotationSignals
                },
                items: biasedItems
            });
        }

        return results;
    }

    /** Routes retrieval through the canonical ExecutionPlanner -> RetrievalOrchestrator
     * pipeline instead of calling HybridRetrievalFusion directly — a strict evidence
     * upgrade, since the orchestrator also invokes fact_store/symbol_index/program_graph
     * providers for the same query, not just hybrid_retrieval. */
    private async retrieveViaOrchestrator(query: string): Promise<EvidenceItem[]> {
        const executionPlan = await this.executionPlanner.plan({
            requestId: `investigation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            query,
            client: this.client,
            workspaceRoot: this.context.workspaceRoot,
            repoguideDir: this.context.repoguideDataDir ?? this.context.workspaceRoot,
            mode: 'investigation',
            constraints: { allowLLMPlanning: true }
        }, getProfile().inferenceModel);

        const result = await this.retrievalOrchestrator.execute(executionPlan);
        return result.items;
    }

    private async generateDetectiveReport(
        question: string,
        retrieved: Array<{ path: InvestigationPath; items: EvidenceItem[] }>,
        hypotheses: InvestigationHypothesis[],
        abortSignal?: AbortSignal
    ): Promise<string> {
        const messages = buildInvestigationMessages(question, retrieved, hypotheses);
        let answer = '';
        for await (const token of streamChat(this.context, messages, undefined, abortSignal)) {
            answer += token;
        }
        return ensureRequiredUncertaintySection(answer);
    }

    private async retrieveTerminalEvidence(preprocessed: PreprocessedError, cwd?: string): Promise<InvestigationEvidenceItem[]> {
        const evidence: InvestigationEvidenceItem[] = [];
        const seen = new Set<string>();

        for (const anchor of preprocessed.anchors) {
            if (anchor.type === 'file' || anchor.type === 'test' || anchor.type === 'config' || anchor.type === 'line') {
                const fileValue = anchor.type === 'line' ? anchor.value.split(':').slice(0, -1).join(':') : anchor.value;
                await this.addFileAnchorEvidence(evidence, seen, fileValue, anchor, cwd);
            }
        }

        for (const anchor of preprocessed.anchors.filter(item => item.type === 'symbol')) {
            const symbols = this.hybridRetrieval.lookupSymbolEvidence(anchor.value).slice(0, 5);
            for (const symbol of symbols) {
                const chunks = await this.hybridRetrieval.getChunksForEvidenceFile(symbol.filePath);
                const chunk = chunks.find(item => item.startLine <= symbol.endLine && item.endLine >= symbol.startLine) ?? chunks[0];
                if (chunk) {
                    addEvidence(evidence, seen, chunk, 'symbol_anchor', `Symbol anchor ${anchor.value} resolved to ${symbol.name}.`);
                }
            }
        }

        for (const anchor of preprocessed.anchors.filter(item => item.type === 'package' || item.type === 'config')) {
            const files = await this.hybridRetrieval.findPackageOrConfigFiles(anchor.value);
            for (const file of files.slice(0, 4)) {
                await this.addFileAnchorEvidence(evidence, seen, file, anchor, cwd, 'package_config');
            }
        }

        for (const query of preprocessed.search_queries.slice(0, 4)) {
            const chunks = await this.hybridRetrieval.searchBm25Evidence(query, 5);
            for (const chunk of chunks) {
                addEvidence(evidence, seen, chunk, 'bm25_error_search', `BM25 matched the terminal error query: ${query}`);
            }
        }

        // Broad catch-all search: this is the one query-shaped (not anchor-shaped) step
        // in terminal evidence gathering, so — like investigate()'s retrievePaths() —
        // it routes through the canonical orchestrator instead of calling
        // HybridRetrievalFusion.retrieveContext() directly. This also broadens evidence
        // beyond hybrid_retrieval alone (fact_store/symbol_index/program_graph too). The
        // anchor-specific lookups above stay direct calls to HybridRetrievalFusion's
        // low-level helpers — precision instruments resolving exact files/symbols/packages
        // extracted from the terminal error, not classified free-text queries, analogous
        // to EvidencePacketBuilder's own internal direct store calls.
        const hybridQuery = preprocessed.search_queries.slice(0, 3).join('\n');
        if (hybridQuery) {
            const items = await this.retrieveViaOrchestrator(hybridQuery);
            const codeItems = items.filter(item => item.type !== 'annotation' && item.type !== 'community_summary');
            const annotationItems = items.filter(item => item.type === 'annotation');
            for (const item of codeItems.slice(0, 6)) {
                addEvidenceFromItem(evidence, seen, item, 'hybrid_retrieval', 'Hybrid retrieval matched the preprocessed terminal error packet.');
            }
            for (const annotation of annotationItems.slice(0, 4)) {
                const id = `annotation:${annotation.file}:${evidence.length + 1}`;
                if (!seen.has(id)) {
                    seen.add(id);
                    evidence.push({
                        id,
                        file: annotation.file,
                        excerpt: annotation.content,
                        why_it_matters: `Annotation: signals=${extractAnnotationSignals(annotation).join(', ') || 'none'}.`,
                        source: 'annotation'
                    });
                }
            }
        }

        return evidence.slice(0, 20);
    }

    private async addFileAnchorEvidence(
        evidence: InvestigationEvidenceItem[],
        seen: Set<string>,
        fileValue: string,
        anchor: ErrorAnchor,
        cwd?: string,
        source: InvestigationEvidenceItem['source'] = 'direct_file_anchor'
    ): Promise<void> {
        const candidates = unique([
            fileValue,
            cwd && !path.isAbsolute(fileValue) ? path.join(cwd, fileValue) : '',
            path.basename(fileValue)
        ].filter(Boolean));
        for (const candidate of candidates) {
            const chunks = await this.hybridRetrieval.getChunksForEvidenceFile(candidate);
            if (chunks.length === 0) {
                continue;
            }
            const chunk = anchor.line
                ? chunks.find(item => item.startLine + 1 <= anchor.line! && item.endLine + 1 >= anchor.line!) ?? chunks[0]
                : chunks[0];
            addEvidence(evidence, seen, chunk, source, `${anchor.type} anchor from terminal error (${anchor.value}).`);
            return;
        }
    }
}

function buildInitialHypotheses(
    question: string,
    retrieved: Array<{ path: InvestigationPath; items: EvidenceItem[] }>
): InvestigationHypothesis[] {
    const directFiles = unique(retrieved.flatMap(item => item.path.retrievedFiles)).slice(0, 5);
    const flowFiles = unique(
        retrieved
            .filter(item => item.path.id === 'flow' || item.path.id === 'entrypoints')
            .flatMap(item => item.path.retrievedFiles)
    ).slice(0, 5);
    const failureFiles = unique(
        retrieved
            .filter(item => item.path.id === 'failure-modes')
            .flatMap(item => item.path.retrievedFiles)
    ).slice(0, 5);

    return [
        {
            title: 'Primary implementation path',
            confidence: directFiles.length >= 2 ? 'medium' : 'low',
            evidenceFiles: directFiles,
            reasoning: `The direct retrieval path surfaced the files most likely to implement or explain: ${question}`,
            nextChecks: ['Read the top direct evidence files first.', 'Confirm symbol names and line ranges before making code changes.']
        },
        {
            title: 'Execution path and integration points',
            confidence: flowFiles.length >= 2 ? 'medium' : 'low',
            evidenceFiles: flowFiles,
            reasoning: 'The entrypoint and flow retrieval paths identify likely callers, adapters, or data handoffs.',
            nextChecks: ['Trace from the public entrypoint into the implementation.', 'Check whether retrieved tests exercise the same path.']
        },
        {
            title: 'Risk and edge-case path',
            confidence: failureFiles.length >= 2 ? 'medium' : 'low',
            evidenceFiles: failureFiles,
            reasoning: 'The failure-mode retrieval path looks for guards, exceptions, tests, and edge behavior.',
            nextChecks: ['Inspect error handling before concluding the behavior is complete.', 'Look for tests that contradict the implementation hypothesis.']
        }
    ];
}

function buildEvidenceTrailFromRetrieved(
    retrieved: Array<{ path: InvestigationPath; items: EvidenceItem[] }>
): InvestigationEvidenceItem[] {
    const evidence: InvestigationEvidenceItem[] = [];
    const seen = new Set<string>();
    for (const item of retrieved) {
        for (const evidenceItem of item.items.filter(i => i.type !== 'annotation' && i.type !== 'community_summary').slice(0, 4)) {
            addEvidenceFromItem(
                evidence,
                seen,
                evidenceItem,
                'hybrid_retrieval',
                `Retrieved in investigation path "${item.path.label}".`
            );
        }
    }
    return evidence.slice(0, 12);
}

function addEvidence(
    evidence: InvestigationEvidenceItem[],
    seen: Set<string>,
    chunk: CodeChunk,
    source: InvestigationEvidenceItem['source'],
    whyItMatters: string
): void {
    const id = `${source}:${chunk.id || chunk.filePath}:${chunk.startLine}`;
    if (seen.has(id)) {
        return;
    }
    seen.add(id);
    evidence.push({
        id,
        file: chunk.filePath,
        line_start: chunk.startLine + 1,
        line_end: chunk.endLine + 1,
        excerpt: chunk.text.slice(0, 1200),
        why_it_matters: whyItMatters,
        source
    });
}

function addEvidenceFromItem(
    evidence: InvestigationEvidenceItem[],
    seen: Set<string>,
    item: EvidenceItem,
    source: InvestigationEvidenceItem['source'],
    whyItMatters: string
): void {
    const id = `${source}:${item.id}`;
    if (seen.has(id)) {
        return;
    }
    seen.add(id);
    evidence.push({
        id,
        file: item.file,
        line_start: item.startLine + 1,
        line_end: item.endLine + 1,
        excerpt: item.content.slice(0, 1200),
        why_it_matters: whyItMatters,
        source
    });
}

function extractAnnotationSignals(item: EvidenceItem): string[] {
    const normalized = item as NormalizedEvidenceItem;
    const signals = normalized.provenance?.metadata?.signals;
    return Array.isArray(signals) ? signals as string[] : [];
}

/** Minimal EvidencePacket wrapping the full investigation evidence pool, used only to
 * run the final report text through AnswerGate's file-path check. */
function buildInvestigationGatePacket(question: string, retrieved: Array<{ path: InvestigationPath; items: EvidenceItem[] }>): EvidencePacket {
    const items = retrieved.flatMap(entry => entry.items);
    return {
        query: question,
        plan: {
            originalQuery: question,
            normalizedQuery: question.toLowerCase(),
            queryType: 'unknown',
            requiredEvidence: [],
            symbolHints: [],
            fileHints: [],
            phrases: [],
            factTypes: [],
            unitTypes: [],
            fileScope: 'both',
            retrievalStrategy: 'hybrid',
            mustExcludeRoles: [],
            diagnostics: [],
            confidence_mode: 'conceptual'
        },
        items,
        facts: [],
        coverage: [],
        gaps: [],
        diagnostics: [],
        coverageScore: items.length > 0 ? 1 : 0,
        matchedEvidenceTypes: []
    };
}

/** Adapts the terminal investigation's InvestigationEvidenceItem[] (a report-local shape,
 * distinct from the canonical EvidenceItem) into a minimal EvidencePacket so the final
 * report text can be run through AnswerGate's file-path check. */
function buildTerminalGatePacket(problem: string, evidence: InvestigationEvidenceItem[]): EvidencePacket {
    const items: EvidenceItem[] = evidence.map(entry => ({
        id: entry.id,
        file: entry.file ?? 'unknown',
        startLine: entry.line_start ?? 0,
        endLine: entry.line_end ?? 0,
        role: 'implementation',
        type: entry.source,
        content: entry.excerpt,
        retrieval_signal: entry.source,
        score: 1,
        confidence: 1,
        extractionMethod: 'terminal_investigation'
    }));
    return {
        query: problem,
        plan: {
            originalQuery: problem,
            normalizedQuery: problem.toLowerCase(),
            queryType: 'unknown',
            requiredEvidence: [],
            symbolHints: [],
            fileHints: [],
            phrases: [],
            factTypes: [],
            unitTypes: [],
            fileScope: 'both',
            retrievalStrategy: 'hybrid',
            mustExcludeRoles: [],
            diagnostics: [],
            confidence_mode: 'conceptual'
        },
        items,
        facts: [],
        coverage: [],
        gaps: [],
        diagnostics: [],
        coverageScore: items.length > 0 ? 1 : 0,
        matchedEvidenceTypes: []
    };
}

function buildTerminalPrimaryHypothesis(
    problem: string,
    preprocessed: PreprocessedError,
    evidence: InvestigationEvidenceItem[]
): StructuredHypothesis {
    const topEvidence = evidence[0];
    const anchorSummary = preprocessed.anchors.slice(0, 4).map(anchor => `${anchor.type}:${anchor.value}`).join(', ');
    const text = topEvidence
        ? `The ${preprocessed.error_type} appears tied to ${topEvidence.file ?? 'the retrieved project evidence'}; strongest anchors are ${anchorSummary || preprocessed.message}.`
        : `The ${preprocessed.error_type} could not be mapped to indexed project files; investigate the error message directly: ${preprocessed.message || problem}.`;
    return {
        text,
        confidence: evidence.length >= 3 ? 0.72 : evidence.length > 0 ? 0.55 : 0.3,
        evidence_ids: evidence.slice(0, 4).map(item => item.id)
    };
}

function buildTerminalAlternatives(
    preprocessed: PreprocessedError,
    evidence: InvestigationEvidenceItem[]
): AlternativeHypothesis[] {
    const alternatives: AlternativeHypothesis[] = [];
    const configEvidence = evidence.filter(item => item.source === 'package_config').slice(0, 3);
    if (preprocessed.anchors.some(anchor => anchor.type === 'package') || configEvidence.length > 0) {
        alternatives.push({
            text: 'A dependency, package manager, or config mismatch may be the actual cause.',
            likelihood: 0.55,
            evidence_ids: configEvidence.map(item => item.id),
            reasoning: 'The preprocessor found package/config anchors, so package.json, lockfile, or package-manager settings may explain the failure.'
        });
    }
    const symbolEvidence = evidence.filter(item => item.source === 'symbol_anchor').slice(0, 3);
    if (symbolEvidence.length > 0) {
        alternatives.push({
            text: 'The named symbol may be called with an unexpected runtime shape.',
            likelihood: 0.45,
            evidence_ids: symbolEvidence.map(item => item.id),
            reasoning: 'Stack or compiler anchors resolved to symbols, but the retrieved code still needs runtime input inspection.'
        });
    }
    alternatives.push({
        text: 'The failure may depend on local environment state not captured in the repository index.',
        likelihood: 0.35,
        evidence_ids: [],
        reasoning: 'Terminal output rarely includes all environment variables, generated files, or package cache state.'
    });
    return alternatives.slice(0, 4);
}

function buildTerminalCannotDetermine(
    preprocessed: PreprocessedError,
    evidence: InvestigationEvidenceItem[],
    terminalOutput: string
): string[] {
    const unknowns = [
        'Whether the command was run after a fresh install, rebuild, or reindex.',
        'The exact local environment variables and generated files present at runtime.'
    ];
    if (!terminalOutput.trim()) {
        unknowns.push('No terminal output was provided, so error anchors are limited to the problem description.');
    }
    if (evidence.length === 0) {
        unknowns.push('No extracted anchors mapped to indexed project files.');
    }
    if (preprocessed.anchors.length === 0) {
        unknowns.push('The terminal output did not contain recognizable file, symbol, package, test, or config anchors.');
    }
    return unique(unknowns);
}

function buildTerminalNextChecks(
    preprocessed: PreprocessedError,
    evidence: InvestigationEvidenceItem[]
): string[] {
    const checks = [
        'Open the highest-ranked evidence file and inspect the cited line range.',
        'Re-run the failing command with the same cwd and capture the full output if this was truncated.'
    ];
    if (preprocessed.error_type === 'typescript_compiler') {
        checks.push('Run TypeScript on the cited project or package and compare the first TS error with the cited source.');
    }
    if (preprocessed.error_type === 'node_module_resolution' || preprocessed.error_type === 'package_linking') {
        checks.push('Inspect package.json and package-manager config for the missing package or workspace link.');
    }
    if (evidence.some(item => item.source === 'symbol_anchor')) {
        checks.push('Trace callers of the resolved symbol to confirm the failing input shape.');
    }
    return unique(checks).slice(0, 6);
}

function formatStructuredInvestigationReport(
    problem: string,
    terminalError: TerminalErrorRecord | undefined,
    primary: StructuredHypothesis,
    evidence: InvestigationEvidenceItem[],
    alternatives: AlternativeHypothesis[],
    cannotDetermine: string[],
    nextChecks: string[]
): string {
    return [
        'DETECTIVE-STYLE HYPOTHESIS REPORT',
        '',
        'PRIMARY HYPOTHESIS',
        `${primary.text} Confidence: ${Math.round(primary.confidence * 100)}%.`,
        '',
        'EVIDENCE TRAIL',
        evidence.length > 0
            ? evidence.map(item => `- ${item.id}: ${item.file ?? 'non-file evidence'}${item.line_start ? `:${item.line_start}-${item.line_end}` : ''} - ${item.why_it_matters}`).join('\n')
            : '- No project evidence was retrieved from the extracted terminal anchors.',
        '',
        'ALTERNATIVE HYPOTHESES',
        alternatives.map(item => `- ${item.text} (${Math.round(item.likelihood * 100)}%): ${item.reasoning}`).join('\n'),
        '',
        'WHAT I CANNOT DETERMINE',
        cannotDetermine.map(item => `- ${item}`).join('\n'),
        '',
        'NEXT CHECKS',
        nextChecks.map(item => `- ${item}`).join('\n'),
        '',
        'RAW STRUCTURED REPORT',
        JSON.stringify({
            problem,
            terminal_error: terminalError,
            primary_hypothesis: primary,
            evidence_trail: evidence,
            alternative_hypotheses: alternatives,
            cannot_determine: cannotDetermine,
            next_checks: nextChecks
        }, null, 2)
    ].join('\n');
}

function extractCannotDetermine(answer: string): string[] {
    const match = answer.match(/WHAT I CANNOT DETERMINE\s*([\s\S]*?)(?:\n[A-Z][A-Z\s]+$|\nNEXT CHECKS|$)/i);
    const lines = match?.[1]
        ?.split(/\n+/)
        .map(line => line.replace(/^[-*\d.]+\s*/, '').trim())
        .filter(Boolean) ?? [];
    return lines.length > 0
        ? lines.slice(0, 6)
        : ['The retrieved evidence may be incomplete, stale, or missing runtime-only state.'];
}

function confidenceNumber(confidence: InvestigationHypothesis['confidence']): number {
    if (confidence === 'high') {
        return 0.85;
    }
    if (confidence === 'medium') {
        return 0.6;
    }
    return 0.35;
}

function buildInvestigationMessages(
    question: string,
    retrieved: Array<{ path: InvestigationPath; items: EvidenceItem[] }>,
    hypotheses: InvestigationHypothesis[]
): Array<{ role: string; content: string }> {
    const context = retrieved.map(item => {
        const codeItems = item.items.filter(i => i.type !== 'annotation' && i.type !== 'community_summary');
        const annotationItems = item.items.filter(i => i.type === 'annotation');
        const communityItems = item.items.filter(i => i.type === 'community_summary');

        const chunks = codeItems.slice(0, 5).map(evidenceItem =>
            formatEvidenceItem(evidenceItem)
        ).join('\n');
        const annotations = annotationItems.slice(0, 3).map(annotation =>
            `- ${annotation.file}: ${annotation.content} | signals=${extractAnnotationSignals(annotation).join(', ') || 'none'}`
        ).join('\n');
        const communities = communityItems.slice(0, 3).map(community =>
            `- ${community.symbol ?? community.file}: ${community.content}`
        ).join('\n');

        return [
            `PATH: ${item.path.label}`,
            `QUERY: ${item.path.query}`,
            `PREFERRED ANNOTATION SIGNALS: ${item.path.preferredSignals.join(', ') || 'none'}`,
            `MATCHED ANNOTATION SIGNALS: ${item.path.matchedAnnotationSignals.join(', ') || 'none'}`,
            `FILES: ${item.path.retrievedFiles.join(', ') || '(none)'}`,
            annotations ? `ANNOTATIONS:\n${annotations}` : '',
            communities ? `COMMUNITIES:\n${communities}` : '',
            `CODE EVIDENCE:\n${chunks || '(none)'}`
        ].filter(Boolean).join('\n');
    }).join('\n\n---\n\n');

    return [
        {
            role: 'system',
            content: [
                'You are RepoGuide Investigation Engine, a senior engineer performing a careful code investigation.',
                'Write a detective-style hypothesis report grounded only in the provided repository evidence.',
                'Do not claim certainty when evidence is incomplete. Prefer hypotheses with confidence levels.',
                'Use exactly these headings:',
                'DETECTIVE-STYLE HYPOTHESIS REPORT',
                'PRIMARY HYPOTHESIS',
                'EVIDENCE TRAIL',
                'ALTERNATIVE HYPOTHESES',
                'WHAT I CANNOT DETERMINE',
                'NEXT CHECKS',
                '',
                'For every important claim, name the file that supports it. Do not invent file paths.',
                'In WHAT I CANNOT DETERMINE, explicitly list evidence that is missing, ambiguous, stale, or not present in the retrieved files.'
            ].join('\n')
        },
        {
            role: 'user',
            content: [
                `Investigation question: ${question}`,
                '',
                'Initial retrieval hypotheses:',
                JSON.stringify(hypotheses, null, 2),
                '',
                'Multi-path retrieved evidence:',
                context
            ].join('\n')
        }
    ];
}

function ensureRequiredUncertaintySection(answer: string): string {
    let normalized = answer.trim();
    if (!/WHAT I CANNOT DETERMINE/i.test(normalized)) {
        normalized += [
            '',
            '',
            'WHAT I CANNOT DETERMINE',
            '- The retrieved evidence does not include runtime logs, local configuration, or an exact reproduction trace.',
            '- Any files not retrieved by the investigation may contain additional causes or contradict this hypothesis.'
        ].join('\n');
    }
    if (!/NEXT CHECKS/i.test(normalized)) {
        normalized += [
            '',
            '',
            'NEXT CHECKS',
            '- Inspect the cited files directly before making code changes.',
            '- Reproduce the reported behavior and compare it with the retrieved implementation path.'
        ].join('\n');
    }
    return normalized;
}

function formatEvidenceItem(item: EvidenceItem): string {
    return [
        `[FILE: ${item.file} LINES: ${item.startLine + 1}-${item.endLine + 1} SCORE: ${Number(item.score).toFixed(3)}]`,
        item.content.slice(0, 1600),
        '---'
    ].join('\n');
}

function inferProblemSignals(question: string): AnnotationSignal[] {
    const lower = question.toLowerCase();
    const signals = new Set<AnnotationSignal>();

    if (/\b(value|state|data|result|cache|lockfile|dependency|package|node_modules)\b/.test(lower) &&
        /\b(wrong|incorrect|missing|changed|after|not|isn't|isnt|aren't|arent|fails?|broken|linked|linking)\b/.test(lower)) {
        signals.add('mutates_state');
    }
    if (/\b(api|http|request|response|fetch|download|upload|registry|network|external|remote)\b/.test(lower)) {
        signals.add('external_call');
    }
    if (/\b(async|promise|await|concurrent|parallel|race|timeout|after|completes?|finishes?)\b/.test(lower)) {
        signals.add('async_pattern');
    }
    if (/\b(error|throw|exception|fail|crash|guard|fallback|boundary|invalid)\b/.test(lower)) {
        signals.add('error_boundary');
    }
    if (/\b(write|writes|wrote|file|disk|filesystem|fs|node_modules|install|link|linked|linking|generate|create|delete|remove)\b/.test(lower)) {
        signals.add('side_effects');
    }
    if (/\b(secret|token|auth|permission|security|credential)\b/.test(lower)) {
        signals.add('security_sensitive');
    }
    if (/\b(slow|performance|cpu|memory|hot path|bottleneck)\b/.test(lower)) {
        signals.add('performance_critical');
    }

    return Array.from(signals);
}

function applyAnnotationSignalBias(
    items: EvidenceItem[],
    preferredSignals: AnnotationSignal[],
    logger?: Logger
): EvidenceItem[] {
    const annotationItems = items.filter(item => item.type === 'annotation');
    const codeItems = items.filter(item => item.type !== 'annotation');
    if (preferredSignals.length === 0 || annotationItems.length === 0) {
        return items;
    }

    const annotationsByNormalizedPath = new Map<string, EvidenceItem>();
    for (const annotation of annotationItems) {
        annotationsByNormalizedPath.set(normalizeAnnotationPath(annotation.file), annotation);
    }

    const scored = codeItems.map(item => {
        const annotation = findAnnotationForItem(item.file, annotationsByNormalizedPath);
        const annotationSignals = annotation ? extractAnnotationSignals(annotation) : [];
        const signalHits = annotationSignals.filter(signal => preferredSignals.includes(signal as AnnotationSignal));
        const signalBonus = signalHits.length * 2;
        const confidenceBonus = Number(annotation?.confidence) >= 0.8 ? 0.5 : Number(annotation?.confidence) >= 0.5 ? 0.25 : 0;
        return {
            item: { ...item, score: Number(item.score) + signalBonus + confidenceBonus },
            signalHits
        };
    });

    const matching = scored.filter(entry => entry.signalHits.length > 0);
    const shouldPrefilter = matching.length >= 5;
    const selected = (shouldPrefilter ? matching : scored)
        .sort((a, b) => b.item.score - a.item.score)
        .map(entry => entry.item);

    const matchedSignals = unique(matching.flatMap(entry => entry.signalHits));
    logger?.info(
        `[Investigation] Annotation signal bias: preferred=${preferredSignals.join(', ') || 'none'} matched=${matchedSignals.join(', ') || 'none'} mode=${shouldPrefilter ? 'prefilter' : 'rerank'}`
    );

    return [...selected, ...annotationItems];
}

function findAnnotationForItem(
    filePath: string,
    annotationsByNormalizedPath: Map<string, EvidenceItem>
): EvidenceItem | undefined {
    const normalizedFile = normalizeAnnotationPath(filePath);
    for (const [annotationPath, annotation] of annotationsByNormalizedPath) {
        if (normalizedFile.endsWith(annotationPath) || normalizedFile.includes('/' + annotationPath)) {
            return annotation;
        }
    }
    return undefined;
}

function normalizeAnnotationPath(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase();
}

function unique<T>(items: T[]): T[] {
    return Array.from(new Set(items));
}
