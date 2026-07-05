import Parser = require('node-tree-sitter');
import { IdentityAuthority, CanonicalSymbolIdentity } from '../../../canonicalSymbolIdentity';
import { RelationshipKind, DeclarationLocation, EvidenceReference } from '../../semanticProviderContract';

/**
 * Java's equivalent of a "ProgramHandle": no compiler/type-checker to
 * bootstrap, so a parsed tree-sitter tree plus source text and the file's
 * own declared package (read directly off the AST, not inferred) is
 * sufficient. Unlike Python's modulePath, packageName has no confidence
 * flag -- Java's `package` declaration is explicit and authoritative when
 * present (absent only for the rare default/unnamed package).
 */
export interface JavaProgramHandle {
    tree: Parser.Tree;
    sourceText: string;
    filePath: string;
    workspaceRoot: string;
    /** Dotted package name (e.g. "org.apache.http"), or '' for the default package. */
    packageName: string;
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

// Re-exported for convenience so java/ files import from one local place;
// these are the same language-neutral boundary types the shared assemblers use.
export type {
    IdentityDescriptor,
    RelationshipDescriptor,
    RelationshipIdentity,
    RelationshipAggregate
} from '../shared/internalModels';
export type { EvidenceReference, RelationshipKind, DeclarationLocation, IdentityAuthority };
