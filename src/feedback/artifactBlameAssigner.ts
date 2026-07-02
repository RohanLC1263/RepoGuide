import * as fs from 'fs';
import * as path from 'path';
import { FeedbackEvent, RetrievedArtifactRef } from './feedbackCaptureService';
import { QueryIntentRouter } from '../query/queryIntentRouter';
import { unwrapArtifact } from '../comprehension/schema-versions';
import { ConceptEntry, ConceptMap, ModuleUnderstanding } from '../comprehension/types';

export interface BlameCandidate {
    artifactType: string;
    artifactId: string;
    relativePath: string | null;
    blameScore: number;
    reason: string;
}

export interface BlameAssignment {
    feedbackEventId: string;
    blameCandidates: BlameCandidate[];
    suggestedRepairStages: string[];
    assignedAt: string;
}

interface LoadedJson<T> {
    filePath: string;
    raw: unknown;
    data: T;
}

const DIRECT_RETRIEVAL_SCORE = 0.60;
const NONEXISTENT_PATH_SCORE = 0.95;
const NAVIGATED_FILE_SCORE = 0.80;
const CORRECTIVE_FILE_SCORE = 0.70;
const CORRECTED_FLOW_SCORE = 0.85;
const PROPAGATED_MODULE_SCORE = 0.50;

export class ArtifactBlameAssigner {
    private readonly blameFile: string;

    constructor(
        private readonly workspaceRoot: string,
        private readonly understandingDir: string,
        private readonly outputChannel?: { appendLine(msg: string): void }
    ) {
        const feedbackDir = path.join(this.workspaceRoot, '.repoguide', 'feedback');
        fs.mkdirSync(feedbackDir, { recursive: true });
        this.blameFile = path.join(feedbackDir, 'blame_assignments.jsonl');
    }

    public assignBlame(event: FeedbackEvent): BlameAssignment {
        const candidates = new Map<string, BlameCandidate>();

        const addOrUpdate = (candidate: BlameCandidate): void => {
            const normalized = normalizeCandidate(candidate);
            const key = `${normalized.artifactType}:${normalized.artifactId}`;
            const existing = candidates.get(key);
            if (!existing || normalized.blameScore > existing.blameScore) {
                candidates.set(key, normalized);
            }
        };

        this.addDirectArtifactBlame(event, addOrUpdate);
        this.addEventSpecificBlame(event, candidates, addOrUpdate);
        this.addBehavioralPathBlame(event, candidates, addOrUpdate);
        this.addPropagationBlame(candidates, addOrUpdate);

        const assignment: BlameAssignment = {
            feedbackEventId: event.id,
            blameCandidates: sortCandidates(Array.from(candidates.values())),
            suggestedRepairStages: deriveSuggestedRepairStages(candidates.values()),
            assignedAt: new Date().toISOString()
        };

        this.appendAssignment(assignment);
        return assignment;
    }

    private addDirectArtifactBlame(
        event: FeedbackEvent,
        addOrUpdate: (candidate: BlameCandidate) => void
    ): void {
        for (const artifact of event.retrievedArtifacts ?? []) {
            const artifactType = normalizeArtifactType(artifact.source);
            addOrUpdate({
                artifactType,
                artifactId: artifact.id,
                relativePath: inferRelativePath(artifactType, artifact.id, this.workspaceRoot),
                blameScore: DIRECT_RETRIEVAL_SCORE,
                reason: 'artifact was retrieved and contributed to the answer'
            });
        }
    }

