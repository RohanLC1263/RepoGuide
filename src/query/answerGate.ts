import * as fs from 'fs';
import * as path from 'path';
import { EvidencePacket } from './evidencePacket';
import { getAllIgnorePatterns, isIgnoredByPatterns } from '../indexing/fileWalker';
import { DeadFileGraphLookup, isEntryPointOrFrameworkWired } from './deadFileDetector';

export interface GateResult {
    outcome: 'pass' | 'revise' | 'block';
    supported_claims: string[];
    unsupported_claims: string[];
    removed_or_rewritten_claims: string[];
    required_gaps: string[];
    finalAnswer: string;
    diagnostics: string[];
}

export interface AnswerGatePolicy {
    checkNumericClaims: boolean;
    checkQuotedStrings: boolean;
    checkFilePaths: boolean;
}

const DEFAULT_POLICY: AnswerGatePolicy = {
    checkNumericClaims: true,
    checkQuotedStrings: true,
    checkFilePaths: true
};

const FILE_PATH_REGEX = /\b[\w-]+\.(ts|js|py|json|md|tsx|jsx)\b/g;
const EQUIVALENCE_PHRASE_REGEX = /\b(identical|same code|no functional difference|no difference|equivalent|duplicate of|exactly the same)\b/i;
const CLAIM_FILE_WINDOW_CHARS = 200;

