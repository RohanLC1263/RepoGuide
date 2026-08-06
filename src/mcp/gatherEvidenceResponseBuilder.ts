/**
 * Formats a built EvidencePacket (from QueryDispatcher.gatherEvidencePacket -- the
 * intermediate object the answer path would have synthesized over) into the
 * `gather_evidence` MCP response: organized, cited, grounded material for the CALLING
 * model (e.g. Claude Desktop) to reason over and answer itself. There is deliberately
 * NO prose conclusion and NO "the answer is X" -- RepoGuide's local model is not the
 * final answerer here.
 *
 * Structure mirrors distinctions the packet already makes:
 *   - `deterministic_facts`  <- packet.facts  : AST-derived, high-confidence structured
 *     facts (assignments, calls, thresholds, guards). These can't be "reasoned wrong".
 *   - `retrieved_code_context` <- packet.items : real code/graph/RAG chunks, lower
 *     certainty (retrieval is relevance-ranked, not ground truth).
 * Every entry keeps its file:line citation and `retrieval_signal` (which provider/method
 * surfaced it -- same transparency field get_facts exposes). Coverage metadata tells the
 * caller whether grounding is strong or thin BEFORE it commits to an answer.
 */
import { EvidencePacket, EvidenceItem } from '../query/evidencePacket';
import { THIN_GROUNDING_MIN_SOURCES } from '../query/answerGate';

/** Per-kind cap, matching this project's other MCP list caps (citation ranking / query-evidence at 25). */
export const GATHER_EVIDENCE_MAX_PER_KIND = 25;

/**
 * Tiered content budgets, deliberately DECOUPLED from ask_repoguide's 1500-char MCP cap
 * (evidenceItemTrimmer.MCP_CONTENT_CHAR_CAP). gather_evidence's job is to hand substantive
 * material to the caller to reason over, not to feed a short synthesized answer -- so the
 * top-ranked items per category get real, near-full content while the long tail stays
 * pointer-only (identify + Read). This keeps a top-ranked large function (e.g. the 1164-line
 * activate()) usable in one round-trip instead of forcing a second Read call, without
 * letting a 50-item response balloon.
 */
export const GATHER_FULL_CONTENT_ITEMS = 5;      // per category, top-ranked, get near-full content
// Sized to fit a genuinely large top-ranked unit WHOLE rather than truncating it,
// so a most-relevant result never forces a second round-trip Read. Calibrated against
// the real outlier this tool is meant to handle: extension.ts's 1164-line activate()
// is ~54.7k chars; 60k fits it (and IndexManager's ~46k class) with headroom. Only a
// genuinely huge top-ranked unit ever produces a large item; typical functions are a
// few KB, so this does not bloat ordinary responses. The long tail stays pointer-only.
export const GATHER_FULL_CONTENT_CAP = 60000;    // ~1200+ lines -- large top functions/classes fit whole
export const GATHER_POINTER_CONTENT_CAP = 400;   // long tail: enough to identify, then Read

function trimContent(item: EvidenceItem, cap: number): string {
    const content = item.content ?? '';
    if (content.length <= cap) { return content; }
    return content.slice(0, cap) +
        `\n... [truncated at ${cap} chars -- Read ${item.file}:${item.startLine}-${item.endLine} for the full content]`;
}

export interface GatherFact {
    id: string;
    file: string; startLine: number; endLine: number;
    symbol?: string; type: string; content: string;
    retrieval_signal: string; confidence: number | string;
    extractionMethod: string; stale: boolean;
}
export interface GatherContext {
    id: string;
    file: string; startLine: number; endLine: number;
    symbol?: string; type: string; content: string;
    retrieval_signal: string; score: number; confidence: number | string; stale: boolean;
}
export interface GatherEvidenceResponse {
    query: string;
    guidance: string;
    coverage: {
        coverageScore: number;
        deterministicFactsReturned: number;
        deterministicFactsFound: number;
        codeContextReturned: number;
        codeContextFound: number;
        sparse: boolean;
        note: string;
        matchedEvidenceTypes: string[];
        knownGaps: string[];
    };
    deterministic_facts: GatherFact[];
    retrieved_code_context: GatherContext[];
}