    private addEventSpecificBlame(
        event: FeedbackEvent,
        candidates: Map<string, BlameCandidate>,
        addOrUpdate: (candidate: BlameCandidate) => void
    ): void {
        if (event.eventType === 'cited_nonexistent_file' && event.nonexistentPath) {
            this.addNonexistentPathBlame(event, addOrUpdate);
        }

        if (event.eventType === 'navigation_divergence' && event.navigatedToFile) {
            const navigatedPath = normalizeRelativePath(event.navigatedToFile, this.workspaceRoot);
            addOrUpdate({
                artifactType: 'file_understanding',
                artifactId: navigatedPath,
                relativePath: navigatedPath,
                blameScore: NAVIGATED_FILE_SCORE,
                reason: 'user navigated to this file instead'
            });

            this.addBehavioralPathsMissingNavigatedFileBlame(navigatedPath, candidates, addOrUpdate);
        }

        if (event.eventType === 'corrective_followup') {
            for (const candidate of candidates.values()) {
                if (candidate.artifactType === 'file_understanding') {
                    addOrUpdate({
                        ...candidate,
                        blameScore: Math.max(candidate.blameScore, CORRECTIVE_FILE_SCORE),
                        reason: 'answer was explicitly corrected by user'
                    });
                }
            }
        }
    }

    private addNonexistentPathBlame(
        event: FeedbackEvent,
        addOrUpdate: (candidate: BlameCandidate) => void
    ): void {
        const nonexistentPath = normalizeRelativePath(event.nonexistentPath ?? '', this.workspaceRoot);

        for (const concept of this.findConceptsPointingToPath(nonexistentPath)) {
            addOrUpdate({
                artifactType: 'concept_map',
                artifactId: concept.concept,
                relativePath: nonexistentPath,
                blameScore: NONEXISTENT_PATH_SCORE,
                reason: 'artifact pointed to a nonexistent file path'
            });
        }

        for (const fileUnderstandingId of this.findFileUnderstandingsPointingToPath(nonexistentPath, event.retrievedArtifacts ?? [])) {
            addOrUpdate({
                artifactType: 'file_understanding',
                artifactId: fileUnderstandingId,
                relativePath: inferRelativePath('file_understanding', fileUnderstandingId, this.workspaceRoot),
                blameScore: NONEXISTENT_PATH_SCORE,
                reason: 'artifact pointed to a nonexistent file path'
            });
        }
    }

    private addBehavioralPathsMissingNavigatedFileBlame(
        navigatedPath: string,
        candidates: Map<string, BlameCandidate>,
        addOrUpdate: (candidate: BlameCandidate) => void
    ): void {
        const paths = this.loadBehavioralPaths();
        for (const candidate of candidates.values()) {
            if (candidate.artifactType !== 'behavioral_path') {
                continue;
            }

            const pathArtifact = paths.find(item => behavioralPathMatchesId(item, candidate.artifactId));
            if (!behavioralPathIncludesFile(pathArtifact, navigatedPath)) {
                addOrUpdate({
                    ...candidate,
                    blameScore: Math.max(candidate.blameScore, CORRECTED_FLOW_SCORE),
                    reason: 'behavioral path did not include the file the user navigated to'
                });
            }
        }
    }

    private addBehavioralPathBlame(
        event: FeedbackEvent,
        candidates: Map<string, BlameCandidate>,
        addOrUpdate: (candidate: BlameCandidate) => void
    ): void {
        if (event.eventType !== 'corrective_followup') {
            return;
        }

        const router = new QueryIntentRouter(this.understandingDir, this.outputChannel);
        router.load();
        const intent = router.classify(event.query);
        if (intent.primary !== 'FLOW') {
            return;
        }

        for (const candidate of candidates.values()) {
            if (candidate.artifactType === 'behavioral_path') {
                addOrUpdate({
                    ...candidate,
                    blameScore: Math.max(candidate.blameScore, CORRECTED_FLOW_SCORE),
                    reason: 'flow answer was corrected'
                });
            }
        }
    }

    private addPropagationBlame(
        candidates: Map<string, BlameCandidate>,
        addOrUpdate: (candidate: BlameCandidate) => void
    ): void {
        const filesForConceptReverification = new Set<string>();

        for (const candidate of Array.from(candidates.values())) {
            if (candidate.artifactType !== 'file_understanding' || candidate.blameScore < CORRECTIVE_FILE_SCORE) {
                continue;
            }

            const relativePath = candidate.relativePath ?? inferRelativePath('file_understanding', candidate.artifactId, this.workspaceRoot);
            if (!relativePath) {
                continue;
            }

            const moduleId = this.findModuleForFile(relativePath);
            addOrUpdate({
                artifactType: 'module_understanding',
                artifactId: moduleId,
                relativePath: moduleId,
                blameScore: PROPAGATED_MODULE_SCORE,
                reason: `propagated from blamed file ${relativePath}`
            });
            filesForConceptReverification.add(relativePath);
        }

        if (filesForConceptReverification.size > 0) {
            this.lowerConceptConfidence(filesForConceptReverification);
        }
    }

