import Parser = require('node-tree-sitter');
import { IdentityOrigin, IdentityAuthority, CanonicalSymbolIdentity } from '../../../canonicalSymbolIdentity';
import { RelationshipKind, DeclarationLocation, EvidenceReference } from '../../semanticProviderContract';

/**
 * Python's equivalent of a "ProgramHandle": there is no type-checker/program to
 * bootstrap, so a parsed tree-sitter tree plus the raw source text and a resolved
 * module path is sufficient. No ProgramProvider abstraction is needed either --
 * tree-sitter's Parser.parse() is a single self-contained call with no
 * module-resolution side effects to fake.
 */
export interface PythonProgramHandle {
    tree: Parser.Tree;
    sourceText: string;
    filePath: string;
    workspaceRoot: string;
    /** Dotted module path (e.g. "httpx._client"), or a best-effort fallback -- see moduleResolver.ts. */
    modulePath: string;
    modulePathIsAuthoritative: boolean;
}

export interface ResolvedPythonSymbol {
    node: Parser.SyntaxNode;
    name: string;
    origin: IdentityOrigin;
}

export interface DeclarationExtractionResult {
    node: Parser.SyntaxNode | null;
    entityKind: 'class' | 'function' | 'method' | 'variable' | 'module';
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    modifiers: string[];
    visibility: 'public' | 'private' | 'protected' | 'internal';
    documentation?: string;
    canonicalIdentity?: CanonicalSymbolIdentity;
}

export interface ResolvedRelationshipObservation {
    source: ResolvedPythonSymbol;
    target: ResolvedPythonSymbol;
    relationshipKind: RelationshipKind;
    astNode: Parser.SyntaxNode;
    location: DeclarationLocation;
}

// Re-exported for convenience so python/ files import from one local place;
// these are the same language-neutral boundary types the shared assemblers use.
export type {
    IdentityDescriptor,
    RelationshipDescriptor,
    RelationshipIdentity,
    RelationshipAggregate
} from '../shared/internalModels';
export type { EvidenceReference };
