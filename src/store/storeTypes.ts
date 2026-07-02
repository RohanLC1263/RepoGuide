import type { CanonicalSymbolIdentity } from '../indexing/canonicalSymbolIdentity';
export type { LogicalUnit, LogicalUnitIndex } from '../indexing/logicalUnitTypes';

export interface CodeChunk {
    id: string;
    filePath: string;
    language: string;
    startLine: number;
    endLine: number;
    text: string;
    vector: number[];
    hash: string;
}

export interface SymbolEntry {
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    kind: 'class' | 'function' | 'method' | 'interface' | 'instantiation' | 'constant';
    canonicalId?: CanonicalSymbolIdentity;
}