    private findConceptsPointingToPath(relativePath: string): ConceptEntry[] {
        const conceptMap = this.loadConceptMap()?.data;
        const concepts = normalizeConceptEntries(conceptMap);
        return concepts.filter(concept =>
            concept.locations?.some(location => pathsReferToSameFile(location.filePath, relativePath, this.workspaceRoot))
        );
    }

    private findFileUnderstandingsPointingToPath(
        relativePath: string,
        retrievedArtifacts: RetrievedArtifactRef[]
    ): string[] {
        const ids = new Set<string>();

        for (const artifact of retrievedArtifacts) {
            const artifactType = normalizeArtifactType(artifact.source);
            if (artifactType === 'file_understanding') {
                ids.add(artifact.id);
            }
        }

        const filesDir = path.join(this.understandingDir, 'files');
        if (!fs.existsSync(filesDir)) {
            return Array.from(ids);
        }

        for (const fileName of fs.readdirSync(filesDir)) {
            if (!fileName.endsWith('.json')) {
                continue;
            }
            try {
                const checkpoint = JSON.parse(fs.readFileSync(path.join(filesDir, fileName), 'utf8')) as {
                    filePath?: string;
                    purpose?: string;
                    exports?: string[];
                    whatEachExportDoes?: Record<string, string>;
                };
                const serialized = JSON.stringify({
                    purpose: checkpoint.purpose,
                    exports: checkpoint.exports,
                    whatEachExportDoes: checkpoint.whatEachExportDoes
                });
                if (serialized.includes(relativePath) && checkpoint.filePath) {
                    ids.add(normalizeRelativePath(checkpoint.filePath, this.workspaceRoot));
                }
            } catch {
                continue;
            }
        }

        return Array.from(ids);
    }

    private findModuleForFile(relativePath: string): string {
        const modules = this.loadModuleUnderstanding();
        const normalizedFile = normalizeRelativePath(relativePath, this.workspaceRoot);

        for (const [moduleId, moduleData] of Object.entries(modules)) {
            const filePaths = Array.isArray(moduleData.filePaths) ? moduleData.filePaths : [];
            if (filePaths.some(filePath => pathsReferToSameFile(filePath, normalizedFile, this.workspaceRoot))) {
                return normalizeRelativePath(moduleData.moduleRelativePath || moduleId, this.workspaceRoot);
            }
        }

        return normalizePath(path.dirname(normalizedFile));
    }

    private lowerConceptConfidence(files: Set<string>): void {
        const loaded = this.loadConceptMap();
        if (!loaded) {
            return;
        }

        let modified = false;
        const concepts = getMutableConceptRecords(loaded.data);

        for (const concept of concepts) {
            const affected = getConceptLocationPaths(concept).some(locationPath =>
                Array.from(files).some(filePath => pathsReferToSameFile(locationPath, filePath, this.workspaceRoot))
            );
            if (!affected) {
                continue;
            }

            const mutableConcept = concept as {
                confidence?: ConceptEntry['confidence'] | number;
                needsReverification?: boolean;
                verificationStatus?: string;
            };

            if (typeof mutableConcept.confidence === 'number') {
                mutableConcept.confidence = Math.max(0, mutableConcept.confidence - 0.2);
            } else {
                const confidence = mutableConcept.confidence ?? { locationPrecision: 0.8, synonymQuality: 0.8 };
                confidence.locationPrecision = Math.max(0, confidence.locationPrecision - 0.2);
                mutableConcept.confidence = confidence;
            }
            mutableConcept.needsReverification = true;
            mutableConcept.verificationStatus = 'needs_reverification';
            modified = true;
        }

        if (!modified) {
            return;
        }

        try {
            fs.writeFileSync(loaded.filePath, JSON.stringify(loaded.raw, null, 2), 'utf8');
            this.outputChannel?.appendLine(
                `[Info] BlameAssigner: marked concept_map entries for re-verification for ${files.size} blamed file(s).`
            );
        } catch (error) {
            this.outputChannel?.appendLine(`[Warn] BlameAssigner: failed to update concept_map.json: ${String(error)}`);
        }
    }

