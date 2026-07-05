import Parser = require('node-tree-sitter');
import { IdentityAuthority, CanonicalSymbolIdentity } from '../../../canonicalSymbolIdentity';
import { RelationshipKind, DeclarationLocation, EvidenceReference } from '../../semanticProviderContract';

/**
 * C#'s equivalent of a "ProgramHandle": no compiler/type-checker to
 * bootstrap, so a parsed tree-sitter tree plus source text and the file's
 * own declared namespace (read directly off the AST, like Java's package)
 * is sufficient. namespaceName has no confidence flag -- C#'s `namespace`
 * declaration (file-scoped or block-scoped) is explicit and authoritative
 * when present, same property Java's package declaration has over Python.
 */
export interface CSharpProgramHandle {
    tree: Parser.Tree;
    sourceText: string;
    filePath: string;
    workspaceRoot: string;
    /** Dotted namespace (e.g. "RestSharp.Authenticators"), or '' for the global namespace. */
    namespaceName: string;
}

export interface DeclarationExtractionResult {
    node: Parser.SyntaxNode | null;
    entityKind: 'class' | 'interface' | 'enum' | 'method' | 'variable' | 'module';
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    modifiers: string[];
    visibility: 'public' | 'private' | 'protected' | 'internal';
    documentation?: string;
    canonicalIdentity?: CanonicalSymbolIdentity;
}

// Re-exported for convenience so csharp/ files import from one local place;
// these are the same language-neutral boundary types the shared assemblers use.
export type {
    IdentityDescriptor,
    RelationshipDescriptor,
    RelationshipIdentity,
    RelationshipAggregate
} from '../shared/internalModels';
export type { EvidenceReference, RelationshipKind, DeclarationLocation, IdentityAuthority };
