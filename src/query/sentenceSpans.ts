/**
 * One sentence splitter, shared by every check that needs to know WHERE in an answer
 * something was said rather than merely whether it was said somewhere.
 *
 * This exists because the same bug was found twice, in two modules, on 2026-08-04
 * (STRICT_AUDIT_2026-08-04 P0-1 and the second root cause found while closing it):
 * a suppression signal was matched over an unscoped region -- the whole answer in
 * `AnswerGate`, a fixed ±120-character window in `technologyClaimVerifier` -- and so a
 * phrase in one sentence silently switched off a check that applied to a different
 * sentence. Both fixes need the same primitive, so it lives in one place rather than
 * being reimplemented per module and drifting.
 *
 * SPLITTING RULE. A boundary is terminal punctuation followed by whitespace or
 * end-of-text, or a newline. Deliberately NOT every period: `auth.py`, `3.11` and
 * `config.json` all contain periods that are not sentence ends, and requiring trailing
 * whitespace excludes all of them. `e.g. ` does still split, which is the one known
 * imprecision -- it ends a sentence early. That direction is safe for every current
 * caller, because all of them use these spans to NARROW a suppression: a short span
 * suppresses less, and under-suppressing a verification check is the recoverable
 * failure. Callers that would be harmed by an early split (matching a usage verb across
 * "e.g.") deliberately keep their wide proximity window instead -- see
 * technologyClaimVerifier's USAGE_VERB search.
 */

const SENTENCE_BOUNDARY = /[.!?](?=\s|$)|\n/g;

export interface SentenceSpan {
    start: number;
    /** Exclusive. */
    end: number;
}

export function sentenceSpans(text: string): SentenceSpan[] {
    const spans: SentenceSpan[] = [];
    let start = 0;
    SENTENCE_BOUNDARY.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SENTENCE_BOUNDARY.exec(text)) !== null) {
        const end = m.index + m[0].length;
        if (end > start) {
            spans.push({ start, end });
        }
        start = end;
    }
    if (start < text.length) {
        spans.push({ start, end: text.length });
    }
    return spans;
}

/**
 * The sentence containing `index`. Falls back to the whole text when the index cannot be
 * placed (empty input, or an index past the end) -- callers use this to decide whether a
 * suppression applies, and the widest reading is the pre-existing behaviour, so an
 * unplaceable index degrades to what the code did before rather than to no check at all.
 */
export function sentenceAt(text: string, index: number): string {
    for (const span of sentenceSpans(text)) {
        if (index >= span.start && index < span.end) {
            return text.slice(span.start, span.end);
        }
    }
    return text;
}