const GUIDANCE =
    'Grounded, cited evidence from RepoGuide for YOU (the calling model) to reason over and answer ' +
    'yourself. RepoGuide did NOT synthesize a conclusion -- there is no answer here, only material. ' +
    '`deterministic_facts` are AST-derived and reliable; `retrieved_code_context` is real but ' +
    'relevance-ranked (lower certainty) -- prefer the facts and always Read the cited file:line before ' +
    'relying on a code snippet (index content can lag the file). If coverage.sparse is true, the grounding ' +
    'is thin; say so rather than over-committing.';

function toFact(item: EvidenceItem, cap: number): GatherFact {
    return {
        id: item.id, file: item.file, startLine: item.startLine, endLine: item.endLine,
        symbol: item.symbol, type: item.type, content: trimContent(item, cap),
        retrieval_signal: item.retrieval_signal, confidence: item.confidence,
        extractionMethod: item.extractionMethod, stale: item.stale ?? false
    };
}
function toContext(item: EvidenceItem, cap: number): GatherContext {
    return {
        id: item.id, file: item.file, startLine: item.startLine, endLine: item.endLine,
        symbol: item.symbol, type: item.type, content: trimContent(item, cap),
        retrieval_signal: item.retrieval_signal, score: item.score, confidence: item.confidence, stale: item.stale ?? false
    };
}
/** Top GATHER_FULL_CONTENT_ITEMS get the full-content cap; the rest are pointer-only. */
function capForRank(index: number): number {
    return index < GATHER_FULL_CONTENT_ITEMS ? GATHER_FULL_CONTENT_CAP : GATHER_POINTER_CONTENT_CAP;
}

export function buildGatherEvidenceResponse(packet: EvidencePacket): GatherEvidenceResponse {
    // packet.items/packet.facts are already relevance-ranked (EvidencePacketBuilder.rankItems),
    // so keep-first is the most-relevant subset -- no re-ranking needed. Tier content by rank.
    const facts = packet.facts.slice(0, GATHER_EVIDENCE_MAX_PER_KIND).map((f, i) => toFact(f, capForRank(i)));
    const context = packet.items.slice(0, GATHER_EVIDENCE_MAX_PER_KIND).map((c, i) => toContext(c, capForRank(i)));

    // Sparse = genuinely few sources retrieved. Deliberately NOT keyed on
    // packet.coverageScore: that score is matchedRequiredEvidence/requiredEvidence
    // count and is 0 whenever the plan enumerates no required evidence -- which is
    // most queries -- so it reads THIN on well-grounded answers (verified across a
    // real CraftConnect batch: 9/12 answers scored 0, several of them correct). Only
    // the actual grounding volume is an honest thinness signal here.
    const totalFound = packet.facts.length + packet.items.length;
    // P2-1: was an independent literal `3` -- the two thresholds could silently drift apart
    // the moment either changed. Now genuinely the same constant answerGate.ts's check 6d
    // reads, so the Chat gate and this MCP card cannot disagree about what "thin" means.
    const sparse = totalFound < THIN_GROUNDING_MIN_SOURCES;
    const note = sparse
        ? 'Grounding is THIN -- few sources matched. Treat any answer as low-confidence and consider saying the codebase evidence is insufficient.'
        : 'Grounding is reasonable -- multiple sources matched. Still verify specific claims against the cited file:line.';

    return {
        query: packet.query,
        guidance: GUIDANCE,
        coverage: {
            coverageScore: Number(packet.coverageScore.toFixed(3)),
            deterministicFactsReturned: facts.length,
            deterministicFactsFound: packet.facts.length,
            codeContextReturned: context.length,
            codeContextFound: packet.items.length,
            sparse,
            note,
            matchedEvidenceTypes: packet.matchedEvidenceTypes ?? [],
            knownGaps: packet.gaps ?? []
        },
        deterministic_facts: facts,
        retrieved_code_context: context
    };
}