    private loadConceptMap(): LoadedJson<ConceptMap | Record<string, unknown>> | null {
        return this.loadJson<ConceptMap | Record<string, unknown>>('concept_map.json');
    }

    private loadModuleUnderstanding(): Record<string, ModuleUnderstanding> {
        return this.loadJson<Record<string, ModuleUnderstanding>>('module_understanding.json')?.data ?? {};
    }

    private loadBehavioralPaths(): unknown[] {
        const loaded = this.loadJson<{ paths?: unknown[] } | unknown[]>('behavioral_paths.json')?.data;
        if (Array.isArray(loaded)) {
            return loaded;
        }
        return Array.isArray(loaded?.paths) ? loaded.paths : [];
    }

    private loadJson<T>(artifactName: string): LoadedJson<T> | null {
        const filePath = path.join(this.understandingDir, artifactName);
        if (!fs.existsSync(filePath)) {
            return null;
        }

        try {
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return {
                filePath,
                raw,
                data: unwrapArtifact<T>(raw)
            };
        } catch {
            return null;
        }
    }

    private appendAssignment(assignment: BlameAssignment): void {
        try {
            fs.appendFileSync(this.blameFile, `${JSON.stringify(assignment)}\n`, 'utf8');
            this.outputChannel?.appendLine(
                `[Info] BlameAssigner: assigned ${assignment.blameCandidates.length} blame candidate(s) for ${assignment.feedbackEventId}.`
            );
        } catch (error) {
            this.outputChannel?.appendLine(`[Warn] BlameAssigner: failed to write blame assignment: ${String(error)}`);
        }
    }
}

function normalizeCandidate(candidate: BlameCandidate): BlameCandidate {
    return {
        ...candidate,
        artifactType: normalizeArtifactType(candidate.artifactType),
        relativePath: candidate.relativePath ? normalizePath(candidate.relativePath) : null,
        blameScore: Math.max(0, Math.min(1, candidate.blameScore))
    };
}

function normalizeArtifactType(source: string): string {
    const normalized = source.replace(/-/g, '_').toLowerCase();
    if (normalized === 'behavioral_paths') {
        return 'behavioral_path';
    }
    if (normalized === 'vector_chunk') {
        return 'chunk';
    }
    return normalized;
}

function inferRelativePath(artifactType: string, artifactId: string, workspaceRoot: string): string | null {
    if (artifactType === 'file_understanding' || artifactType === 'module_understanding') {
        return normalizeRelativePath(artifactId, workspaceRoot);
    }
    return null;
}

function normalizeRelativePath(filePath: string, workspaceRoot: string): string {
    const relative = path.isAbsolute(filePath) ? path.relative(workspaceRoot, filePath) : filePath;
    return normalizePath(path.normalize(relative));
}

