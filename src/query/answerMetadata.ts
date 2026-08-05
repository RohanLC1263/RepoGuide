import * as path from 'path';
import type { FileAnnotation } from '../comprehension/fileAnnotationEngine';
import type { CommunitySummary } from '../comprehension/communityClustering';
import type { ProjectUnderstanding } from '../comprehension/types';
import type { CodeChunk, SymbolEntry } from '../store/storeTypes';
import type { FusedChunk } from './hybridRetrievalFusion';

export type AnswerFileReferenceSource =
    | 'retrieval'
    | 'symbol_index'
    | 'annotation'
    | 'community_summary'
    | 'plan'
    | 'investigation';

export interface AnswerFileReference {
    file: string;
    line_start?: number;
    line_end?: number;
    symbol?: string;
    reason: string;
    source: AnswerFileReferenceSource;
}

export interface OnboardingAnswerMetadata {
    what_this_project_does: string;
    main_modules: Array<{
        name: string;
        description: string;
        central_file?: string;
    }>;
    recommended_starting_files: AnswerFileReference[];
    common_workflows: Array<{
        name: string;
        file?: string;
        reason: string;
    }>;
}

export interface AnswerMetadata {
    schema: 'repoguide.answer_metadata.v1';
    mode: 'onboarding' | 'standard' | 'evidence';
    question: string;
    file_references: AnswerFileReference[];
    onboarding?: OnboardingAnswerMetadata;
}

// REMOVED 2026-08-04 (defect #11): `ExplainSelectionBackendResult`, the return type
// of QueryDispatcher.explainSelectionResult(), removed alongside that uncalled
// method. See the removal note in src/query/queryDispatcher.ts.

export function isOnboardingQuestion(question: string): boolean {
    const lower = question.toLowerCase().replace(/\s+/g, ' ').trim();
    return [
        /\bwhat is this (project|repo|repository|codebase)\b/,
        /\bwhat does this (project|repo|repository|codebase) do\b/,
        /\bhow does this (project|repo|repository|codebase) work\b/,
        /\bwhere (do|should) i start\b/,
        /\bexplain this (repo|repository|codebase|project)\b/,
        /\bhow should i navigate this codebase\b/,
        /\bnew to this (repo|repository|codebase|project)\b/
    ].some(pattern => pattern.test(lower));
}

export function buildAnswerMetadata(input: {
    question: string;
    chunks: FusedChunk[];
    annotations: FileAnnotation[];
    communities: CommunitySummary[];
    projectUnderstanding?: ProjectUnderstanding | null;
}): AnswerMetadata {
    const fileReferences = buildFileReferences(input.chunks, input.annotations, input.communities);
    const onboarding = isOnboardingQuestion(input.question)
        ? buildOnboardingMetadata(input.question, fileReferences, input.annotations, input.communities, input.projectUnderstanding)
        : undefined;

    return {
        schema: 'repoguide.answer_metadata.v1',
        mode: onboarding ? 'onboarding' : 'standard',
        question: input.question,
        file_references: fileReferences,
        onboarding
    };
}

export function buildExplainSelectionMetadata(input: {
    question: string;
    selectedFile: string;
    startLine: number;
    endLine: number;
    anchorChunks: CodeChunk[];
    relatedChunks: CodeChunk[];
    selectedSymbols: SymbolEntry[];
    annotations: FileAnnotation[];
    communities: CommunitySummary[];
}): AnswerMetadata {
    const selectedSymbol = input.selectedSymbols[0];
    const selectedReference: AnswerFileReference = {
        file: input.selectedFile,
        line_start: input.startLine,
        line_end: input.endLine,
        symbol: selectedSymbol?.name,
        reason: selectedSymbol
            ? `Selected code overlaps ${selectedSymbol.kind} ${selectedSymbol.name}.`
            : 'This is the selected code range.',
        source: selectedSymbol ? 'symbol_index' : 'retrieval'
    };

    const relatedReferences = input.relatedChunks.slice(0, 5).map(chunk => ({
        file: chunk.filePath,
        line_start: chunk.startLine,
        line_end: chunk.endLine,
        reason: 'Related context retrieved for the selected-code explanation.',
        source: 'retrieval' as const
    }));

    return {
        schema: 'repoguide.answer_metadata.v1',
        mode: 'standard',
        question: input.question,
        file_references: dedupeReferences([
            selectedReference,
            ...relatedReferences,
            ...annotationReferences(input.annotations),
            ...communityReferences(input.communities)
        ]).slice(0, 10)
    };
}