// --- File-usage claim verifier ------------------------------------------------
// A narrow, deterministic check in the same family as the numeric/quote/code/
// file-identity checks: when an answer AFFIRMATIVELY asserts that a specific FILE
// "is used / imported / called / wired into / consumed by" other code, verify it
// against the program graph's inbound import edges. If no other code imports the
// file, the "used" claim is contradicted -- the reproduced dead-code-called-
// "actively-used" failure (CraftConnect community_engine.py).
//
// Deliberately scoped to FILE subjects only. A symbol-scoped version was validated
// against the same real batch and over-flagged genuinely-used symbols whose wiring
// is invisible to the graph (e.g. `ObservabilityMiddleware`, registered via
// FastAPI's app.add_middleware(...) -- real, but no graph edge). Files are almost
// always made usable by being imported, so their inbound-import absence is a far
// more reliable dead-code signal than a symbol's. Entry-point files (which are run,
// not imported) are excluded. Claims about technologies/services that aren't files
// (e.g. "uses Firestore") are out of scope -- those need answer-vs-evidence
// critique, not a graph metric.
const FILE_USAGE_PREDICATE_REGEX = /\b(?:is|are|appears?\s+to\s+be|gets|being|seems?\s+to\s+be)\s+(?:actively\s+|currently\s+)?(?:used|called|invoked|imported|instantiated|wired(?:\s+(?:in|into|up))?|integrated(?:\s+with)?|consumed|referenced)\b/gi;
const FILE_USAGE_NEGATION_REGEX = /\b(?:not|never|no|n't|nowhere|dead code|unused)\b/i;
const FILE_SUBJECT_REGEX = /[\\/]|\.[a-z]{1,4}$/i;

/** Minimal program-graph surface the file-usage check needs (structurally
 *  satisfied by ProgramGraphStore) -- kept narrow so AnswerGate stays decoupled
 *  from the store and the check is unit-testable with a plain object.
 *  Structurally identical to DeadFileGraphLookup; both describe the same
 *  getDependents surface, so the two checks stay interchangeable. */
export type FileUsageGraphLookup = DeadFileGraphLookup;

/** Detects affirmative "this FILE is used/imported/..." claims. Exported for
 *  direct testing. Returns the file subject (a backticked path) per predicate hit,
 *  skipping negated clauses and non-file subjects. */
export function detectFileUsageClaims(answer: string): Array<{ subject: string; predicate: string }> {
    const claims: Array<{ subject: string; predicate: string }> = [];
    const ticks = [...answer.matchAll(/`([^`]+)`/g)].map(m => ({ at: m.index ?? 0, text: m[1].trim() }));
    if (ticks.length === 0) {
        return claims;
    }
    const regex = new RegExp(FILE_USAGE_PREDICATE_REGEX.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = regex.exec(answer)) !== null) {
        const predAt = m.index;
        // Negation guard: an "is not used" / "no ... imported" clause is an honest
        // negative claim, never a contradiction to flag.
        const window = answer.slice(Math.max(0, predAt - 25), predAt + m[0].length);
        if (FILE_USAGE_NEGATION_REGEX.test(window)) {
            continue;
        }
        // Subject = nearest backticked token BEFORE the predicate (whole-answer, not
        // clause-split -- a file path's dots would otherwise break clause splitting).
        const preceding = ticks.filter(t => t.at < predAt).pop();
        if (!preceding || !FILE_SUBJECT_REGEX.test(preceding.text)) {
            continue;
        }
        claims.push({ subject: preceding.text, predicate: m[0].trim() });
    }
    return claims;
}
/** Tighter than CLAIM_FILE_WINDOW_CHARS: a symbol/attribute name naming what a
 * number IS should sit close to it ("threshold (0.70)"), not just somewhere in
 * the same paragraph -- a wider window would raise false-positive risk on the
 * contradiction check below with no real gain in recall. */
const CLAIM_SYMBOL_WINDOW_CHARS = 150;
/** Below this length a quote reads as a short phrase/stopword, not a real code excerpt worth a disk re-read. */
const CODE_QUOTE_MIN_LENGTH = 20;
/** Matches fenced code blocks (```lang\n...\n```) -- the same "this is real code" claim as a "..." quote, just a different syntax the model reaches for when illustrating something longer than a single line. */
const FENCED_CODE_REGEX = /```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g;
/**
 * Inline flag inserted directly after a fence that failed evidence verification in
 * conceptual mode, where blocking is deliberately off (broad architecture-style answers
 * paraphrase heavily -- e.g. flattening a real multi-line signature onto one line -- so
 * hard-blocking there reintroduces the over-blocking class the exact/grounded fence fixes
 * just recovered from). Worded as "could not verify", which is literally true for both a
 * fabrication and a paraphrase; it must never assert fabrication, since the gate cannot
 * distinguish the two without the matching tolerances this remediation deliberately avoids
 * touching. Delivered via the existing 'revise' tier (gate-rewritten finalAnswer), not a
 * new outcome.
 *
 * CROSS-REFERENCE: webviews/sidebar/gateStatusRendering.js's GATE_ANNOTATION_TEXT
 * constant must stay byte-identical to this string, so the webview can render it as a
 * styled inline callout instead of raw blockquote text. If you change this string,
 * change that one too (src/test/webviews/gateStatusRendering.test.ts enforces the match).
 */
const UNVERIFIED_FENCE_ANNOTATION = '\n> ⚠️ RepoGuide could not verify this code block against the indexed evidence. It may be paraphrased or illustrative rather than verbatim source.\n';

/** True when a matched number at `index` (of length `numLength`) reads as a specific
 * line-number reference -- either prefixed by "line"/"lines"/"at line", or one end of a
 * hyphenated range like "900-927" -- rather than a bare count/threshold/percentage. */
function isLineNumberContext(answer: string, index: number, numLength: number): boolean {
    const before = answer.slice(Math.max(0, index - 15), index);
    if (/\b(at\s+)?lines?\s*$/i.test(before)) {
        return true;
    }
    const charBefore = answer[index - 1];
    const charAfter = answer[index + numLength];
    return charBefore === '-' || charAfter === '-';
}

/** True when a matched number at `index` (of length `numLength`) is a markdown
 * ordered-list marker ("1. ", "2) ") rather than a semantic value claim --
 * requires BOTH the digit being immediately followed by ". "/") " (the
 * ordered-list punctuation) AND the digit being the first non-whitespace
 * content on its line (so "reduce retries to 1. This fixes..." is NOT
 * excluded -- the digit there isn't line-initial, so it's still checked
 * normally). Found live: a merge-step answer's own numbered list ("1.
 * **submitAnswer**: ...", "2. **apiFetch**: ...") was read as bare numeric
 * claims "1", "2", "3" and blocked against whatever numeric_threshold fact
 * happened to be textually proximate, regardless of relevance -- confirmed
 * with a minimal, fully deterministic reproduction (a 3-item numbered list,
 * one unrelated fact, all three list markers blocked in sequence). */
function isListMarkerContext(answer: string, index: number, numLength: number): boolean {
    const after = answer.slice(index + numLength, index + numLength + 2);
    if (!/^[.)]\s/.test(after)) {
        return false;
    }
    const lineStart = answer.lastIndexOf('\n', index - 1) + 1;
    const before = answer.slice(lineStart, index);
    return /^\s*$/.test(before);
}

/** Strips per-line indentation/blank lines AND collapses intra-line whitespace runs, so a
 * genuine quote isn't flagged just because the model re-indented it (found in fc-09: a real
 * docstring quoted at 7-space indent vs the file's 8) or respaced it -- while still requiring
 * every real line's token sequence to appear verbatim in the comparison text. */
function normalizeCodeForComparison(text: string): string {
    return text
        .split('\n')
        .map(line => line.trim().replace(/[ \t]+/g, ' '))
        .filter(line => line.length > 0)
        .join('\n');
}

/**
 * Finds the file path mentioned nearest a quote (checked before the quote first,
 * since "file.py: `...quoted code...`" is the common shape; falls back to after
 * unless `beforeOnly`). Returns null rather than guessing when no path-shaped
 * token is nearby.
 *
 * Fenced code blocks must pass `beforeOnly`: a fence's caption virtually always
 * PRECEDES it ("In file.py, the method is defined as: ```..."), so when the
 * caption names no file, the after-window reaches past the fence into the NEXT
 * passage's prose and attributes the code to whatever file that passage
 * discusses -- found in fc-09, where a verbatim-real studio_write.py fence was
 * "attributed" to mission_orchestrator.py named in the following list item and
 * blocked as misattributed. No file named before a fence means no attribution
 * claim to verify (the fence has already passed the evidence-wide content check).
 */
function findNearestClaimedFile(answer: string, quoteIndex: number, beforeOnly = false): string | null {
    const before = answer.slice(Math.max(0, quoteIndex - CLAIM_FILE_WINDOW_CHARS), quoteIndex);
    const beforeMatches = before.match(FILE_PATH_REGEX);
    if (beforeMatches && beforeMatches.length > 0) {
        return beforeMatches[beforeMatches.length - 1];
    }
    if (beforeOnly) {
        return null;
    }
    const after = answer.slice(quoteIndex, Math.min(answer.length, quoteIndex + CLAIM_FILE_WINDOW_CHARS));
    const afterMatches = after.match(FILE_PATH_REGEX);
    if (afterMatches && afterMatches.length > 0) {
        return afterMatches[0];
    }
    return null;
}

const FSTRING_REGEX = /f(["'])((?:(?!\1)[\s\S])*?)\1/g;
const TEMPLATE_LITERAL_REGEX = /`((?:[^`\\]|\\.)*)`/g;
/** A template's own placeholder(s) resolved to a real value shouldn't run past this
 * many characters (a number, percentage, or short name) -- bounding it, rather than
 * an unbounded wildcard, keeps two coincidentally-matching literal fragments from
 * letting unrelated fabricated text slip through in between. */
const TEMPLATE_PLACEHOLDER_MAX_CHARS = 40;

/**
 * Extracts f-string (Python) / template-literal (JS/TS) spans from evidence
 * content that contain at least one interpolation placeholder ({expr},
 * {expr:fmt}, or ${expr}) -- candidates for the "paraphrased template, not a
 * fabricated literal" check below.
 */
function extractTemplateSpans(content: string): string[] {
    const spans: string[] = [];
    let m: RegExpExecArray | null;
    FSTRING_REGEX.lastIndex = 0;
    while ((m = FSTRING_REGEX.exec(content)) !== null) {
        if (/\{[^}]*\}/.test(m[2])) {
            spans.push(m[2]);
        }
    }
    TEMPLATE_LITERAL_REGEX.lastIndex = 0;
    while ((m = TEMPLATE_LITERAL_REGEX.exec(content)) !== null) {
        if (/\$\{[^}]*\}/.test(m[1])) {
            spans.push(m[1]);
        }
    }
    return spans;
}

/** Builds a regex matching any string that could result from filling in this
 * template's placeholder(s) with real values -- literal segments must match
 * exactly (regex-escaped), placeholder segments become a bounded wildcard.
 * `anchored` (default) requires the WHOLE tested string to match, for
 * comparing against an already-extracted quote; pass false to search for the
 * pattern inside a larger window (a bare number has no quote boundaries to
 * anchor to). */
function templateToRegex(template: string, anchored = true): RegExp {
    const normalized = normalizeCodeForComparison(template);
    const parts = normalized.split(/\{[^}]*\}|\$\{[^}]*\}/);
    const escaped = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const body = escaped.join(`.{0,${TEMPLATE_PLACEHOLDER_MAX_CHARS}}?`);
    return new RegExp(anchored ? `^${body}$` : body, 's');
}

/**
 * True if `quote` plausibly derives from filling in one of the real f-string /
 * template-literal spans found in `content` with an illustrative value, rather
 * than being a fabricated literal unrelated to any real template in evidence.
 *
 * Found live: `customization_interview_agent.py` returns
 * `f"We couldn't hear you clearly (confidence: {confidence:.0%}). Please try
 * again."` -- a real message the model correctly explained with an example
 * filled-in value ("...confidence: 70%)..."), which the exact-substring quote
 * check blocked, since the evidence only contains the unresolved
 * `{confidence:.0%}` placeholder, never a literal percentage. This does not
 * relax verification of the surrounding literal text -- only the placeholder
 * segment(s) are free to vary, and only when a real template exists in
 * evidence with the answer's literal wording matching it exactly.
 *
 * `anchored` (default true) requires `quote` itself to be nothing MORE than
 * the template's resolution -- correct for a genuine quote, which IS just the
 * quoted string. A fenced code block claiming the same resolved value is a
 * LARGER text (e.g. `raise Exception(f"...60s")`, not just `"...60s"`), so
 * the fence-attribution check passes `anchored: false` to search for the
 * template's resolution somewhere within the fence's own (already-bounded)
 * text instead of requiring the whole fence to be nothing but that literal.
 */
