import { LogicalUnitConfidence, LogicalUnitExtractionMethod, LogicalUnitRole } from './logicalUnitTypes';
import type { CanonicalSymbolIdentity } from './canonicalSymbolIdentity';

export type FactType =
    | 'constant'
    | 'numeric_threshold'
    | 'list_literal'
    | 'list_count'
    | 'dict_literal'
    | 'string_literal'
    | 'prompt_template'
    | 'config_value'
    | 'environment_variable'
    | 'fallback_chain'
    | 'guard_clause'
    | 'dependency_injection'
    | 'instantiation'
    | 'import'
    | 'exported_symbol'
    | 'call_site'
    | 'calls_method'
    | 'implements_interface'
    | 'assignment';

export type FactValueKind = 'number' | 'string' | 'boolean' | 'list' | 'dict' | 'ast_node' | 'null';

export interface FactRecord {
    factId: string;
    filePath: string;
    unitId: string;
    subjectUuid?: string;
    objectUuid?: string;
    canonicalSubjectId?: CanonicalSymbolIdentity;
    canonicalObjectId?: CanonicalSymbolIdentity;
    symbol?: string;
    factType: FactType;
    value: unknown;
    valueKind: FactValueKind;
    startLine: number;
    endLine: number;
    extractionMethod: LogicalUnitExtractionMethod | 'ast_query';
    confidence: LogicalUnitConfidence;
    sourceText: string;
    role: LogicalUnitRole;
    diagnostics?: string;
}

export interface FactQuery {
    factType?: FactType;
    symbol?: string;
    filePath?: string;
    value?: unknown;
    confidence?: LogicalUnitConfidence;
    role?: LogicalUnitRole;
    excludeRoles?: LogicalUnitRole[];
    limit?: number;
}
