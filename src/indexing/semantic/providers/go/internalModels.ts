import Parser = require('node-tree-sitter');
import { IdentityAuthority, CanonicalSymbolIdentity } from '../../../canonicalSymbolIdentity';
import { RelationshipKind, DeclarationLocation, EvidenceReference } from '../../semanticProviderContract';

/**
 * Go's equivalent of a "ProgramHandle". Unlike Java's package or C#'s
 * namespace, Go's `package` clause is a bare identifier with no resolvable
 * path -- the real resolvable identity comes from combining the module's
 * declared path (read from go.mod) with the file's directory position
 * relative to the module root, computed once via GoModuleResolver and
 * carried on the handle as `importPath`.
 */
export interface GoProgramHandle {
    tree: Parser.Tree;
    sourceText: string;
    filePath: string;
    workspaceRoot: string;
    /** Resolvable dotted-slash import path (e.g. "resty.dev/v3/internal/util"), or a best-effort fallback if no go.mod was found. */
    importPath: string;
    /** The go.mod-declared module path, or '' if no go.mod was found -- needed to tell same-module imports from external ones. */
    modulePath: string;
    /** Directory containing the resolved go.mod (the module root), or the file's own directory if none was found. */
    moduleRoot: string;
}

export interface DeclarationExtractionResult {
    node: Parser.SyntaxNode | null;
    entityKind: 'class' | 'interface' | 'function' | 'method' | 'variable' | 'module';
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    modifiers: string[];
    visibility: 'public' | 'private' | 'protected' | 'internal';
    documentation?: string;
    canonicalIdentity?: CanonicalSymbolIdentity;
}

// Re-exported for convenience so go/ files import from one local place;
// these are the same language-neutral boundary types the shared assemblers use.
export type {
    IdentityDescriptor,
    RelationshipDescriptor,
    RelationshipIdentity,
    RelationshipAggregate
} from '../shared/internalModels';
export type { EvidenceReference, RelationshipKind, DeclarationLocation, IdentityAuthority };
