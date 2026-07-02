// Program Graph v1 — Type definitions

export type ProgramGraphNodeType =
    | 'file'
    | 'logical_unit'
    | 'function'
    | 'method'
    | 'class'
    | 'constant'
    | 'assignment'
    | 'call_site'
    | 'instantiation'
    | 'import'
    | 'prompt_template';

import { LogicalUnitRole } from '../indexing/logicalUnitTypes';

export type ProgramGraphEdgeType =
    | 'contains'
    | 'imports'
    | 'calls'
    | 'instantiates'
    | 'reads'
    | 'assigns'
    | 'decorates'
    | 'calls_method'
    | 'implements_interface'
    | 'references'
    | 'fallback_to';

export interface ProgramGraphNode {
    /** Unit ID, fact ID, or synthetic file ID (file::{filePath}). */
    id: string;
    uuid?: string;
    type: ProgramGraphNodeType;
    symbol?: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
    role: LogicalUnitRole;
}

export interface ProgramGraphEdge {
    from: string;
    to: string;
    type: ProgramGraphEdgeType;
    /** 0–1, used for ranking graph-expanded evidence. */
    weight: number;
    metadata?: Record<string, unknown>;
}

export interface ProgramGraph {
    version: string;
    builtAt: string;
    repoRoot: string;
    nodeCount: number;
    edgeCount: number;
    nodes: Record<string, ProgramGraphNode>;
    edges: ProgramGraphEdge[];
}