function matchesTemplateInContent(quote: string, content: string, anchored = true): boolean {
    const normalizedQuote = normalizeCodeForComparison(quote);
    for (const span of extractTemplateSpans(content)) {
        if (templateToRegex(span, anchored).test(normalizedQuote)) {
            return true;
        }
    }
    return false;
}

/** How much surrounding answer text to search for a template's fixed wording
 * around a bare number (no quote marks to anchor a proximity window to, unlike
 * matchesTemplateInContent's quoted-string case). */
const TEMPLATE_NUMBER_WINDOW_CHARS = 60;

/**
 * Same idea as matchesTemplateInContent, for a bare (unquoted) numeric claim:
 * "the confidence: 70%" fabricates no quote marks, but the number still comes
 * from resolving the exact same f-string placeholder the quote check handles
 * (`{confidence:.0%}`) -- found in the same real case (audit-04) after fixing
 * the quote check alone: the surrounding sentence's quote passed, but the bare
 * "70" inside it still tripped the separate numeric-claims check, which has no
 * concept of quote boundaries at all.
 */
function numberMatchesTemplateNearby(answer: string, numIndex: number, numLength: number, templateSpans: string[]): boolean {
    const windowStart = Math.max(0, numIndex - TEMPLATE_NUMBER_WINDOW_CHARS);
    const windowEnd = Math.min(answer.length, numIndex + numLength + TEMPLATE_NUMBER_WINDOW_CHARS);
    const window = answer.slice(windowStart, windowEnd);
    return templateSpans.some(span => templateToRegex(span, false).test(window));
}

/** Matches structurally-generic single-line code fragments (bare control-flow
 * keywords, plain import statements) that could plausibly appear in ANY
 * file's fence in roughly the right order by coincidence -- excluded from
 * counting as the "distinctive" line fenceLinesMatchInOrder requires below,
 * so a block made entirely of these can't pass on structure alone. */
const GENERIC_CODE_LINE_REGEX = /^(try|else|finally|pass|break|continue)\s*:?\s*$|^except\b.*:?\s*$|^(import|from)\s+[\w.]+(\s+import\s+[\w.,\s*]+)?$/;

/**
 * Fallback for a fenced code block that fails the whole-block contiguous
 * substring check: true when every one of its normalized lines is present in
 * `content` (already normalized), in the same relative order they appear in
 * the fence (a monotonically-advancing search cursor, not re-searched from
 * the start each time -- the same pattern used for the fallback-chain
 * ordering check elsewhere in this codebase), AND at least one of those lines
 * is both >= CODE_QUOTE_MIN_LENGTH and not a GENERIC_CODE_LINE_REGEX match.
 *
 * Exists because a real, verbatim-correct answer can still fail the
 * contiguous check for reasons that have nothing to do with fabrication --
 * found live, both confirmed real via a fresh-from-disk file comparison:
 * (a) flattening a multi-line f-string concatenation into one fence line
 * using literal "\n" text as a human-readable line-break marker (unflattened
 * back into real line breaks below before splitting -- a model that types
 * "A.\nB\nC.\n" is claiming A, B, and C are separate real lines, not that the
 * literal four-character sequence "\n" appears in the source); (b) eliding
 * an intervening structural line (here, a bare `try:`) between two real,
 * verbatim, correctly-ordered lines -- a fully correct answer about
 * ArtifactManager._save_atomic()'s real tempfile prefix/suffix was blocked
 * as "likely fabricated" solely because its illustrative fence dropped one
 * line between two exact, real ones.
 *
 * The distinctive-line requirement is the safety valve against the failure
 * mode this could otherwise open up: splitting a genuinely fabricated block
 * into small fragments and hoping each one coincidentally matches somewhere
 * unrelated. A block made entirely of short, generic fragments in
 * coincidentally-plausible order does not pass -- disclosed as a residual
 * limit in ROADMAP.md, not silently tolerated.
 */
function fenceLinesMatchInOrder(rawCode: string, content: string): boolean {
    const unflattened = rawCode.replace(/\\n/g, '\n');
    const lines = normalizeCodeForComparison(unflattened).split('\n').filter(line => line.length > 0);
    if (lines.length === 0) {
        return false;
    }
    let cursor = 0;
    let hasDistinctiveLine = false;
    for (const line of lines) {
        const idx = content.indexOf(line, cursor);
        if (idx === -1) {
            return false;
        }
        cursor = idx + line.length;
        if (line.length >= CODE_QUOTE_MIN_LENGTH && !GENERIC_CODE_LINE_REGEX.test(line)) {
            hasDistinctiveLine = true;
        }
    }
    return hasDistinctiveLine;
}

/** Resolves a path fragment mentioned in prose (e.g. "orchestrator_agent.py") to the
 * full evidence-cited path, then to an absolute, readable path if possible. */
function resolveEvidenceFilePath(claimedFile: string, allFiles: Set<string>, workspaceRoot?: string): string | null {
    const matched = Array.from(allFiles).find(f => f.endsWith(claimedFile));
    if (!matched) {
        return null;
    }
    if (path.isAbsolute(matched)) {
        return matched;
    }
    return workspaceRoot ? path.join(workspaceRoot, matched) : null;
}

interface NumericFact {
    symbol: string;
    value: number;
    file: string;
    line: number;
}

/** Below this length, a symbol's stripped full name is too generic to trust as
 * a standalone single-word proximity match -- see symbolProximityTokens. */
const MIN_STANDALONE_SYMBOL_CHARS = 8;

/** Below this length, an individual word SEGMENT of a compound symbol is
 * dropped as noise -- unless it's a distinctive short prefix excluded from
 * GENERIC_SHORT_WORD_TOKENS below. Lowered from 4 to 3 (found live): a 4-char
 * floor stripped meaningful short prefixes like "min"/"max" out of compound
 * names -- "min_words" degenerated to the single surviving word "words",
 * weakening "require ALL of the symbol's words nearby" down to "require one
 * maximally generic word nearby" (a numbered-list answer mentioning "words"
 * with no relation to min_words at all still matched). Lowering this floor
 * can only make the AND-match in findNearbyNumericFacts STRICTER (more
 * distinct words must co-occur nearby), never looser, so it's safe by
 * construction for the existing all-words-required logic. */
const MIN_WORD_TOKEN_CHARS = 3;

/** Common short English function words that must never count as one of a
 * symbol's "distinctive" word tokens, even once MIN_WORD_TOKEN_CHARS is low
 * enough to admit them -- without this exclusion, a symbol whose segments
 * happened to include one of these would risk the same generic-word
 * collision class this filter exists to prevent, just via two filler words
 * instead of one. */
const GENERIC_SHORT_WORD_TOKENS = new Set([
    'the', 'and', 'for', 'are', 'was', 'has', 'can', 'all', 'not', 'but',
    'you', 'his', 'her', 'its', 'our', 'who', 'how', 'why', 'now', 'out'
]);

