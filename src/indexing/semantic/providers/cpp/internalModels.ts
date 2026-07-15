import Parser = require('node-tree-sitter');
import { IdentityAuthority, CanonicalSymbolIdentity } from '../../../canonicalSymbolIdentity';
import { RelationshipKind, DeclarationLocation, EvidenceReference } from '../../semanticProviderContract';

/**
 * C++'s "ProgramHandle". Unlike every prior provider, C++ needs a second,
 * OPTIONAL parsed tree: `pairedHeader`. Empirically confirmed (see
 * docs/engineering-log/CPP_SEMANTIC_PROVIDER_REPORT.md): 84.2% of a real corpus's header-declared
 * methods are DEFINED out-of-line in a separate .cpp file via
 * `ClassName::method(...)` syntax, and 100% of .cpp files include their own
 * paired header as their first `#include` -- so resolving that header's own
 * parsed tree (not just checking its existence, unlike every previous
 * provider's IMPORTS/module resolution) is required for DECLARES to be
 * honest for C++, not an edge case to accept as a gap.
 */
export interface CppProgramHandle {
    tree: Parser.Tree;
    sourceText: string;
    filePath: string;
    workspaceRoot: string;
    isHeader: boolean;
    /** Only set for a .cpp/.cc/.cxx file whose first quoted #include resolved to a real file. */
    pairedHeaderPath: string | null;
    pairedHeaderTree: Parser.Tree | null;
}

export interface DeclarationExtractionResult {
    node: Parser.SyntaxNode | null;
    entityKind: 'class' | 'enum' | 'function' | 'method' | 'variable' | 'namespace' | 'module';
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    modifiers: string[];
    visibility: 'public' | 'private' | 'protected' | 'internal';
    documentation?: string;
    canonicalIdentity?: CanonicalSymbolIdentity;
}

// Re-exported for convenience so cpp/ files import from one local place;
// these are the same language-neutral boundary types the shared assemblers use.
export type {
    IdentityDescriptor,
    RelationshipDescriptor,
    RelationshipIdentity,
    RelationshipAggregate
} from '../shared/internalModels';
export type { EvidenceReference, RelationshipKind, DeclarationLocation, IdentityAuthority };
