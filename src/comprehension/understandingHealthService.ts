import * as fs from 'fs';
import * as path from 'path';
import {
    ArtifactDependencyEdge,
    ArtifactDependencySchema,
    ArtifactNode
} from './artifactDependencyGraph';
import { ArtifactEnvelope } from './schema-versions';
import { unwrapArtifact } from './schema-versions';
import { FileAnnotation } from './fileAnnotationEngine';

// ── Health report types ────────────────────────────────────────────────────

export interface ArtifactHealth {
    exists: boolean;
    fresh: boolean;
    confidence: number;
    coverageGaps: string[];
    generatedAt?: string;
    staleReason?: string;
}

export interface QuestionReliability {
    location: boolean;
    flow: boolean;
    architecture: boolean;
}

export interface UnderstandingHealthReport {
    schemaVersion: '1.0';
    generatedAt: string;
    overallStatus: 'healthy' | 'degraded' | 'incomplete';
    artifacts: Record<string, ArtifactHealth>;
    reliability: QuestionReliability;
    missingArtifacts: number;
    staleArtifacts: number;
    lowConfidenceArtifacts: number;
    prioritizedRegeneration: string[];
}

export interface AnnotationHealthReport {
    totalIndexedFiles: number;
    totalAnnotatedFiles: number;
    coveragePercent: number;
    confidenceDistribution: {
        high: number;
        medium: number;
        low: number;
    };
    freshAnnotations: number;
    staleAnnotations: number;
    freshnessPercent: number;
}

// ── DAG traversal helpers (self-contained, no vscode dependency) ───────────

function getTransitiveDeps(
    artifactId: string,
    nodes: ArtifactNode[],
    edges: ArtifactDependencyEdge[]
): ArtifactNode[] {
    const nodeMap = new Map<string, ArtifactNode>();
    for (const n of nodes) { nodeMap.set(n.id, n); }

    const result = new Map<string, ArtifactNode>();
    const queue = [artifactId];
    const visited = new Set<string>();

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);

        for (const edge of edges) {
            if (edge.to === current) {
                const dep = nodeMap.get(edge.from);
                if (dep && !result.has(dep.id)) {
                    result.set(dep.id, dep);
                    queue.push(dep.id);
                }
            }
        }
    }
    return Array.from(result.values());
}

// ── Main service ───────────────────────────────────────────────────────────

/** All understanding artifacts tracked in the DAG. */
const TRACKED_ARTIFACTS = [
    'file-structures.json', 'call-graph.json', 'lexical_map.json', 'import_graph.json',
    'type_annotation_map.json', 'decorator_map.json', 'inheritance_map.json',
    'call_graph_v1.json', 'files.json', 'call_graph_v2.json', 'modules.json',
    'module_understanding.json', 'concept_map.json', 'entry_points.json',
    'behavioral_paths.json', 'project.json', 'validation_report.json'
];

export class UnderstandingHealthService {
    constructor(
        private readonly understandingDir: string,
        private readonly workspaceRoot: string
    ) {}

    /**
     * Load the persisted artifact_dependencies.json graph.
     * Returns null if the file is missing or unparseable.
     */
    private loadGraph(): ArtifactDependencySchema | null {
        const graphPath = path.join(this.understandingDir, 'artifact_dependencies.json');
        if (!fs.existsSync(graphPath)) return null;
        try {
            const raw = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
            return unwrapArtifact<ArtifactDependencySchema>(raw);
        } catch {
            return null;
        }
    }

