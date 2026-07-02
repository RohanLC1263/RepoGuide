import { EvidencePlan } from './evidencePlanTypes';
import { LogicalUnitRole } from '../indexing/logicalUnitTypes';

export enum SemanticCategory {
    ARCHITECTURE = 'ARCHITECTURE',
    DEPENDENCY = 'DEPENDENCY',
    COMMUNITY = 'COMMUNITY',
    BEHAVIOR = 'BEHAVIOR',
    HISTORY = 'HISTORY',
    MEMORY = 'MEMORY',
    GENERAL = 'GENERAL',
    UNKNOWN = 'UNKNOWN'
}

export interface EvidenceItem {
    id: string;
    file: string;
    startLine: number;
    endLine: number;
    role: LogicalUnitRole;
    unitId?: string;
    factId?: string;
    symbol?: string;
    type: string;
    content: string;
    retrieval_signal: string;
    semanticCategory?: SemanticCategory;
    score: number;
    confidence: number | string;
    extractionMethod: string;
    stale?: boolean;
}

export interface EvidencePacket {
    query: string;
    plan: EvidencePlan;
    items: EvidenceItem[];
    facts: EvidenceItem[];
    coverage: string[];
    gaps: string[];
    diagnostics: string[];
    coverageScore: number;
    matchedEvidenceTypes: string[];
    impactAssessment?: any;
    /** Present only for explain_selection packets. Used to split items into anchor vs. related context. */
    selection?: {
        file: string;
        startLine: number;
        endLine: number;
        text: string;
        language?: string;
    };
}

/** True if the item's file/line range overlaps the packet's selection, i.e. it's "anchor" evidence. */
export function isAnchorItem(item: EvidenceItem, selection: EvidencePacket['selection']): boolean {
    if (!selection) return false;
    return item.file === selection.file && item.endLine >= selection.startLine && item.startLine <= selection.endLine;
}
