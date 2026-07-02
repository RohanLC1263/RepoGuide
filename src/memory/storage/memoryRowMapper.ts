import { MemoryRecord } from '../memoryTypes';

export type LanceRow = {
    id: string;
    externalId?: string;
    repositoryId: string;
    content: string;
    scope: string;
    scopeKeys: string; // Serialized JSON
    tags: string;      // Serialized JSON
    stale: boolean;
    provenanceAuthorType: string;
    provenanceTimestamp: string;
    confidence?: number;
    vector?: number[];
} & Record<string, unknown>;

export class MemoryRowMapper {
    toRow(record: MemoryRecord, vector?: number[]): LanceRow {
        const row: LanceRow = {
            id: record.id,
            repositoryId: record.repositoryId,
            content: record.content,
            scope: record.scope,
            scopeKeys: JSON.stringify(record.scopeKeys),
            tags: JSON.stringify(record.tags),
            stale: record.stale,
            provenanceAuthorType: record.provenance.authorType,
            provenanceTimestamp: record.provenance.timestamp,
            vector
        };
        if (record.externalId) row.externalId = record.externalId;
        if (record.confidence !== undefined) row.confidence = record.confidence;
        return row;
    }

    fromRow(row: LanceRow): MemoryRecord {
        const record: MemoryRecord = {
            id: row.id as string,
            repositoryId: row.repositoryId as string,
            content: row.content as string,
            scope: row.scope as string,
            scopeKeys: JSON.parse(row.scopeKeys as string),
            tags: JSON.parse(row.tags as string),
            stale: row.stale as boolean,
            provenance: {
                authorType: row.provenanceAuthorType as string,
                timestamp: row.provenanceTimestamp as string
            }
        };
        if (row.externalId) record.externalId = row.externalId as string;
        if (row._distance !== undefined) record.distance = row._distance as number;
        if (row.confidence !== undefined) record.confidence = row.confidence as number;
        return record;
    }
}
