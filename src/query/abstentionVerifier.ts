import { EvidencePacket } from './evidencePacket';
import { sentenceSpans } from './sentenceSpans';

/**
 * Distinguishes "this is not in the codebase" from "this was not retrieved".
 *
 * An abstention is the one answer shape that looks *more* trustworthy the more wrong it
 * is. Measured case: asked where STT confidence averaging is implemented, RepoGuide
 * replied that the evidence "does not provide details" and advised searching the
 * codebase by hand. The logic is one line, at `app/services/stt_service.py:181`
 * (`avg_confidence = sum(confidences) / len(confidences)`). That answer passed the gate
 * cleanly -- correctly, on the gate's own terms, because there is nothing fabricated in
 * it to catch. A retrieval miss had been rendered as calibrated honesty, which is worse
 * than a caught fabrication: the user walks away believing the thing does not exist.
 *
 * The fix follows the pattern already proven by the technology-name verifier: resolve
 * the claim against the REAL indexed repository rather than against the retrieved
 * packet. If an abstention names something the index can find, the abstention is a
 * retrieval gap and must say so.
 *
 * Deliberately conservative -- it only ever downgrades pass to revise and adds a note.
 * An abstention about something genuinely absent is correct behaviour and is left alone.
 */

/**
 * Phrases by which the model reports it could not answer from the evidence.
 *
 * This list is the single shared abstention vocabulary for BOTH consumers: the
 * retrieval-gap check below, and `AnswerGate`'s per-artifact blocking exemption
 * (see `abstentionScope`). Before 2026-08-05 the gate carried its OWN, far looser
 * copy -- a five-phrase substring scan over the whole answer, one entry of which was
 * the bare word `'missing'` -- and used it as a global kill switch for every blocking
 * check. "Handles a missing key" is ordinary code explanation, not a hedge, so any
 * answer containing it passed the gate unconditionally no matter what it fabricated
 * (STRICT_AUDIT_2026-08-04 P0-1, reproduced: adding one clause containing "missing"
 * flipped a fabricated-technology block to a green pass). `'missing'` is deliberately
 * NOT reinstated here, and no bare word should ever be added to this list -- every
 * entry must be a phrase that only occurs when the model is genuinely declining to
 * answer.
 */
const ABSTENTION_PATTERNS: RegExp[] = [
    /\bevidence (?:provided |available )?does not (?:determine|mention|provide|contain|include|specify|show|indicate)\b/i,
    /\b(?:is|are) not (?:explicitly )?(?:mentioned|provided|specified|included|present|detailed) in the (?:provided |available )?evidence\b/i,
    /\bno (?:direct )?evidence (?:of|for|that|showing)\b/i,
    /\b(?:could|can)not (?:be )?(?:found|determined|located)\b/i,
    /\bdoes not appear (?:to be )?(?:in|present)\b/i,
    /\bnot (?:enough|sufficient) (?:evidence|information)\b/i,
    /\bthe evidence (?:is|was) (?:insufficient|silent)\b/i,
    // Active-voice forms that the gate's former substring list covered and the passive
    // patterns above miss ("I cannot determine the eviction policy" -- the exact shape
    // the old comment cited as its motivating case -- rather than "cannot BE determined").
    // Folded in here so the gate loses nothing real by adopting this vocabulary.
    /\b(?:can|could)\s?not\s+(?:be\s+)?determine\b/i,
    /\bdoes not determine\b/i,
    /\bdoes not (?:specify|state)\b/i,
    /\bnot explicitly (?:stated|mentioned|specified|documented)\b/i
];

/**
 * Which REGIONS of an answer are abstaining, rather than merely whether the answer
 * abstains anywhere.
 *
 * The distinction is the whole point. A hedge earns an artifact an exemption only where
 * the artifact might be a restatement of the question rather than an assertion -- i.e.
 * inside the abstaining sentence itself ("I cannot determine if 0.85 is the threshold",
 * where `0.85` came from the user). An artifact in a DIFFERENT sentence is an ordinary
 * claim and gets no exemption from the hedge, however honest that other sentence is.
 * Treating one hedge anywhere as blanket permission for the entire answer is what made
 * "The project uses Redis. Error handling for a missing key is elsewhere." pass.
 */
export interface AbstentionScope {
    /** True when the answer abstains somewhere. For answer-level checks only (does this
     *  answer already acknowledge a gap?) -- never as a blocking exemption. */
    readonly any: boolean;
    /** True when `index` falls inside a sentence in which the answer abstains. */
    covers(index: number): boolean;
}

export function abstentionScope(answer: string): AbstentionScope {
    const spans = sentenceSpans(answer).filter(s => {
        const sentence = answer.slice(s.start, s.end);
        return ABSTENTION_PATTERNS.some(p => p.test(sentence));
    });
    return {
        any: spans.length > 0,
        covers: (index: number) => spans.some(s => index >= s.start && index < s.end)
    };
}

