import Parser = require('node-tree-sitter');
import { IdentityAuthority, CanonicalSymbolIdentity } from '../../../canonicalSymbolIdentity';
import { RelationshipKind, DeclarationLocation, EvidenceReference } from '../../semanticProviderContract';

/**
 * Rust's equivalent of a "ProgramHandle". Like Go, Rust has no single
 * authoritative in-file path declaration -- resolvable identity comes from
 * combining the crate's declared name (Cargo.toml's `[package].name`) with
 * the file's module path relative to the crate root (src/lib.rs or
 * src/main.rs), computed once via RustCrateResolver.
 */
export interface RustProgramHandle {
    tree: Parser.Tree;
    sourceText: string;
    filePath: string;
    workspaceRoot: string;
    /** Resolvable module path (e.g. "reqwest::async_impl::body"), or a best-effort fallback if no Cargo.toml was found. */
    modulePath: string;
    /** The Cargo.toml-declared crate name, or '' if none was found. */
    crateName: string;
    /** Directory containing the resolved Cargo.toml (the crate root), or the file's own directory if none was found. */
    crateRoot: string;
}

export interface DeclarationExtractionResult {
    node: Parser.SyntaxNode | null;
    entityKind: 'class' | 'interface' | 'enum' | 'function' | 'method' | 'variable' | 'module';
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    modifiers: string[];
    visibility: 'public' | 'private' | 'protected' | 'internal';
    documentation?: string;
    canonicalIdentity?: CanonicalSymbolIdentity;
}

// Re-exported for convenience so rust/ files import from one local place;
// these are the same language-neutral boundary types the shared assemblers use.
export type {
    IdentityDescriptor,
    RelationshipDescriptor,
    RelationshipIdentity,
    RelationshipAggregate
} from '../shared/internalModels';
export type { EvidenceReference, RelationshipKind, DeclarationLocation, IdentityAuthority };
