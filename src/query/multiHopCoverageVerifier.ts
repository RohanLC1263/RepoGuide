import { EvidencePacket } from './evidencePacket';

/**
 * Flags a deep-trace answer that silently drops a file it was actually given.
 *
 * WHY THIS IS NOT A BUDGET FIX. An earlier round attributed the dropped file on
 * multi-hop questions to prompt truncation and built a per-file packing cap for it. That
 * diagnosis did not survive checking: an A/B against pre-fix packing showed
 * `mission_service.py` was ALREADY reaching the packed prompt, with the same 16 distinct
 * files either way. The `[PromptBudget] N dropped` telemetry says how many items were
 * dropped, not which, and the inference was wrong. The packing cap was reverted.
 *
 * The real cause is the 7B model omitting a file it was handed -- an instruction-following
 * limit, not a retrieval or packing one. A model cannot be reliably prompted out of that,
 * so the omission is detected afterwards instead: if the evidence talks about a file
 * repeatedly and the answer never names it, the trace is incomplete and should say so.
 *
 * Scoped narrowly on purpose. It only runs on questions actually shaped like a trace, and
 * only fires for files the evidence is *emphatic* about, because a packet routinely
 * contains long-tail files that a good answer is right to ignore.
 */

/** Question shapes that promise to follow something across files. */
const MULTI_HOP_QUESTION = new RegExp(
    [
        'walk me through',
        'end[ -]to[ -]end',
        'what (?:actually )?happens when',
        'how does .{0,40}\\b(?:get|go|flow|travel|move)\\b',
        'trace ',
        'from .{0,25} to .{0,25}\\?',
        'full (?:flow|path|chain|lifecycle)',
        'step[ -]by[ -]step'
    ].join('|'),
    'i'
);

/**
 * Mentions required before an omission counts. Below this the file is long-tail context
 * that a focused answer is entitled to leave out; at or above it the evidence is
 * insisting, and silence is a hole in the trace.
 */
const EMPHATIC_MENTION_THRESHOLD = 4;

/** Never name more than this many files -- a caveat longer than the answer helps nobody. */
const MAX_REPORTED = 3;

export interface OmittedFile {
    file: string;
    mentions: number;
}

export function isMultiHopQuestion(question: string): boolean {
    return MULTI_HOP_QUESTION.test(question);
}

/**
 * Files the evidence mentions at least EMPHATIC_MENTION_THRESHOLD times whose basename
 * never appears in the answer. Matching is on basename because answers cite files
 * inconsistently ("mission_service.py", "app/services/mission_service.py", "the
 * mission service module"); requiring the full path would miss real coverage and
 * manufacture omissions.
 */
export function findOmittedFiles(
    question: string,
    packet: EvidencePacket,
    answer: string
): OmittedFile[] {
    if (!isMultiHopQuestion(question)) {
        return [];
    }

    const mentions = new Map<string, number>();
    const count = (file: string | undefined) => {
        if (!file) { return; }
        const normalized = file.split('\\').join('/');
        mentions.set(normalized, (mentions.get(normalized) ?? 0) + 1);
    };
    for (const item of packet.items) { count(item.file); }
    for (const fact of packet.facts) { count(fact.file); }

    const answerLower = answer.toLowerCase();
    const omitted: OmittedFile[] = [];
    for (const [file, n] of mentions) {
        if (n < EMPHATIC_MENTION_THRESHOLD) {
            continue;
        }
        const base = file.split('/').pop() ?? file;
        const stem = base.replace(/\.[^.]+$/, '');
        // Either spelling counts as coverage: the filename, or the bare module name.
        // Whole-word, not substring: a short stem like "a" (from "a.py") otherwise matches
        // the indefinite article in any sentence and marks every such file as covered.
        if (mentionsWord(answerLower, base) || (stem.length >= 3 && mentionsWord(answerLower, stem))) {
            continue;
        }
        omitted.push({ file, mentions: n });
    }

    return omitted.sort((a, b) => b.mentions - a.mentions).slice(0, MAX_REPORTED);
}

/** Whole-word containment, so "a.py" is not satisfied by the word "a" in prose. */
function mentionsWord(haystackLower: string, needle: string): boolean {
    const escaped = needle.toLowerCase().replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`).test(haystackLower);
}