    /**
     * Evaluate health of every tracked artifact and write
     * understanding_health.json alongside the other artifacts.
     */
    public async evaluateHealth(): Promise<UnderstandingHealthReport> {
        const graph = this.loadGraph();

        const report: UnderstandingHealthReport = {
            schemaVersion: '1.0',
            generatedAt: new Date().toISOString(),
            overallStatus: 'healthy',
            artifacts: {},
            reliability: { location: false, flow: false, architecture: false },
            missingArtifacts: 0,
            staleArtifacts: 0,
            lowConfidenceArtifacts: 0,
            prioritizedRegeneration: []
        };

        // Cache source-file mtimes so we stat each file at most once.
        const mtimeCache = new Map<string, number>();
        const getSourceMtime = async (relPath: string): Promise<number> => {
            if (mtimeCache.has(relPath)) return mtimeCache.get(relPath)!;
            try {
                const stat = await fs.promises.stat(path.join(this.workspaceRoot, relPath));
                mtimeCache.set(relPath, stat.mtimeMs);
                return stat.mtimeMs;
            } catch {
                // File deleted / missing → treat as maximally fresh (forces stale).
                const now = Date.now();
                mtimeCache.set(relPath, now);
                return now;
            }
        };

        for (const artifact of TRACKED_ARTIFACTS) {
            const filePath = path.join(this.understandingDir, artifact);
            const exists = fs.existsSync(filePath);
            let fresh = false;
            let confidence = 1.0;
            let coverageGaps: string[] = [];
            let generatedAt: string | undefined;
            let staleReason: string | undefined;

            const stalenessPath = path.join(this.understandingDir, 'staleness_registry.json');
            let isDirtyInRegistry = false;
            let registryReason: string | undefined;
            if (fs.existsSync(stalenessPath)) {
                try {
                    const staleness = JSON.parse(await fs.promises.readFile(stalenessPath, 'utf8'));
                    if (staleness?.artifacts?.[artifact]) {
                        isDirtyInRegistry = true;
                        registryReason = staleness.artifacts[artifact].reason;
                    }
                } catch { /* ignore */ }
            }

            if (exists) {
                try {
                    const raw = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
                    const envelope = raw as ArtifactEnvelope<any>;

                    // ── generatedAt ──────────────────────────────────────
                    generatedAt = envelope.metadata?.generatedAt || envelope.createdAt;

                    // ── confidence ────────────────────────────────────────
                    if (typeof envelope.confidence === 'number') {
                        confidence = envelope.confidence;
                    } else if (envelope.confidence && typeof envelope.confidence === 'object') {
                        const vals = Object.values(envelope.confidence) as number[];
                        confidence = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;
                    } else if (envelope.metadata?.confidence != null) {
                        if (typeof envelope.metadata.confidence === 'number') {
                            confidence = envelope.metadata.confidence;
                        } else {
                            const vals = Object.values(envelope.metadata.confidence) as number[];
                            confidence = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;
                        }
                    }

                    if (isDirtyInRegistry) {
                        fresh = false;
                        staleReason = registryReason || 'Marked dirty in staleness registry';
                    } else if (graph) {
                        const sourceDeps = getTransitiveDeps(
                            artifact,
                            graph.nodes ?? [],
                            graph.edges ?? []
                        ).filter(d => d.kind === 'source_file');

                        // coverage gaps: source files in DAG but not recorded
                        if (envelope.metadata?.sourceFiles && envelope.metadata.sourceFiles.length > 0) {
                            const actual = new Set(envelope.metadata.sourceFiles);
                            for (const dep of sourceDeps) {
                                if (!actual.has(dep.id)) {
                                    coverageGaps.push(dep.id);
                                }
                            }
                        }

                        let maxMtime = 0;
                        let newestDep = '';
                        for (const dep of sourceDeps) {
                            const mtime = await getSourceMtime(dep.id);
                            if (mtime > maxMtime) {
                                maxMtime = mtime;
                                newestDep = dep.id;
                            }
                        }

                        const genTimeMs = generatedAt ? new Date(generatedAt).getTime() : 0;
                        fresh = genTimeMs >= maxMtime || maxMtime === 0;
                        if (!fresh) {
                            staleReason = `Source file '${newestDep}' modified after artifact generation`;
                        }
                    } else {
                        // No graph on disk → fall back to optimistic
                        fresh = true;
                    }
                } catch {
                    fresh = false;
                    staleReason = 'Failed to parse artifact envelope';
                }
            }

            report.artifacts[artifact] = { exists, fresh, confidence, coverageGaps, generatedAt, staleReason };

            if (!exists) report.missingArtifacts++;
            else if (!fresh) report.staleArtifacts++;
            if (exists && confidence < 0.7) report.lowConfidenceArtifacts++;
        }

        // ── Question-type reliability ─────────────────────────────────────
        const isReliable = (arts: string[]) =>
            arts.every(a => report.artifacts[a]?.exists && report.artifacts[a]?.fresh);

        report.reliability.location = isReliable(['lexical_map.json', 'concept_map.json']);
        report.reliability.flow = isReliable(['call_graph_v2.json', 'behavioral_paths.json']);
        report.reliability.architecture = isReliable(['modules.json', 'project.json']);

        // ── Overall status ────────────────────────────────────────────────
        if (report.missingArtifacts > 0) {
            report.overallStatus = 'incomplete';
        } else if (report.staleArtifacts > 0 || report.lowConfidenceArtifacts > 0) {
            report.overallStatus = 'degraded';
        }

        // ── Prioritised regeneration (topological order from the DAG) ─────
        // The TRACKED_ARTIFACTS list is already in topological order, so missing/stale
        // artifacts listed first will be the deepest dependencies.
        for (const art of TRACKED_ARTIFACTS) {
            const h = report.artifacts[art];
            if (!h.exists || !h.fresh) {
                report.prioritizedRegeneration.push(art);
            }
        }

        // ── Persist ───────────────────────────────────────────────────────
        await fs.promises.mkdir(this.understandingDir, { recursive: true });
        await fs.promises.writeFile(
            path.join(this.understandingDir, 'understanding_health.json'),
            JSON.stringify(report, null, 2),
            'utf8'
        );

        return report;
    }