function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function pathsReferToSameFile(left: string | undefined, right: string, workspaceRoot: string): boolean {
    if (!left) {
        return false;
    }
    const a = normalizeRelativePath(left, workspaceRoot).toLowerCase();
    const b = normalizeRelativePath(right, workspaceRoot).toLowerCase();
    return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function normalizeConceptEntries(map: ConceptMap | Record<string, unknown> | null | undefined): ConceptEntry[] {
    if (!map) {
        return [];
    }

    const concepts = (map as ConceptMap).concepts;
    if (Array.isArray(concepts)) {
        return concepts;
    }

    if (concepts && typeof concepts === 'object') {
        return Object.entries(concepts).map(([concept, value]) => ({
            concept,
            synonyms: Array.isArray((value as { synonyms?: unknown }).synonyms) ? (value as { synonyms: string[] }).synonyms : [],
            locations: normalizeConceptLocations(value),
            strength: Number((value as { strength?: number }).strength ?? 0.5),
            relatedConcepts: Array.isArray((value as { relatedConcepts?: unknown }).relatedConcepts)
                ? (value as { relatedConcepts: string[] }).relatedConcepts
                : [],
            confidence: (value as { confidence?: ConceptEntry['confidence'] }).confidence
        }));
    }

    return [];
}

function getMutableConceptRecords(map: ConceptMap | Record<string, unknown> | null | undefined): Array<Record<string, unknown>> {
    if (!map) {
        return [];
    }

    const concepts = (map as ConceptMap).concepts;
    if (Array.isArray(concepts)) {
        return concepts as unknown as Array<Record<string, unknown>>;
    }

    if (concepts && typeof concepts === 'object') {
        return Object.values(concepts) as Array<Record<string, unknown>>;
    }

    return [];
}

function getConceptLocationPaths(concept: Record<string, unknown>): string[] {
    const locations = Array.isArray(concept.locations)
        ? concept.locations as Array<Record<string, unknown>>
        : [];
    return locations
        .map(location => String(location.filePath ?? location.relativePath ?? ''))
        .filter(Boolean);
}

function normalizeConceptLocations(value: unknown): ConceptEntry['locations'] {
    const rawLocations = Array.isArray((value as { locations?: unknown }).locations)
        ? (value as { locations: Array<Record<string, unknown>> }).locations
        : [];

    return rawLocations.map(location => ({
        filePath: String(location.filePath ?? location.relativePath ?? ''),
        startLine: Number(location.startLine ?? 0),
        endLine: Number(location.endLine ?? 0),
        symbolName: String(location.symbolName ?? ''),
        symbolKind: String(location.symbolKind ?? ''),
        relevanceScore: Number(location.relevanceScore ?? 0.5),
        excerpt: String(location.excerpt ?? '')
    }));
}

function behavioralPathMatchesId(pathArtifact: unknown, artifactId: string): boolean {
    const value = pathArtifact as {
        id?: string;
        pathId?: string;
        entryPointSymbol?: string;
        entryPointFile?: string;
    } | null;
    return Boolean(value && (
        value.id === artifactId ||
        value.pathId === artifactId ||
        value.entryPointSymbol === artifactId ||
        `${value.entryPointFile}:${value.entryPointSymbol}` === artifactId
    ));
}

function behavioralPathIncludesFile(pathArtifact: unknown, relativePath: string): boolean {
    const value = pathArtifact as {
        entryPointFile?: string;
        happyPath?: Array<{ relativePath?: string; filePath?: string }>;
    } | null;
    if (!value) {
        return false;
    }
    if (value.entryPointFile && normalizePath(value.entryPointFile) === relativePath) {
        return true;
    }
    return Array.isArray(value.happyPath) && value.happyPath.some(step =>
        normalizePath(step.relativePath ?? step.filePath ?? '') === relativePath
    );
}

function deriveSuggestedRepairStages(candidates: Iterable<BlameCandidate>): string[] {
    const stages = new Set<string>();

    for (const candidate of candidates) {
        if (candidate.artifactType === 'file_understanding' && candidate.blameScore >= 0.7) {
            stages.add('file_understanding');
        } else if (candidate.artifactType === 'concept_map' && candidate.blameScore >= 0.7) {
            stages.add('concept_map');
        } else if (candidate.artifactType === 'behavioral_path' && candidate.blameScore >= 0.7) {
            stages.add('behavioral_paths');
        } else if (candidate.artifactType === 'module_understanding' && candidate.blameScore >= 0.5) {
            stages.add('module_understanding');
        }
    }

    return Array.from(stages);
}

function sortCandidates(candidates: BlameCandidate[]): BlameCandidate[] {
    return candidates.sort((a, b) => b.blameScore - a.blameScore || a.artifactType.localeCompare(b.artifactType));
}