/** Words too generic to be worth resolving against the index. */
const STOPWORDS = new Set([
    'the', 'this', 'that', 'and', 'for', 'with', 'from', 'what', 'where', 'when', 'how',
    'does', 'actually', 'implemented', 'implementation', 'logic', 'code', 'codebase',
    'file', 'files', 'function', 'functions', 'evidence', 'provided', 'about', 'into',
    'there', 'their', 'which', 'would', 'could', 'should', 'been', 'being', 'have',
    'not', 'any', 'all', 'its', 'get', 'set', 'use', 'used', 'uses', 'you', 'your'
]);

export interface AbstentionSignal {
    /** The sentence that abstained, for diagnostics. */
    sentence: string;
}

/**
 * True when the answer reports it could not establish the fact from the evidence.
 * Matches on the answer's own hedging vocabulary rather than trying to parse a subject
 * out of prose -- the subject is recovered from the QUESTION instead (see
 * questionSearchTerms), which is far more reliable than noun-phrase extraction.
 */
export function detectAbstention(answer: string): AbstentionSignal | null {
    // Shares sentenceSpans with abstentionScope rather than carrying its own
    // lastIndexOf('.') split, so the two cannot disagree about where an abstaining
    // sentence begins and ends.
    for (const span of sentenceSpans(answer)) {
        const sentence = answer.slice(span.start, span.end);
        if (ABSTENTION_PATTERNS.some(p => p.test(sentence))) {
            return { sentence: sentence.trim().replace(/\s+/g, ' ') };
        }
    }
    return null;
}

/** Distinctive terms from the question, used to ask the index what the packet missed. */
export function questionSearchTerms(question: string): string[] {
    const raw = question.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    return Array.from(new Set(raw)).filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/** Index lookup, structurally identical to the one the technology verifier uses. */
export interface EvidenceSearchLookup {
    search(query: string, maxResults: number): Promise<Array<{
        filePath: string; startLine?: number; endLine?: number; score?: number;
    }>>;
}

export interface RetrievalGap {
    /** Specific `file:start-end` regions the index knows of that the packet never saw. */
    candidateLocations: string[];
}

/**
 * Given an abstaining answer, asks the index whether it can find the question's subject
 * anywhere the packet did not look.
 *
 * Returns null -- meaning "the abstention stands" -- whenever it cannot prove otherwise:
 * no lookup, a failing lookup, or hits the packet already covered. A retrieval gap is
 * only reported when the index knows of a specific REGION the packet never contained,
 * which is the only situation where "we could not find it" is demonstrably premature.
 */
export async function findRetrievalGap(
    question: string,
    packet: EvidencePacket,
    lookup: EvidenceSearchLookup | undefined,
    maxCandidates = 3
): Promise<RetrievalGap | null> {
    if (!lookup) {
        return null;
    }
    const terms = questionSearchTerms(question);
    if (terms.length === 0) {
        return null;
    }

    let hits: Array<{ filePath: string; startLine?: number; endLine?: number; score?: number }>;
    try {
        hits = await lookup.search(terms.join(' '), 25);
    } catch {
        return null; // a broken index must never manufacture a retrieval-gap verdict
    }
    if (hits.length === 0) {
        return null;
    }

    // Line granularity, NOT file granularity. Measured on the case this exists for: the
    // failing STT answer's packet DID contain stt_service.py -- but only line 229, while
    // the averaging it claimed not to find is at line 181. A file-level comparison
    // therefore called the real answer "already retrieved" and pointed the user at three
    // unrelated files instead. A region only counts as seen if some packet item actually
    // overlaps it.
    const seen = new Map<string, Array<{ start: number; end: number }>>();
    const note = (file: string | undefined, start?: number, end?: number) => {
        const key = normalize(file);
        if (!key) { return; }
        const ranges = seen.get(key) ?? [];
        ranges.push({ start: start ?? 0, end: end ?? Number.MAX_SAFE_INTEGER });
        seen.set(key, ranges);
    };
    for (const item of packet.items) { note(item.file, item.startLine, item.endLine); }
    for (const fact of packet.facts) { note(fact.file, fact.startLine, fact.endLine); }

    const overlaps = (hit: { filePath: string; startLine?: number; endLine?: number }): boolean => {
        const ranges = seen.get(normalize(hit.filePath));
        if (!ranges) { return false; }
        const hitStart = hit.startLine ?? 0;
        const hitEnd = hit.endLine ?? hitStart;
        // A hit with no line info can only be judged at file level.
        if (hit.startLine === undefined) { return true; }
        return ranges.some(r => hitStart <= r.end && hitEnd >= r.start);
    };

    const missed: string[] = [];
    for (const hit of hits) {
        if (!hit.filePath || overlaps(hit)) {
            continue;
        }
        const label = hit.startLine === undefined
            ? hit.filePath
            : `${hit.filePath}:${hit.startLine}${hit.endLine && hit.endLine !== hit.startLine ? `-${hit.endLine}` : ''}`;
        if (missed.includes(label)) { continue; }
        missed.push(label);
        if (missed.length >= maxCandidates) { break; }
    }
    return missed.length > 0 ? { candidateLocations: missed } : null;
}

function normalize(file: string | undefined): string {
    return (file ?? '').replace(/\\/g, '/').toLowerCase();
}
