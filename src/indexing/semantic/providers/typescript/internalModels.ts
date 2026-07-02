import * as ts from 'typescript';
import { IdentityOrigin, IdentityAuthority, CanonicalSymbolIdentity } from '../../../canonicalSymbolIdentity';

export interface ResolvedSymbol {
    symbol: ts.Symbol;
    signature?: ts.Signature;
    origin: IdentityOrigin;
}

export interface IdentityDescriptor {
    package: string;
    logicalNamespace: string;
    qualifiedName: string;
    symbolKind: string; // e.g. class, interface
    signatureHash: string;
    identityOrigin: IdentityOrigin;
    identityAuthority: IdentityAuthority;
}

/**
 * Internal intermediate result for a single declaration, strictly confined to the provider.
 * This must never cross the provider boundary.
 */
export interface DeclarationExtractionResult {
    node: ts.Declaration;
    entityKind: 'class' | 'interface' | 'function' | 'method' | 'variable' | 'enum' | 'namespace' | 'type_alias';
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    modifiers: string[];
    visibility: 'public' | 'private' | 'protected' | 'internal';
    documentation?: string;
    canonicalIdentity?: CanonicalSymbolIdentity; // the resolved identity
}

export type ResolutionCache = Map<ts.Symbol, ResolvedSymbol>;

/**
 * Handles the lifecycle of a compiler program.
 */
export interface ProgramHandle {
    program: ts.Program | undefined;
    sourceFile: ts.SourceFile;
    typeChecker?: ts.TypeChecker;
    resolutionCache?: ResolutionCache;
}

export interface ProgramProvider {
    getProgramHandle(filePath: string, content: string): ProgramHandle;
}

// ---------------------------------------------------------
// CP3D Internal Models
// ---------------------------------------------------------

import { RelationshipKind, DeclarationLocation, EvidenceReference } from '../../semanticProviderContract';

export interface ResolvedRelationshipObservation {
    source: ResolvedSymbol;
    target: ResolvedSymbol;
    relationshipKind: RelationshipKind;
    astNode: ts.Node; // The node that provided evidence
    location: DeclarationLocation; // Derived from astNode
}

/**
 * The frozen boundary between compiler logic and language-neutral assembler logic.
 * After this descriptor is built, no compiler objects may be referenced.
 */
export interface RelationshipDescriptor {
    source: IdentityDescriptor;
    target: IdentityDescriptor;
    relationshipKind: RelationshipKind;
    location: DeclarationLocation;
}

/**
 * Immutable language-neutral identity for grouping duplicate edges.
 */
export interface RelationshipIdentity {
    sourceHash: string;
    targetHash: string;
    relationshipKind: RelationshipKind;
}

/**
 * Internal aggregation model accumulating observations for a unique edge identity.
 */
export interface RelationshipAggregate {
    identity: RelationshipIdentity;
    source: IdentityDescriptor;
    target: IdentityDescriptor;
    evidence: EvidenceReference[];
}
