import { QueryEvidenceEntry, capReferencesByKind } from '../query/queryEvidenceExporter';
import { IndexAgeInfo } from './indexAge';

/**
 * Builds the get_last_chat_evidence MCP response -- extracted as a
 * standalone, side-effect-free module for the same reason as
 * dependentsResponseBuilder.ts: mcpServer.ts runs a heavyweight main() as an
 * unconditional side effect of being imported, so it can't be imported into
 * a test process at all.
 */

export interface LastChatEvidenceResponse {
    entries: QueryEvidenceEntry[];
    index_age: IndexAgeInfo | null;
}

/**
 * An MCP tool argument arrives as `unknown` (parsed from client JSON). Only a
 * finite positive number is a real limit; anything else -- missing, zero,
 * negative, NaN, a string -- means "no limit," returning everything up to
 * the file's own QUERY_EVIDENCE_MAX_ENTRIES cap rather than an arbitrary
 * default or a thrown error over a malformed argument.
 */
export function parseLimitArgument(rawLimit: unknown): number | undefined {
    return typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.floor(rawLimit)
        : undefined;
}

/**
 * Applies capReferencesByKind() to every returned entry, on top of whatever
 * buildEntry() already capped at write time -- live-tested finding: the two
 * entries already on disk when this fix landed were written before the
 * write-side cap existed (461 and 502 references, 219,992 chars combined),
 * and exportQueryEvidence's rolling file only gets rewritten on the NEXT
 * chat/MCP answer. Without a cap here too, get_last_chat_evidence would
 * keep returning that same oversized response until a new query happens to
 * evict both stale entries. Idempotent on already-capped entries (capping
 * a <=25-per-kind array is a no-op), so this is safe to apply unconditionally
 * regardless of when an entry was written.
 */
export function buildLastChatEvidenceResponse(
    entries: QueryEvidenceEntry[],
    rawLimit: unknown,
    indexAge: IndexAgeInfo | null
): LastChatEvidenceResponse {
    const limit = parseLimitArgument(rawLimit);
    const limited = limit !== undefined ? entries.slice(0, limit) : entries;
    return {
        entries: limited.map(entry => ({ ...entry, references: capReferencesByKind(entry.references) })),
        index_age: indexAge
    };
}
