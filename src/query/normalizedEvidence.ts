import { EvidenceItem } from './evidencePacket';

export type EvidenceFreshness = 'fresh' | 'possibly_stale' | 'stale' | 'unknown';

export interface EvidenceProvenance {
    providerId: string;
    source: string;
    sourceId?: string;
    sourceType?: string;
    confidence?: number | string;
    metadata?: Record<string, unknown>;
}

export interface CanonicalSourceReference {
    providerId: string;
    file: string;
    startLine: number;
    endLine: number;
    symbol?: string;
    sourceId?: string;
    sourceType: string;
}

export interface NormalizedEvidenceFields {
    providerId: string;
    evidenceType: string;
    provenance: EvidenceProvenance;
    freshness: EvidenceFreshness;
    canonicalSource: CanonicalSourceReference;
}

export type NormalizedEvidenceItem = EvidenceItem & NormalizedEvidenceFields;

export function withNormalizedEvidenceFields(
    item: EvidenceItem,
    fields: NormalizedEvidenceFields
): NormalizedEvidenceItem {
    return {
        ...item,
        providerId: fields.providerId,
        evidenceType: fields.evidenceType,
        provenance: fields.provenance,
        freshness: fields.freshness,
        canonicalSource: fields.canonicalSource
    };
}

export function confidenceToNumber(confidence: number | string | undefined): number {
    if (typeof confidence === 'number') {
        return confidence;
    }
    if (confidence === 'high') {
        return 1.0;
    }
    if (confidence === 'medium') {
        return 0.7;
    }
    if (confidence === 'low') {
        return 0.4;
    }
    return 0.5;
}