function buildFileReferences(
    chunks: FusedChunk[],
    annotations: FileAnnotation[],
    communities: CommunitySummary[]
): AnswerFileReference[] {
    return dedupeReferences([
        ...chunks.slice(0, 8).map(item => ({
            file: item.chunk.filePath,
            line_start: item.chunk.startLine,
            line_end: item.chunk.endLine,
            reason: `Retrieved code evidence for this answer (rank ${item.rank}).`,
            source: 'retrieval' as const
        })),
        ...annotationReferences(annotations).slice(0, 5),
        ...communityReferences(communities).slice(0, 5)
    ]).slice(0, 12);
}

function buildOnboardingMetadata(
    question: string,
    fileReferences: AnswerFileReference[],
    annotations: FileAnnotation[],
    communities: CommunitySummary[],
    projectUnderstanding?: ProjectUnderstanding | null
): OnboardingAnswerMetadata {
    const whatThisProjectDoes =
        projectUnderstanding?.what_it_does ??
        projectUnderstanding?.purpose ??
        summarizeFromCommunities(communities) ??
        'RepoGuide found indexed code, but no project synthesis artifact is available yet.';

    const mainModules = communities.length > 0
        ? communities.slice(0, 8).map(community => ({
            name: community.name,
            description: community.summary,
            central_file: community.central_file
        }))
        : annotations
            .filter(annotation => typeof annotation.file === 'string' && annotation.what)
            .slice(0, 8)
            .map(annotation => ({
                name: path.basename(annotation.file),
                description: annotation.what,
                central_file: annotation.file
            }));

    const entryPointAnnotations = annotations
        .filter(annotation => annotation.role === 'entry_point')
        .map(annotation => ({
            file: annotation.file,
            symbol: annotation.key_symbols?.[0],
            reason: annotation.what || 'Annotated as an entry point.',
            source: 'annotation' as const
        }));

    const recommendedStartingFiles = dedupeReferences([
        ...entryPointAnnotations,
        ...fileReferences.filter(reference => !isLowValueStartingFile(reference.file))
    ]).slice(0, 5);

    return {
        what_this_project_does: whatThisProjectDoes,
        main_modules: mainModules,
        recommended_starting_files: recommendedStartingFiles,
        common_workflows: detectCommonWorkflows(question, fileReferences)
    };
}

function annotationReferences(annotations: FileAnnotation[]): AnswerFileReference[] {
    return annotations
        .filter(annotation => typeof annotation.file === 'string' && annotation.file.trim().length > 0)
        .map(annotation => ({
            file: annotation.file,
            symbol: annotation.key_symbols?.[0],
            reason: annotation.what || `Annotated as ${annotation.role}.`,
            source: 'annotation' as const
        }));
}

function communityReferences(communities: CommunitySummary[]): AnswerFileReference[] {
    return communities
        .filter(community => typeof community.central_file === 'string' && community.central_file.trim().length > 0)
        .map(community => ({
            file: community.central_file,
            reason: `Central file for ${community.name}: ${community.summary}`,
            source: 'community_summary' as const
        }));
}

function dedupeReferences(references: AnswerFileReference[]): AnswerFileReference[] {
    const seen = new Set<string>();
    const deduped: AnswerFileReference[] = [];
    for (const reference of references) {
        if (!reference.file) {
            continue;
        }
        const key = `${normalizePath(reference.file)}:${reference.line_start ?? ''}:${reference.line_end ?? ''}:${reference.symbol ?? ''}:${reference.source}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(reference);
    }
    return deduped;
}

function summarizeFromCommunities(communities: CommunitySummary[]): string | undefined {
    if (communities.length === 0) {
        return undefined;
    }
    return communities
        .slice(0, 4)
        .map(community => `${community.name}: ${community.summary}`)
        .join(' ');
}

function detectCommonWorkflows(_question: string, references: AnswerFileReference[]): OnboardingAnswerMetadata['common_workflows'] {
    const workflows: OnboardingAnswerMetadata['common_workflows'] = [];
    for (const reference of references) {
        const normalized = normalizePath(reference.file);
        if (normalized.endsWith('/package.json') || normalized === 'package.json') {
            workflows.push({ name: 'Node package scripts', file: reference.file, reason: 'package.json usually defines install, build, test, and run scripts.' });
        } else if (normalized.endsWith('/readme.md') || normalized === 'readme.md') {
            workflows.push({ name: 'Project README', file: reference.file, reason: 'README files usually describe setup and common workflows.' });
        } else if (normalized.includes('/.github/workflows/')) {
            workflows.push({ name: 'CI workflow', file: reference.file, reason: 'GitHub Actions workflow discovered in retrieved context.' });
        }
    }
    return workflows.slice(0, 5);
}

function isLowValueStartingFile(filePath: string): boolean {
    const lower = normalizePath(filePath);
    return lower.includes('/test/') ||
        lower.includes('/tests/') ||
        lower.includes('/docs/') ||
        lower.includes('/examples/') ||
        lower.endsWith('.md');
}

function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase();
}
