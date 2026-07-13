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

/**
 * Content cap for `trimEvidenceItemForMcp`'s per-item content, in characters.
 * Live-measured against CraftConnect's real logical_units.db/Lance chunks/
 * facts.db (unbounded content up to 80,190 chars for a single logical unit,
 * 42,645 for a chunk): 1500 chars keeps ~30-40 real lines of code -- enough
 * to identify a class/function's signature, docstring, and early body (e.g.
 * a whole `__init__`) so a client can decide whether to Read the rest --
 * while cutting a pathological 50-item response of the largest real units
 * from ~727KB to ~94KB (87% smaller). Validated against real data: on 50
 * random (non-worst-case) real units, only ~9/50 exceed this cap, so most
 * items pass through completely unaffected.
 */
export const MCP_CONTENT_CHAR_CAP = 1500;

/**
 * Truncates `content` to MCP_CONTENT_CHAR_CAP contiguous characters (a
 * client Reads the real file for anything beyond this, per the README's MCP
 * workflow guidance -- this is not trying to preserve control-flow
 * structure the way truncateItemContent (evidencePrompt.ts) does for the
 * chat/synthesis prompt path; that function stays untouched and unrelated).
 * Rounds the cut down to the last complete line within the cap (a cheap
 * single lastIndexOf scan) so the shown head never ends mid-line, except
 * when the cap is reached before any newline at all (one huge single line),
 * where the raw char-slice is kept as-is since there is no earlier line
 * boundary to round to.
 */
function truncateContentForMcp(content: string, file: string, startLine: number, endLine: number): string {
    if (content.length <= MCP_CONTENT_CHAR_CAP) {
        return content;
    }
    let head = content.slice(0, MCP_CONTENT_CHAR_CAP);
    const lastNewline = head.lastIndexOf('\n');
    const rounded = lastNewline > 0;
    if (rounded) {
        head = head.slice(0, lastNewline);
    }
    const headNewlines = (head.match(/\n/g) || []).length;
    // The first file line NOT fully shown -- where "Read" should resume. When the cut
    // rounded down to a complete line boundary, that's one line past the last complete
    // line shown. When it didn't (a single line longer than the whole cap, so `head` is
    // only a partial prefix of startLine itself), the client must re-read starting at
    // that SAME line, not the line after it -- confirmed against real CraftConnect data
    // (i18n.ts's englishTranslations, mission_coordinator.py's MissionCoordinator): an
    // earlier off-by-one here pointed at the last line already SHOWN, which spot-checked
    // against the real file on disk as content the client already had, not the real
    // continuation point.
    const resumeLine = rounded ? startLine + headNewlines + 1 : startLine;
    const totalLines = content.split('\n').length;
    const shownLines = rounded ? headNewlines + 1 : 0;
    const droppedLines = Math.max(0, totalLines - shownLines);
    const droppedChars = content.length - head.length;
    const note = `\n... [RepoGuide truncated ${droppedLines} of ${totalLines} lines (${droppedChars} of ${content.length} chars). Read ${file}:${resumeLine}-${endLine} for the rest.] ...`;
    return head + note;
}

export function trimEvidenceItemForMcp(item: EvidenceItem): TrimmedMcpEvidenceItem {
    return {
        file: item.file,
        startLine: item.startLine,
        endLine: item.endLine,
        symbol: item.symbol,
        type: item.type,
        content: truncateContentForMcp(item.content, item.file, item.startLine, item.endLine),
        score: item.score,
        confidence: item.confidence,
        retrieval_signal: item.retrieval_signal
    };
}

export function trimEvidenceItemsForMcp(items: EvidenceItem[]): TrimmedMcpEvidenceItem[] {
    return items.map(trimEvidenceItemForMcp);
}