/**
 * Splits a fact's symbol into its distinctive word tokens: strips a leading
 * self./this./cls. instance-reference prefix (a fact for
 * "self.confidence_threshold" must still match the answer saying just
 * "confidence_threshold"), then splits snake_case/camelCase/bracket/quote
 * boundaries, keeping only tokens >= MIN_WORD_TOKEN_CHARS chars that aren't
 * themselves a generic English function word (drops true noise like
 * "id"/"is"/"the" while preserving meaningful short prefixes like
 * "min"/"max"/"num"). Also returns the full stripped symbol (lowercased) as
 * a separate exact-phrase candidate.
 *
 * `specific` is false for a symbol too generic to trust matching alone: a
 * single word under MIN_STANDALONE_SYMBOL_CHARS (found live -- a fact named
 * just "base", 4 chars, matched an unrelated "4 attempts" claim that happened
 * to have SOME mention of "base" nearby in the answer's broader evidence
 * discussion). A compound name (2+ word tokens, e.g. "confidence_threshold")
 * is always specific regardless of individual word length, since matching it
 * already requires ALL of its words present, not just one.
 */
function symbolProximityTokens(symbol: string): { fullPhrase: string; words: string[]; specific: boolean } {
    const stripped = symbol.replace(/^(self|this|cls)\./i, '');
    const words = stripped
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^a-zA-Z0-9]+/)
        .map(w => w.toLowerCase())
        .filter(w => w.length >= MIN_WORD_TOKEN_CHARS && !GENERIC_SHORT_WORD_TOKENS.has(w));
    const uniqueWords = Array.from(new Set(words));
    const fullPhrase = stripped.toLowerCase();
    const specific = uniqueWords.length >= 2 || fullPhrase.length >= MIN_STANDALONE_SYMBOL_CHARS;
    return { fullPhrase, words: uniqueWords, specific };
}

/**
 * Finds real, structured numeric_threshold facts named within
 * CLAIM_SYMBOL_WINDOW_CHARS of a numeric claim -- either by the full compound
 * symbol appearing verbatim ("confidence_threshold"), or by EVERY one of its
 * distinctive word tokens appearing somewhere nearby ("a certain threshold"
 * ... "the confidence is below" both present matches "confidence_threshold"
 * via ["confidence","threshold"]), even though the answer never spells out
 * the attribute's exact name.
 *
 * Requires ALL word tokens, not just one, deliberately: found live (this
 * check's own first real-pipeline run) that requiring only one shared word
 * let "confidence_threshold" and an unrelated frontend "confidence_score"
 * state variable collide on the single shared word "confidence" -- the
 * mechanism blocked a genuinely wrong claim but attributed it to the wrong
 * fact. Requiring the full word SET disambiguates compound names that share
 * one generic modifier but differ in their more specific second word.
 *
 * Deliberately narrow to numeric_threshold facts: factExtractor.ts emits one
 * unconditionally for every numeric literal assignment (regardless of
 * const-ness), with value already parsed as a real number (valueKind:
 * 'number') straight from the AST assignment node -- never from a docstring
 * or comment, since tree-sitter's assignment-node walk never descends into a
 * string literal's own text. A stale docstring value can appear in evidence
 * CONTENT (the unit's raw text) but can never produce this fact type. This is
 * what lets the caller trust these facts as "the live value," not just
 * "present somewhere."
 */
function findNearbyNumericFacts(answer: string, claimIndex: number, claimLength: number, numericFacts: NumericFact[]): NumericFact[] {
    const windowStart = Math.max(0, claimIndex - CLAIM_SYMBOL_WINDOW_CHARS);
    const windowEnd = Math.min(answer.length, claimIndex + claimLength + CLAIM_SYMBOL_WINDOW_CHARS);
    const window = answer.slice(windowStart, windowEnd).toLowerCase();

    return numericFacts.filter(fact => {
        const { fullPhrase, words, specific } = symbolProximityTokens(fact.symbol);
        if (!specific) {
            return false;
        }
        if (window.includes(fullPhrase)) {
            return true;
        }
        return words.length > 0 && words.every(word => window.includes(word));
    });
}

