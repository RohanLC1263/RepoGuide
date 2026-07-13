import { EvidenceItem } from '../query/evidencePacket';

/**
 * Trims a raw EvidenceItem down to the fields an MCP client actually needs,
 * for `retrieve_raw_evidence`/`get_facts`'s JSON serialization only -- the
 * internal EvidenceItem/NormalizedEvidenceItem shape used everywhere else in
 * the codebase (chat, AnswerGate, evidence packet building) is untouched.
 *
 * Measured live against CraftConnect's real facts.db: a full serialized item
 * is 43 lines; `provenance` and `canonicalSource` (added by
 * withNormalizedEvidenceFields, see normalizedEvidence.ts) each re-duplicate
 * file/startLine/endLine/symbol a second and third time and otherwise carry
 * fields with no MCP-client use (`providerId`, `sourceId`, `freshness`,
 * `subjectUuid`/`objectUuid`, internal diagnostics) -- a client Reads the
 * real file itself rather than trusting index-time content, so none of that
 * internal bookkeeping crosses the MCP boundary. Dropping both fields alone
 * cuts a 50-item response from 43 to 11 lines/item (~74% fewer lines, ~80%
 * fewer characters, confirmed by direct measurement).
 */
export interface TrimmedMcpEvidenceItem {
    file: string;
    startLine: number;
    endLine: number;
    symbol?: string;
    type: string;
    content: string;
    score: number;
    confidence: number | string;
    retrieval_signal: string;
}

export function trimEvidenceItemForMcp(item: EvidenceItem): TrimmedMcpEvidenceItem {
    return {
        file: item.file,
        startLine: item.startLine,
        endLine: item.endLine,
        symbol: item.symbol,
        type: item.type,
        content: item.content,
        score: item.score,
        confidence: item.confidence,
        retrieval_signal: item.retrieval_signal
    };
}

export function trimEvidenceItemsForMcp(items: EvidenceItem[]): TrimmedMcpEvidenceItem[] {
    return items.map(trimEvidenceItemForMcp);
}
