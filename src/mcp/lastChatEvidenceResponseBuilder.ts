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
 * Entries returned when the caller passes no usable `limit`.
 *
 * This used to mean "no limit", on the reasoning that an arbitrary default was worse than
 * returning everything up to QUERY_EVIDENCE_MAX_ENTRIES. Measured, that produced a
 * **154,753-character** response -- roughly 38k tokens in a single tool result, which is a
 * large fraction of a caller's context spent before it has read anything. That cuts against
 * the context-budget discipline applied everywhere else in this project (the 4,000-char
 * conversation cap, the evidence-budget packer). Three entries is enough to answer "what did
 * the last few answers rest on?"; a caller wanting more asks for more.
 */
const DEFAULT_ENTRY_LIMIT = 3;

/**
 * An MCP tool argument arrives as `unknown` (parsed from client JSON). Only a
 * finite positive number is a real limit; anything else -- missing, zero,
 * negative, NaN, a string -- falls back to DEFAULT_ENTRY_LIMIT rather than
 * throwing over a malformed argument.
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
    const limit = parseLimitArgument(rawLimit) ?? DEFAULT_ENTRY_LIMIT;
    const limited = entries.slice(0, limit);
    return {
        entries: limited.map(entry => ({ ...entry, references: capReferencesByKind(entry.references) })),
        index_age: indexAge
    };
}