export class AnswerGate {
    verify(answer: string, packet: EvidencePacket, policy: AnswerGatePolicy = DEFAULT_POLICY, workspaceRoot?: string, graphLookup?: FileUsageGraphLookup): GateResult {
        const result: GateResult = {
            outcome: 'pass',
            supported_claims: [],
            unsupported_claims: [],
            removed_or_rewritten_claims: [],
            required_gaps: [],
            finalAnswer: answer,
            diagnostics: []
        };

        // Combine all evidence content for substring matching
        const allContent = [
            ...packet.facts.map(f => f.content),
            ...packet.items.map(i => i.content)
        ].join(' ');

        const allFiles = new Set([
            ...packet.facts.map(f => f.file),
            ...packet.items.map(i => i.file)
        ]);

        const allSymbols = new Set(
            packet.facts.map(f => f.symbol).filter(Boolean) as string[]
        );

        // Fresh-from-disk reads for citation-content verification below, memoized per
        // verify() call so repeated citations to the same file only read it once.
        // Deliberately re-reads the real file rather than trusting `allContent`, since
        // that blob is a token-budget-trimmed subset of the full evidence -- checking
        // only against it wouldn't catch a claim that's wrong because the disambiguating
        // evidence got trimmed out before generation.
        const fileContentCache = new Map<string, string | null>();
        const readFileFresh = (filePath: string): string | null => {
            if (fileContentCache.has(filePath)) {
                return fileContentCache.get(filePath) ?? null;
            }
            let content: string | null;
            try {
                content = fs.readFileSync(filePath, 'utf8');
            } catch {
                content = null;
            }
            fileContentCache.set(filePath, content);
            return content;
        };

        const lowerAnswer = answer.toLowerCase();
        const hasGapPhrase = lowerAnswer.includes('does not determine') ||
                             lowerAnswer.includes('cannot determine') ||
                             lowerAnswer.includes('missing') ||
                             lowerAnswer.includes('not explicitly stated') ||
                             lowerAnswer.includes('does not specify');

        // If the answer is a gap refusal, we don't aggressively block on numbers/quotes
        // because the LLM might be restating the question (e.g. "I cannot determine if 0.85 is...").
        const skipStrictBlocking = hasGapPhrase;

        // 1. Check numeric claims
        //
        // Structured, AST-derived numeric_threshold facts -- reliable ground truth
        // for a NAMED attribute's live value. factExtractor.ts emits one
        // unconditionally for every numeric literal in an assignment, with the
        // value parsed straight from the AST's right-hand-side node -- never from
        // a docstring or comment, since a tree-sitter assignment-node walk never
        // descends into a string literal's own text. A stale docstring value (e.g.
        // an old design's example return value) can appear in evidence CONTENT --
        // the unit's raw source text, which is what the loose substring check
        // below matches against -- but can never produce this fact type. Built
        // once, reused for every numeric claim in the loop below.
        const numericThresholdFacts: NumericFact[] = [];
        for (const f of packet.facts) {
            if (f.type === 'numeric_threshold' && f.symbol) {
                const parsed = Number(f.content);
                if (!isNaN(parsed)) {
                    numericThresholdFacts.push({ symbol: f.symbol, value: parsed, file: f.file, line: f.startLine });
                }
            }
        }

        // Same real f-string/template spans the quote check uses (see
        // matchesTemplateInContent) -- a bare number can legitimately be the
        // model's filled-in example for an unresolved {placeholder}, same as a
        // quoted string can. Built once, reused for every numeric claim below.
        const templateSpans = extractTemplateSpans(allContent);

        const numberRegex = /\b\d+(\.\d+)?\b/g;
        const numberMatches = policy.checkNumericClaims ? Array.from(answer.matchAll(numberRegex)) : [];
        const indicesByNumber = new Map<string, number[]>();
        for (const m of numberMatches) {
            const list = indicesByNumber.get(m[0]) ?? [];
            list.push(m.index);
            indicesByNumber.set(m[0], list);
        }
        for (const num of indicesByNumber.keys()) {
            const numVal = Number(num);

            // Markdown ordered-list markers ("1. ", "2) ") are formatting, never a
            // semantic claim about a value -- excluded per-occurrence (the same
            // digit can still be a genuine claim elsewhere in the same answer) from
            // every occurrence-based check below. supportedByContent/ListCount/ById
            // are content/fact-level checks independent of occurrence position, so
            // they're unaffected and keep their existing (already permissive)
            // behavior either way.
            const claimIndices = indicesByNumber.get(num)!.filter(idx => !isListMarkerContext(answer, idx, num.length));
            if (claimIndices.length === 0) {
                // Every occurrence of this number was a list marker -- there is no
                // real claim left to verify at all, so this number is skipped
                // entirely rather than forced through supportedByContent's
                // occurrence-independent substring check (which exists for actual
                // claims, not formatting artifacts, and could otherwise still block
                // a small ordinal that doesn't happen to coincidentally appear
                // elsewhere in the evidence).
                continue;
            }

            // Check if this number exists in the packet content
            // We use simple substring match to avoid strict word boundary issues
            // with characters like (, [, -, or ?.
            const supportedByContent = allContent.includes(num);

            const supportedByListCount = packet.facts.some(f =>
                (f.type === 'list_count' || f.type === 'numeric_threshold') && f.content === num
            );

            // Note: citation ids (e.g. [id: 123]) will also be captured as numbers.
            // We should allow them if they correspond to an item ID.
            const supportedById = packet.items.some(i => String(i.id) === num) || packet.facts.some(f => String(f.id) === num);

            // A number used as a specific in-function line reference (e.g. "at line 900",
            // or as one end of a hyphenated range like "900-927") is tolerated if it falls
            // within an already-cited evidence item's real line span -- even though it
            // isn't a literal substring of the evidence blob (only the item's own
            // startLine-endLine boundary text is). This only applies when the number is
            // used in a line-number-shaped context; a bare count/threshold/percentage
            // still requires literal substring support.
            const supportedByLineSpan = !supportedByContent && !supportedByListCount && !supportedById &&
                claimIndices.some(idx => isLineNumberContext(answer, idx, num.length)) &&
                packet.items.some(item => numVal >= item.startLine && numVal <= item.endLine);

            // Same "resolved template placeholder" allowance the quote check gets
            // (matchesTemplateInContent) -- a bare number with no quote marks around
            // it can equally be the model's filled-in example for an unresolved
            // {placeholder} in a real f-string/template-literal.
            const supportedByTemplate = templateSpans.length > 0 &&
                claimIndices.some(idx => numberMatchesTemplateNearby(answer, idx, num.length, templateSpans));

            // Symbol-anchored contradiction check: even when the number above IS
            // textually "supported" (it may be sitting in a stale docstring/comment,
            // not live code -- see the block comment above numericThresholdFacts), a
            // real structured assignment fact for the SAME named attribute, with a
            // DIFFERENT value, is more authoritative than raw prose presence. Fires
            // only when exactly one distinct real value is found near this specific
            // claim -- if two different attributes' facts are both named nearby with
            // different values, that's genuine ambiguity (e.g. two thresholds
            // discussed close together), and this deliberately does not guess which
            // one the claim refers to; it falls through to the existing checks
            // unchanged. This can only ever make an otherwise-passing claim stricter,
            // never looser.
            let contradiction: NumericFact | undefined;
            if (numericThresholdFacts.length > 0) {
                for (const idx of claimIndices) {
                    const nearby = findNearbyNumericFacts(answer, idx, num.length, numericThresholdFacts);
                    const distinctValues = new Set(nearby.map(f => f.value));
                    if (distinctValues.size === 1) {
                        const [onlyValue] = distinctValues;
                        // Domain guard: a sub-1 fraction attribute (a confidence / probability /
                        // ratio threshold, e.g. confidence_threshold = 0.55) cannot have an
                        // integer >= 1 as its value. Such an integer sitting near the attribute in
                        // the answer is a LINE REFERENCE (e.g. "the check at line 277" where the
                        // threshold is read) or an unrelated count -- not a competing value -- so
                        // it must not be flagged as a contradiction. This was blocking the flagship
                        // demo answer ("277 contradicts 0.55"). Genuine value contradictions are
                        // unaffected: a wrong FRACTION (0.85 vs 0.55) is not an integer, and
                        // integer-valued thresholds vs integer claims still compare normally.
                        const factIsFraction = Math.abs(onlyValue) > 0 && Math.abs(onlyValue) < 1;
                        const numIsUnitInteger = Number.isInteger(numVal) && Math.abs(numVal) >= 1;
                        const implausibleAsValue = factIsFraction && numIsUnitInteger;

                        // Generalized citation-leak guard. The fraction case above only
                        // covers a sub-1 fact (0.55 vs "277"); the SAME underlying bug --
                        // the model echoing citation metadata as if it were content --
                        // also happens integer-to-integer and was blocking a correct
                        // answer: `MIN_RESOLUTION_PX = 1000` is DEFINED on line 9, the
                        // answer mentioned "9", and the gate reported "Numeric claim 9
                        // contradicts the actual value 1000". A candidate that exactly
                        // equals the line number where the contradicting fact itself
                        // lives is a reference to that definition, not a rival value for
                        // it. Deliberately narrow: it must match THAT fact's own line, so
                        // a genuinely wrong value (999 vs 1000) is unaffected unless it
                        // happens to be the very line the constant sits on.
                        const matchesFactOwnLine = nearby.some(f => f.value === onlyValue && f.line === numVal);
                        if (onlyValue !== numVal && !implausibleAsValue && !matchesFactOwnLine) {
                            contradiction = nearby.find(f => f.value === onlyValue);
                            break;
                        }
                    }
                }
            }

            if (contradiction) {
                result.unsupported_claims.push(`Numeric: ${num} (contradicts ${contradiction.symbol}=${contradiction.value})`);
                if (!skipStrictBlocking) {
                    const mode = packet.plan.confidence_mode || 'exact';
                    if (mode === 'exact' || mode === 'grounded') {
                        result.diagnostics.push(`Numeric claim ${num} contradicts the actual value of "${contradiction.symbol}" (${contradiction.value}, from ${contradiction.file}:${contradiction.line}) -- likely derived from stale documentation, a comment, or a superseded value rather than the live code.`);
                        result.outcome = 'block';
                    }
                }
            } else if (supportedByContent || supportedByListCount || supportedById || supportedByLineSpan || supportedByTemplate) {
                result.supported_claims.push(`Numeric: ${num}`);
            } else {
                result.unsupported_claims.push(`Numeric: ${num}`);
                if (!skipStrictBlocking) {
                    const mode = packet.plan.confidence_mode || 'exact';
                    if (mode === 'exact') {
                        result.diagnostics.push(`Unsupported numeric claim: ${num}`);
                        result.outcome = 'block';
                    } else if (mode === 'grounded') {
                        const isFloat = !Number.isInteger(numVal);
                        const isPercentage = answer.includes(`${num}%`);
                        const isLarge = numVal >= 100;

                        // Check if num is accompanied by narrative context
                        const contextRegex = new RegExp(`${num}\\s+(files|modules|handlers|steps|stages|plugins|dependencies|components|directories|folders)`, 'i');
                        const hasContext = contextRegex.test(answer);

                        if (isFloat || isPercentage || (isLarge && !hasContext)) {
                            result.diagnostics.push(`Unsupported numeric claim: ${num}`);
                            result.outcome = 'block';
                        }
                    }
                    // conceptual mode: never hard block on numbers
                }
            }
        }

        // 2. Check gaps
        // CROSS-REFERENCE: the prepend sentence below must stay byte-identical to
        // webviews/sidebar/gateStatusRendering.js's GATE_PREPEND_TEXTS[0], so the
        // webview can strip it from the flowing answer and render it as a notice bar
        // instead of plain prose. src/test/webviews/gateStatusRendering.test.ts
        // enforces the match.
        if (packet.gaps && packet.gaps.length > 0) {
            if (!hasGapPhrase) {
                result.required_gaps.push(...packet.gaps);
                result.finalAnswer = "The evidence does not determine the full answer due to missing facts. " + answer;
                result.removed_or_rewritten_claims.push("Forced gap acknowledgement");
                result.diagnostics.push("Answer lacked gap phrasing; prepended disclaimer.");
                if (result.outcome === 'pass') {
                    result.outcome = 'revise';
                }
            }
        }

        // 3. Check quoted strings, including per-citation attribution verification.
        //
        // Scanned on the answer WITH fenced code blocks removed: fence content is
        // verified by its own check (3b below), and scanning it here is actively
        // wrong -- a Python `"""docstring"""` inside a fence pairs the naive `"..."`
        // regex across fence boundaries, manufacturing giant pseudo-"quotes" that mix
        // code and prose and can never match evidence (found in fc-09: a correct
        // answer was blocked on exactly such an artifact, plus real quotes that
        // failed only on a one-space indentation difference -- hence the
        // normalizeCodeForComparison() comparison below as well).
        const answerOutsideFences = answer.replace(FENCED_CODE_REGEX, ' ');
        const normalizedAllContent = normalizeCodeForComparison(allContent);
        const quoteRegex = /"([^"]+)"/g;
        let quoteMatch;
        while (policy.checkQuotedStrings && (quoteMatch = quoteRegex.exec(answerOutsideFences)) !== null) {
            const innerStr = quoteMatch[1];
            const quoteIndex = quoteMatch.index;
            const normalizedQuote = normalizeCodeForComparison(innerStr);
            const quoteInEvidence =
                normalizedAllContent.includes(normalizedQuote) ||
                normalizedAllContent.includes(normalizeCodeForComparison(innerStr.replace(/"/g, "'"))) ||
                matchesTemplateInContent(innerStr, allContent);
            // Disallow hallucinated quotes unless it's a short stopword/phrase or it appears in evidence.
            // We check both exact match and a version where the original might have used single quotes.
            if (innerStr.length > 5 && !quoteInEvidence) {
                result.unsupported_claims.push(`Quote: "${innerStr}"`);
                if (!skipStrictBlocking) {
                    const mode = packet.plan.confidence_mode || 'exact';
                    if (mode === 'exact' || mode === 'grounded') {
                        result.diagnostics.push(`Unsupported quoted string: "${innerStr}"`);
                        result.outcome = 'block';
                    }
                }
                continue;
            }

            // The quote is real text from somewhere in the evidence. For longer,
            // code-shaped quotes attributed to a specific file in the surrounding
            // prose, additionally verify that file's real content actually contains
            // it -- catches a real quote from file A being misattributed to file B.
            if (policy.checkFilePaths && innerStr.length >= CODE_QUOTE_MIN_LENGTH) {
                const claimedFile = findNearestClaimedFile(answerOutsideFences, quoteIndex);
                if (claimedFile) {
                    const absolutePath = resolveEvidenceFilePath(claimedFile, allFiles, workspaceRoot);
                    const realContent = absolutePath ? readFileFresh(absolutePath) : null;
                    if (realContent !== null) {
                        const normalizedReal = normalizeCodeForComparison(realContent);
                        const matchesClaimedFile =
                            normalizedReal.includes(normalizedQuote) ||
                            normalizedReal.includes(normalizeCodeForComparison(innerStr.replace(/"/g, "'"))) ||
                            matchesTemplateInContent(innerStr, realContent);
                        if (!matchesClaimedFile) {
                            result.unsupported_claims.push(`Misattributed quote: "${innerStr}" (claimed from ${claimedFile})`);
                            if (!skipStrictBlocking) {
                                const mode = packet.plan.confidence_mode || 'exact';
                                if (mode === 'exact' || mode === 'grounded') {
                                    result.diagnostics.push(`Quoted code attributed to ${claimedFile} does not appear in that file's real content -- likely misattributed from a different cited file.`);
                                    result.outcome = 'block';
                                }
                            }
                            continue;
                        }
                    }
                }
            }

            result.supported_claims.push(`Quote: "${innerStr}"`);
        }

        // 3b. Check fenced code blocks (```...```) -- the same "this is real code" claim as a
        // "..." quote above, just a syntax the model reaches for when illustrating something
        // longer than one line (e.g. "here's a simplified example"). Without this, a fabricated
        // method body dressed up as an illustrative code fence sails through the quote check
        // above untouched, since that check only matches double-quoted strings.
        let fenceMatch;
        const unverifiedFenceBlocks: string[] = [];
        while (policy.checkQuotedStrings && (fenceMatch = FENCED_CODE_REGEX.exec(answer)) !== null) {
            const rawCode = fenceMatch[1];
            const normalizedCode = normalizeCodeForComparison(rawCode);
            if (normalizedCode.length < CODE_QUOTE_MIN_LENGTH) {
                continue;
            }
            const fenceIndex = fenceMatch.index;

            if (!normalizedAllContent.includes(normalizedCode) && !fenceLinesMatchInOrder(rawCode, normalizedAllContent)) {
                result.unsupported_claims.push(`Fenced code block (not found in evidence): ${rawCode.trim().slice(0, 80)}...`);
                if (!skipStrictBlocking) {
                    const mode = packet.plan.confidence_mode || 'exact';
                    if (mode === 'exact' || mode === 'grounded') {
                        result.diagnostics.push('Fenced code block does not match any evidence content -- likely fabricated illustrative code.');
                        result.outcome = 'block';
                    } else {
                        unverifiedFenceBlocks.push(fenceMatch[0]);
                    }
                }
                continue;
            }

            // The code is real text from somewhere in the evidence. If a specific file is
            // claimed nearby, verify that file's real content actually contains it too --
            // catches a real fence from file A being misattributed to file B.
            if (policy.checkFilePaths) {
                const claimedFile = findNearestClaimedFile(answer, fenceIndex, /* beforeOnly */ true);
                if (claimedFile) {
                    const absolutePath = resolveEvidenceFilePath(claimedFile, allFiles, workspaceRoot);
                    const realContent = absolutePath ? readFileFresh(absolutePath) : null;
                    if (realContent !== null) {
                        const normalizedReal = normalizeCodeForComparison(realContent);
                        const matchesClaimedFile = normalizedReal.includes(normalizedCode) ||
                            matchesTemplateInContent(rawCode, realContent, /* anchored */ false) ||
                            fenceLinesMatchInOrder(rawCode, normalizedReal);
                        if (!matchesClaimedFile) {
                            result.unsupported_claims.push(`Misattributed fenced code block (claimed from ${claimedFile}): ${rawCode.trim().slice(0, 80)}...`);
                            if (!skipStrictBlocking) {
                                const mode = packet.plan.confidence_mode || 'exact';
                                if (mode === 'exact' || mode === 'grounded') {
                                    result.diagnostics.push(`Fenced code block attributed to ${claimedFile} does not appear in that file's real content -- likely misattributed from a different cited file.`);
                                    result.outcome = 'block';
                                } else {
                                    unverifiedFenceBlocks.push(fenceMatch[0]);
                                }
                            }
                            continue;
                        }
                    }
                }
            }

            result.supported_claims.push(`Fenced code block: ${rawCode.trim().slice(0, 80)}...`);
        }

        // 3c. Conceptual-mode fence remediation: blocking is off above (by design -- see
        // UNVERIFIED_FENCE_ANNOTATION), but leaving a failed fence silently unenforced let a
        // fully fabricated code block sail through broad architecture answers untouched.
        // Middle ground: flag the specific offending fence inline in finalAnswer and downgrade
        // pass -> revise (the existing gate-rewrote-the-answer tier). Insertion is anchored on
        // the fence's own text, not saved offsets, because earlier checks (gap acknowledgement)
        // may already have prepended to finalAnswer; a moving cursor keeps duplicate identical
        // fences each annotated once, in order. A failed lookup skips insertion rather than
        // guessing -- never corrupt the answer to place a warning.
        if (unverifiedFenceBlocks.length > 0) {
            let annotationCursor = 0;
            for (const fenceBlock of unverifiedFenceBlocks) {
                const foundAt = result.finalAnswer.indexOf(fenceBlock, annotationCursor);
                if (foundAt === -1) {
                    result.diagnostics.push('Conceptual mode: an unverified fence could not be located in the final answer text; annotation skipped.');
                    continue;
                }
                const insertAt = foundAt + fenceBlock.length;
                result.finalAnswer = result.finalAnswer.slice(0, insertAt) + UNVERIFIED_FENCE_ANNOTATION + result.finalAnswer.slice(insertAt);
                annotationCursor = insertAt + UNVERIFIED_FENCE_ANNOTATION.length;
                result.removed_or_rewritten_claims.push(`Annotated unverified fenced code block: ${fenceBlock.trim().slice(0, 80)}...`);
                result.diagnostics.push('Conceptual mode: annotated an unverified fenced code block inline instead of blocking.');
                if (result.outcome === 'pass') {
                    result.outcome = 'revise';
                }
            }
        }

        // 4. Check file paths and symbols mentioned as file/paths
        const pathMatches = policy.checkFilePaths ? (answer.match(FILE_PATH_REGEX) || []) : [];
        for (const p of new Set(pathMatches)) {
            // A path is grounded if it's one of the evidence FILES -- or if it appears
            // verbatim inside evidence CONTENT. The second clause matters for data
            // artifacts: "mission_report.json"/"draft.json" are filenames that exist
            // only as string literals in the code (save_artifact(...,
            // "mission_report.json", ...)) and can never be evidence files themselves,
            // yet an answer citing where a report is written is quoting exactly what
            // it read. Measured (subTaskFlakinessProbe.ts): this false positive
            // DETERMINISTICALLY blocked a correct persistence answer 6/6 runs. Claims
            // about such a file's contents are still checked by the quote/fence/
            // numeric verifiers -- only the mention itself is legitimized here.
            const supported = Array.from(allFiles).some(f => f.endsWith(p)) || normalizedAllContent.includes(p);
            if (!supported) {
                result.unsupported_claims.push(`Path: ${p}`);
                const mode = packet.plan.confidence_mode || 'exact';
                if (mode === 'exact' || mode === 'grounded') {
                    // A path can be absent from evidence for two very different reasons:
                    // hallucinated, or real-but-deliberately-excluded from indexing (backup/
                    // archive/temp patterns). Found dogfooding: asking about a real
                    // mission_orchestrator.backup.py surfaced the raw "Unsupported path:
                    // backup.py" internal string -- technically true, useless to a developer
                    // looking at that file in their editor. FILE_PATH_REGEX stops at the last
                    // dot-segment ("backup.py"), but exclusion globs like *.backup.py only
                    // match the full name -- so recover the fuller dotted mention from the
                    // answer text before testing. Only the default patterns are checked (the
                    // gate has no access to user-configured excludePatterns); a user-excluded
                    // file still gets the generic message, which stays honest.
                    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const fullerMention = new RegExp(`[\\w.-]*${escaped}`).exec(answer)?.[0] ?? p;
                    if (isIgnoredByPatterns(fullerMention, getAllIgnorePatterns())) {
                        result.diagnostics.push(
                            `"${fullerMention}" matches one of RepoGuide's indexing exclusion patterns (backup/archive/temp files are deliberately not indexed), so there is no evidence about it. If you need it analyzed, rename it or adjust repoguide.excludePatterns and re-sync the index.`
                        );
                    } else {
                        result.diagnostics.push(`Unsupported path: ${p}`);
                    }
                    result.outcome = 'block';
                }
            } else {
                result.supported_claims.push(`Path: ${p}`);
            }
        }

        // 5. Fallback chains
        const fallbackFacts = packet.facts.filter(f => f.type === 'fallback_chain');
        if (fallbackFacts.length > 0) {
            // Group by the unit (falling back to file) each fact was extracted from --
            // NOT one global ordering check across every fallback_chain fact in the whole
            // packet. Two facts merely sharing a symbol string (e.g. a generic name like
            // "key" or "status" appearing in unrelated fallback/retry code in two different
            // files) are not necessarily part of the same real chain; checking their
            // relative order against each other produces a false "out of order" flag that
            // has nothing to do with any real reordering. Scoping to unitId/file ties the
            // check to facts that plausibly describe the SAME chain.
            const groups = new Map<string, typeof fallbackFacts>();
            for (const f of fallbackFacts) {
                const key = f.unitId ?? f.file ?? 'unknown';
                const list = groups.get(key) ?? [];
                list.push(f);
                groups.set(key, list);
            }

            let valid = true;
            for (const groupFacts of groups.values()) {
                // Within one real chain's facts, search forward from a monotonically-
                // advancing cursor (the position the previous fact in this chain was found
                // at) rather than re-running answer.indexOf(f.symbol) from position 0 every
                // time -- otherwise a symbol that legitimately recurs across multiple chain
                // facts (e.g. the same class name at several steps of the chain) keeps
                // getting compared against its own static first occurrence and gets flagged
                // as "out of order" against itself, over and over, in a longer, connective
                // answer that naturally repeats a name multiple times.
                //
                // Duplicate facts for the exact same (unit, symbol) pair -- e.g. the same
                // source line extracted more than once -- are collapsed to their first
                // occurrence within the group. Confirmed via real CraftConnect data: a single
                // unit can carry several byte-identical fallback_chain facts, and the answer
                // legitimately only mentions that symbol once; requiring N separate forward
                // occurrences for N duplicate records of the same fact is not a real ordering
                // requirement, just an artifact of the fact extractor recording it more than
                // once.
                const seenSymbols = new Set<string>();
                let searchCursor = 0;
                for (const f of groupFacts) {
                    if (!f.symbol) {continue;}
                    if (seenSymbols.has(f.symbol)) {continue;}
                    seenSymbols.add(f.symbol);
                    const idx = answer.indexOf(f.symbol, searchCursor);
                    if (idx !== -1) {
                        // Found at or after the cursor -- in order by construction. Only
                        // advance the cursor on a genuinely new (forward) position.
                        searchCursor = idx;
                    } else if (answer.includes(f.symbol)) {
                        // Not found from the cursor onward, but it does appear earlier in
                        // the text -- a genuine reordering, not just a symbol that's absent.
                        valid = false;
                        result.unsupported_claims.push(`Fallback Chain Mismatch: ${f.symbol}`);
                        result.diagnostics.push(`Symbol ${f.symbol} appeared out of order in fallback chain.`);
                    }
                    // Absent entirely (not found anywhere) is left unflagged, matching prior behavior.
                }
            }
            if (!valid) {
                const mode = packet.plan.confidence_mode || 'exact';
                if (mode === 'exact' || mode === 'grounded') {
                    result.outcome = 'block';
                }
            }
        }

        // 6. Comparative equivalence claims ("identical"/"same code"/"no difference")
        // spanning 2+ cited files -- verified against real file content, not the
        // (possibly stale/trimmed) evidence blob. A different failure shape from a
        // misattributed quote: there's no quoted string to check, just a false
        // claim of equivalence between two real, distinct files.
        if (policy.checkFilePaths && EQUIVALENCE_PHRASE_REGEX.test(answer)) {
            const sentences = answer.split(/(?<=[.!?])\s+/);
            for (const sentence of sentences) {
                if (!EQUIVALENCE_PHRASE_REGEX.test(sentence)) {
                    continue;
                }

                const mentionedPaths = Array.from(new Set(sentence.match(FILE_PATH_REGEX) || []));
                const resolvedFiles = Array.from(new Set(
                    mentionedPaths
                        .map(p => Array.from(allFiles).find(f => f.endsWith(p)))
                        .filter((f): f is string => Boolean(f))
                ));
                if (resolvedFiles.length < 2) {
                    continue;
                }

                const absolutePaths = resolvedFiles
                    .map(f => path.isAbsolute(f) ? f : (workspaceRoot ? path.join(workspaceRoot, f) : null))
                    .filter((f): f is string => Boolean(f));
                if (absolutePaths.length !== resolvedFiles.length) {
                    continue; // can't verify without every file resolvable to a real path
                }

                const contents = absolutePaths.map(readFileFresh);
                if (contents.some(c => c === null)) {
                    continue;
                }

                const normalized = contents.map(c => c!.replace(/\r\n/g, '\n').trimEnd());
                const allEqual = normalized.every(c => c === normalized[0]);
                if (!allEqual) {
                    result.unsupported_claims.push(`Comparative equivalence claim contradicted by real file content: ${resolvedFiles.join(', ')}`);
                    if (!skipStrictBlocking) {
                        const mode = packet.plan.confidence_mode || 'exact';
                        if (mode === 'exact' || mode === 'grounded') {
                            result.diagnostics.push(`Answer claims ${resolvedFiles.join(' and ')} are identical/equivalent, but their real content differs.`);
                            result.outcome = 'block';
                        }
                    }
                }
            }
        }

        // 6b. File-usage claim verification (see FILE_USAGE_PREDICATE_REGEX doc).
        // When the answer asserts a specific FILE is used/imported by other code but
        // the program graph shows no other file imports it, that "used" claim is
        // contradicted. Surfaced as a loud caveat + revise (not a hard block): file
        // usage is occasionally dynamic/importlib-driven and invisible to the graph,
        // so an un-missable warning is safer than a refusal, while still flagging.
        if (graphLookup) {
            for (const claim of detectFileUsageClaims(answer)) {
                const base = claim.subject.split(/[\\/]/).pop() ?? claim.subject;
                if (isEntryPointOrFrameworkWired(claim.subject, workspaceRoot, readFileFresh)) {
                    continue; // entry points (run, not imported) and framework-wired
                    // routers/middleware (mounted elsewhere via an edge the import graph
                    // misses) legitimately have no direct importers -- not dead code.
                }
                let importers: { filePath: string }[];
                try {
                    importers = graphLookup.getDependents(claim.subject).importers ?? [];
                } catch {
                    continue; // graph unavailable for this subject -- do not fabricate a contradiction
                }
                // Keep only importers that are OTHER files. getDependents also pulls
                // inbound edges of units contained in the file, so an intra-file edge
                // can surface with the subject file's own path -- exclude those by
                // precise path/basename identity (not a loose substring match, which
                // could wrongly drop a real external importer whose path contains the
                // stem, producing a false contradiction).
                const externalImporters = importers.filter(n => {
                    const f = n.filePath || '';
                    return !(f === claim.subject || f.endsWith('/' + claim.subject) || f.endsWith('\\' + claim.subject) || (f.split(/[\\/]/).pop() === base));
                });
                if (externalImporters.length === 0) {
                    const msg = `Answer asserts \`${claim.subject}\` ${claim.predicate}, but the program graph shows no other code imports it (possible dead code).`;
                    result.unsupported_claims.push(msg);
                    result.diagnostics.push(msg);
                    const caveat = `⚠️ RepoGuide could not confirm that \`${claim.subject}\` is actually used -- the program graph shows no other file imports it, so it may be dead code. `;
                    if (!result.finalAnswer.includes(caveat)) {
                        result.finalAnswer = caveat + result.finalAnswer;
                    }
                    if (result.outcome === 'pass') {
                        result.outcome = 'revise';
                    }
                }
            }
        }

        // 7. Conceptual Mode Fallback
        // CROSS-REFERENCE: the prepend sentence below must stay byte-identical to
        // webviews/sidebar/gateStatusRendering.js's GATE_PREPEND_TEXTS[1] -- same
        // drift guard as the gap-check prepend above.
        if (packet.plan.confidence_mode === 'conceptual' && (packet.coverageScore === undefined || packet.coverageScore < 0.5)) {
            if (!hasGapPhrase && !result.finalAnswer.includes('partial architectural coverage')) {
                result.finalAnswer = "The retrieved evidence provides only partial architectural coverage. " + result.finalAnswer;
                result.diagnostics.push("Conceptual mode: Appended uncertainty language due to low coverage.");
                if (result.outcome === 'pass') {
                    result.outcome = 'revise';
                }
            }
        }

        return result;
    }

    /** True if the file is an application entry point (run, not imported) OR defines
     *  a framework-registered router/middleware (mounted elsewhere via
     *  include_router/add_middleware -- an edge the import graph misses). In both
     *  cases the absence of inbound importers is expected, not dead code. Read from
     *  the subject file's own content when resolvable. */
}