    /**
     * Synchronous check used by the query pipeline to decide whether to emit
     * a health caveat for a given classified intent.
     */
    /**
     * Evaluate annotation health: coverage, confidence distribution, and freshness.
     * Reads annotation files from .repoguide/annotations/ and compares against
     * the total number of indexed files.
     */
    public async evaluateAnnotationHealth(totalIndexedFiles: number): Promise<AnnotationHealthReport> {
        const annotationsDir = path.join(path.dirname(this.understandingDir), 'annotations');
        const hashesPath = path.join(path.dirname(this.understandingDir), 'file_hashes.json');

        const annotations: FileAnnotation[] = [];
        if (fs.existsSync(annotationsDir)) {
            try {
                const files = await fs.promises.readdir(annotationsDir);
                for (const file of files) {
                    if (!file.endsWith('.json')) continue;
                    try {
                        const raw = await fs.promises.readFile(path.join(annotationsDir, file), 'utf8');
                        annotations.push(JSON.parse(raw) as FileAnnotation);
                    } catch { /* skip malformed */ }
                }
            } catch { /* ignore */ }
        }

        // Build hash registry for freshness check
        let hashRegistry: Record<string, string> = {};
        if (fs.existsSync(hashesPath)) {
            try {
                hashRegistry = JSON.parse(await fs.promises.readFile(hashesPath, 'utf8'));
            } catch { /* ignore */ }
        }

        const confidenceDistribution = { high: 0, medium: 0, low: 0 };
        let freshCount = 0;
        let staleCount = 0;

        for (const ann of annotations) {
            // Count confidence
            if (ann.confidence === 'high') confidenceDistribution.high++;
            else if (ann.confidence === 'medium') confidenceDistribution.medium++;
            else confidenceDistribution.low++;

            // Check freshness: annotation hash matches current file hash
            const currentHash = Object.entries(hashRegistry).find(([fp]) => {
                const rel = fp.replace(/\\/g, '/');
                return rel.endsWith(ann.file) || ann.file.endsWith(rel.split('/').slice(-3).join('/'));
            });
            if (currentHash && currentHash[1] === ann.hash) {
                freshCount++;
            } else {
                staleCount++;
            }
        }

        const totalAnnotated = annotations.length;
        const report: AnnotationHealthReport = {
            totalIndexedFiles: totalIndexedFiles,
            totalAnnotatedFiles: totalAnnotated,
            coveragePercent: totalIndexedFiles > 0 ? Math.round((totalAnnotated / totalIndexedFiles) * 100) : 0,
            confidenceDistribution,
            freshAnnotations: freshCount,
            staleAnnotations: staleCount,
            freshnessPercent: totalAnnotated > 0 ? Math.round((freshCount / totalAnnotated) * 100) : 0
        };

        // Persist
        const reportPath = path.join(path.dirname(this.understandingDir), 'annotation_health.json');
        await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

        return report;
    }

    public getReliabilityForIntent(intent: string): { reliable: boolean; caveatMessage?: string } {
        const reportPath = path.join(this.understandingDir, 'understanding_health.json');
        if (!fs.existsSync(reportPath)) {
            return { reliable: false, caveatMessage: 'Understanding health data is not available. Results may be inaccurate.' };
        }
        try {
            const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as UnderstandingHealthReport;

            const stalenessPath = path.join(this.understandingDir, 'staleness_registry.json');
            let isStaleMap: Record<string, boolean> = {};
            if (fs.existsSync(stalenessPath)) {
                try {
                    const staleness = JSON.parse(fs.readFileSync(stalenessPath, 'utf8'));
                    if (staleness?.artifacts) {
                        for (const key of Object.keys(staleness.artifacts)) {
                            isStaleMap[key] = true;
                        }
                    }
                } catch { /* ignore */ }
            }

            const checkStale = (artifacts: string[]) => artifacts.some(a => isStaleMap[a]);

            if (intent === 'location' && (!report.reliability.location || checkStale(['lexical_map.json', 'concept_map.json']))) {
                return { reliable: false, caveatMessage: 'Location artifacts are stale or missing. Search results may miss recent code changes.' };
            }
            if (intent === 'flow' && (!report.reliability.flow || checkStale(['call_graph_v2.json', 'behavioral_paths.json']))) {
                return { reliable: false, caveatMessage: 'Call graph and behavioral path artifacts are stale or missing. Execution flow answers may be incomplete.' };
            }
            if ((intent === 'architecture' || intent === 'orientation') && (!report.reliability.architecture || checkStale(['modules.json', 'project.json']))) {
                return { reliable: false, caveatMessage: 'Module and project artifacts are stale or missing. High-level architecture summaries may be outdated.' };
            }
            return { reliable: true };
        } catch {
            return { reliable: false, caveatMessage: 'Failed to read understanding health report.' };
        }
    }
}
