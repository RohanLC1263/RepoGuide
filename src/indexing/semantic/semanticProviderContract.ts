import { CanonicalSymbolIdentity } from '../canonicalSymbolIdentity';

export interface DeclarationLocation {
    filePath: string;
    startLine: number;
    endLine: number;
}

// 1. Evidence
export interface EvidenceReference {
    id: string;
    type: 'compiler' | 'ast' | 'heuristic' | 'runtime' | 'manual';
    location?: DeclarationLocation;
}

// 2. Metadata
export interface ProviderMetadata {
    providerName: string;
    providerVersion: string;
    extractionMethod: 'compiler' | 'ast' | 'mixed';
    extractionTimestampMs: number;
}

// 3. Entity (No containment fields, no confidence, no metadata bloat)
export interface RepositoryEntity {
    canonicalId: CanonicalSymbolIdentity;
    name: string;
    entityKind: 'class' | 'interface' | 'function' | 'method' | 'variable' | 'enum' | 'namespace' | 'type_alias';
    declarationLocation: DeclarationLocation;
    modifiers: string[];
    visibility: 'public' | 'private' | 'protected' | 'internal';
    documentation?: string;
}

// 4. Relationship (Categorized, absolute certainty via evidence)
export type RelationshipCategory = 'structural' | 'semantic';
export type RelationshipKind = 'DECLARES' | 'CALLS' | 'IMPORTS' | 'EXTENDS' | 'IMPLEMENTS' | 'INSTANTIATES' | 'REFERENCES';

export interface RepositoryRelationship {
    id: string;
    category: RelationshipCategory;
    relationshipKind: RelationshipKind;
    source: CanonicalSymbolIdentity;
    target: CanonicalSymbolIdentity;
    evidence: EvidenceReference[];
}

// 5. Known Unknown (Unresolved constructs)
export interface KnownUnknown {
    id: string;
    source: CanonicalSymbolIdentity;
    sourceLocation: DeclarationLocation;
    unsupportedConstruct: string;
    reason: string;
    evidence: EvidenceReference[];
    recommendedHandling: string;
}

// 6. Diagnostics
export interface ProviderDiagnostic {
    code: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    location?: DeclarationLocation;
}

// 7. Result Payload
export interface ExtractionMetrics {
    durationMs: number;
    memoryAllocatedBytes?: number;
    filesProcessed: number;
    entitiesExtracted: number;
    relationshipsExtracted: number;
    unknownsFound: number;
}

export type ExtractionStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'EMPTY';

export interface SemanticExtractionResult {
    status: ExtractionStatus;
    providerMetadata: ProviderMetadata;
    entities: RepositoryEntity[];
    relationships: RepositoryRelationship[];
    knownUnknowns: KnownUnknown[];
    diagnostics: ProviderDiagnostic[];
    metrics: ExtractionMetrics;
}

// 8. The Interfaces
export interface SemanticProvider {
    readonly name: string;
    readonly version: string;
    canHandle(filePath: string): boolean;
    extract(filePath: string, content: string, projectContextToken?: unknown): Promise<SemanticExtractionResult>;
}

export interface SemanticExtractionEngine {
    registerProvider(provider: SemanticProvider): void;
    canHandle(filePath: string): boolean;
    extract(filePath: string, content: string, projectContextToken?: unknown): Promise<SemanticExtractionResult | null>;
}
