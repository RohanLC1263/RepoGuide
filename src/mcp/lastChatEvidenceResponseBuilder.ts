import { QueryEvidenceEntry } from '../query/queryEvidenceExporter';
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

export function buildLastChatEvidenceResponse(
    entries: QueryEvidenceEntry[],
    rawLimit: unknown,
    indexAge: IndexAgeInfo | null
): LastChatEvidenceResponse {
    const limit = parseLimitArgument(rawLimit);
    return {
        entries: limit !== undefined ? entries.slice(0, limit) : entries,
        index_age: indexAge
    };
}
