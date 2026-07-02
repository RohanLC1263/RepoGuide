import * as fs from 'fs';
import * as path from 'path';

export const SCHEMA_VERSIONS: Record<string, string> = {
    'manifest.json':           "1.0.0",
    'lexical_map.json':        "1.0.0",
    'import_graph.json':       "1.0.0",
    'call-graph.json':         "1.0.0",
    'call_graph_v1.json':      "1.0.0",
    'call_graph_v2.json':      "1.0.0",
    'type_annotation_map.json': "1.0.0",
    'decorator_map.json':      "1.0.0",
    'inheritance_map.json':    "1.0.0",
    'files.json':              "1.0.0",
    'file-structures.json':    "1.0.0",
    'module_understanding.json': "1.0.0",
    'modules.json':            "1.0.0",
    'concept_map.json':        "1.0.0",
    'behavioral_paths.json':   "1.0.0",
    'entry_points.json':       "1.0.0",
    'project.json':            "1.0.0",
    'validation_report.json':  "1.0.0",
    'quality_metrics.json':    "1.0.0",
    'artifact_dependencies.json': "1.0.0",
    'runtime_traces.json':     "1.0.0",
    'dynamic_call_graph.json': "1.0.0",
    'symbols.json':            "1.0.0",
    'confidence_report.json':  "1.0.0"
};

export interface ArtifactGenerationMetadata {
    generatedAt?: string;
    sourceFiles?: string[];
    sourceHashes?: Record<string, string>;
    dependencyArtifactIds?: string[];
    unresolvedReferences?: number;
    warnings?: string[];
    stats?: Record<string, unknown>;
    confidence?: number | Record<string, number>;
}

export interface ArtifactEnvelope<T> {
    schemaVersion: string;
    builderVersion: string;
    createdAt: string;
    updatedAt: string;
    sourceHashes: Record<string, string>;
    confidence: number | Record<string, number>;
    metadata: ArtifactGenerationMetadata;
    data: T;
}

let builderVersionProvider: () => string = () => '0.0.1';

export function setArtifactBuilderVersionProvider(provider: () => string): void {
    builderVersionProvider = provider;
}

export function getArtifactBuilderVersion(): string {
    try {
        return builderVersionProvider() || '0.0.1';
    } catch {
        return '0.0.1';
    }
}

export function wrapArtifact<T>(artifactName: string, data: T, metadata?: Partial<ArtifactGenerationMetadata>): ArtifactEnvelope<T> {
    const builderVersion = getArtifactBuilderVersion();
    const schemaVersion = SCHEMA_VERSIONS[artifactName] || '1.0.0';

    const defaultMetadata: ArtifactGenerationMetadata = {
        generatedAt: new Date().toISOString(),
        sourceFiles: [],
        sourceHashes: {},
        dependencyArtifactIds: [],
        unresolvedReferences: 0,
        warnings: [],
        stats: {},
        confidence: 1.0,
        ...metadata
    };

    return {
        schemaVersion,
        builderVersion,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceHashes: metadata?.sourceHashes ?? {},
        confidence: metadata?.confidence ?? 1.0,
        metadata: defaultMetadata,
        data
    };
}

export function unwrapArtifact<T>(parsed: any): T {
    if (parsed && typeof parsed === 'object' && 'schemaVersion' in parsed && 'data' in parsed) {
        return parsed.data as T;
    }
    return parsed as T;
}

export class ArtifactVersionChecker {
    constructor(
        private understandingDir: string,
        private extensionVersion: string,
        private warningSink?: (message: string) => void,
        private logWarning?: (message: string) => void
    ) {}

    /**
     * Checks all artifacts in the understanding directory against the schema registry.
     * Returns a map of artifactName -> 'current' | 'stale' | 'missing'
     */
    checkAll(): Record<string, 'current' | 'stale' | 'missing'> {
        const results: Record<string, 'current' | 'stale' | 'missing'> = {};
        
        for (const [artifactName, expectedVersion] of Object.entries(SCHEMA_VERSIONS)) {
            const filePath = path.join(this.understandingDir, artifactName);
            if (!fs.existsSync(filePath)) {
                results[artifactName] = 'missing';
                continue;
            }

            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const parsed = JSON.parse(content);

                // If it's wrapped in an envelope, check schemaVersion
                if (parsed && typeof parsed === 'object' && 'schemaVersion' in parsed) {
                    const actualVersion = parsed.schemaVersion;
                    if (actualVersion !== expectedVersion) {
                        results[artifactName] = 'stale';
                    } else {
                        results[artifactName] = 'current';
                    }
                } else {
                    // Pre-versioning artifact -> considered stale
                    results[artifactName] = 'stale';
                }
            } catch (error) {
                // Unparseable file -> missing/stale
                results[artifactName] = 'stale';
            }
        }
        
        return results;
    }

    getStaleArtifacts(): string[] {
        const statuses = this.checkAll();
        return Object.entries(statuses)
            .filter(([_, status]) => status === 'stale')
            .map(([name, _]) => name);
    }

    showStalenessWarning(): void {
        const stale = this.getStaleArtifacts();
        if (stale.length > 0) {
            this.warningSink?.(
                "RepoGuide: Some artifacts are outdated after an extension update. Run 'Rebuild index' to restore full quality."
            );
        }
    }
}
