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
import { trimEvidenceItemForMcp } from './evidenceItemTrimmer';

/** Per-kind cap, matching this project's other MCP list caps (citation ranking / query-evidence at 25). */
export const GATHER_EVIDENCE_MAX_PER_KIND = 25;

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

function toFact(item: EvidenceItem): GatherFact {
    const t = trimEvidenceItemForMcp(item);
    return {
        id: item.id, file: t.file, startLine: t.startLine, endLine: t.endLine,
        symbol: t.symbol, type: t.type, content: t.content,
        retrieval_signal: t.retrieval_signal, confidence: t.confidence,
        extractionMethod: item.extractionMethod, stale: item.stale ?? false
    };
}
function toContext(item: EvidenceItem): GatherContext {
    const t = trimEvidenceItemForMcp(item);
    return {
        id: item.id, file: t.file, startLine: t.startLine, endLine: t.endLine,
        symbol: t.symbol, type: t.type, content: t.content,
        retrieval_signal: t.retrieval_signal, score: t.score, confidence: t.confidence, stale: item.stale ?? false
    };
}

export function buildGatherEvidenceResponse(packet: EvidencePacket): GatherEvidenceResponse {
    // packet.items/packet.facts are already relevance-ranked (EvidencePacketBuilder.rankItems),
    // so keep-first is the most-relevant subset -- no re-ranking needed.
    const facts = packet.facts.slice(0, GATHER_EVIDENCE_MAX_PER_KIND).map(toFact);
    const context = packet.items.slice(0, GATHER_EVIDENCE_MAX_PER_KIND).map(toContext);

    const totalFound = packet.facts.length + packet.items.length;
    const sparse = totalFound < 3 || packet.coverageScore < 0.34;
    const note = sparse
        ? 'Grounding is THIN -- few sources matched and/or required evidence types are missing. Treat any answer as low-confidence and consider saying the codebase evidence is insufficient.'
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
