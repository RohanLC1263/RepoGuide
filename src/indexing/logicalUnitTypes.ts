export type LogicalUnitType =
    | 'function'
    | 'method'
    | 'class'
    | 'interface'
    | 'file'
    | 'type_alias'
    | 'constant'
    | 'constant_block'
    | 'import_block'
    | 'prompt_template'
    | 'config_block'
    | 'branch'
    | 'if'
    | 'for'
    | 'while'
    | 'switch'
    | 'try'
    | 'whole_file_fallback';

export type LogicalUnitRole =
    | 'implementation'
    | 'test'
    | 'config'
    | 'script'
    | 'docs'
    | 'generated'
    | 'unknown';

export type LogicalUnitParseStatus =
    | 'complete'
    | 'partial'
    | 'regex_fallback'
    | 'whole_file_fallback';

export type LogicalUnitExtractionMethod =
    | 'tree_sitter'
    | 'regex'
    | 'fallback';

export type LogicalUnitConfidence =
    | 'high'
    | 'medium'
    | 'low';

export interface LogicalUnitMetadata {
    /** Decorator names applied to this unit. */
    decorators?: string[];
    /** True if this unit is an async function or method. */
    isAsync?: boolean;
    /** For methods: the containing class name. */
    className?: string;
    /** For branch units: "if"|"elif"|"else"|"try"|"except"|"finally"|"switch"|"catch". */
    branchKind?: string;
    /** For TS/JS: whether the symbol is exported. */
    isExported?: boolean;
    /** Parameter names for functions/methods. */
    parameters?: string[];
    /** Return type annotation if present. */
    returnType?: string;
    /** Symbols read or referenced by this unit. */
    readsSymbols?: string[];
    /** Symbols assigned or written by this unit. */
    writesSymbols?: string[];
    /** Short non-authoritative preview of an extracted value for diagnostics. */
    valuePreview?: string;
    confidence: LogicalUnitConfidence;
}

export interface LogicalUnit {
    /** Format: "{filePath}::{symbol ?? 'block'}::{type}::{startLine}". */
    id: string;
    /** UUID mapped from the Entity Registry. Shadow-mode only in Checkpoint B. */
    uuid?: string;
    /** Whether this entity should receive a persistent UUID from the Entity Registry. */
    requires_identity?: boolean;
    type: LogicalUnitType;
    /** Function/class/constant name; absent for import blocks. */
    symbol?: string;
    /** Repo-relative path. */
    filePath: string;
    /** Language identifier returned by languageDetector. */
    language: string;
    /** 1-based line numbers. endLine is always the closing line of the AST node, never an arbitrary truncation point. */
    startLine: number;
    /** 1-based line numbers. endLine is always the closing line of the AST node, never an arbitrary truncation point. */
    endLine: number;
    /** Full source text of the unit. Never truncated at storage or extraction time. */
    content: string;
    /** For branch sub-units: id of the containing function unit. */
    parentUnitId?: string;
    /** For methods: class name. For branches: function name. */
    parentSymbol?: string;
    role: LogicalUnitRole;
    parseStatus: LogicalUnitParseStatus;
    extractionMethod: LogicalUnitExtractionMethod;
    metadata: LogicalUnitMetadata;
}

/** Summary for fast lookup without full content. */
export interface LogicalUnitIndex {
    id: string;
    uuid?: string;
    requires_identity?: boolean;
    type: LogicalUnitType;
    symbol?: string;
    filePath: string;
    language: string;
    /** 1-based line numbers. endLine is always the closing line of the AST node, never an arbitrary truncation point. */
    startLine: number;
    /** 1-based line numbers. endLine is always the closing line of the AST node, never an arbitrary truncation point. */
    endLine: number;
    role: LogicalUnitRole;
    parseStatus: LogicalUnitParseStatus;
}
