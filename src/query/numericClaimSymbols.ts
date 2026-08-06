/**
 * Extracts the symbol names an answer mentions NEAR a number, so a caller can fetch those
 * symbols' `numeric_threshold` facts before the gate runs.
 *
 * WHY THIS EXISTS (LIMITATIONS.md §3.4, "numeric cross-check is packet-bound"). The gate's
 * numeric-contradiction check compares a claimed number only against `numeric_threshold` facts
 * ALREADY IN THE EVIDENCE PACKET. When retrieval doesn't surface the relevant fact, the check
 * silently doesn't fire and a wrong number passes unexamined -- confirmed on the audit-03/04
 * questions, where the packet held 32 numeric facts and none for the symbol at issue. §3.4 calls
 * it "the safety net having holes", and it is felt exactly when the model is also wrong.
 *
 * WHY THE LOOKUP IS NOT DONE INSIDE THE GATE. `AnswerGate.verify()` is synchronous and pure;
 * `FactStore` is async. Making `verify()` async would rewrite every gate call site (8+) for an
 * I/O concern that belongs to the caller. So the gate stays synchronous and the dispatcher
 * pre-fetches, passing the extra facts in. This module is the pure half of that split and is
 * unit-testable without a store.
 *
 * PRECISION NOTE: this deliberately over-collects. Returning a symbol that has no
 * `numeric_threshold` fact costs one extra symbol added to the batch `findBySymbols` lookup this
 * feeds (`factStore.ts`'s `findBySymbols` is a full `SELECT * FROM facts WHERE 1=1` table scan
 * filtered in JS, NOT the indexed lookup this used to say -- corrected 2026-08-06, P2-3; the
 * `idx_fact_symbol` index exists but this path doesn't use it). On a large repo that scan is a
 * real per-query cost already paid once by `factExpansion.ts`'s own packet-build scan, so
 * over-collecting symbols here adds to an existing full-table cost rather than adding cheap
 * lookups on top of an indexed one. Still not fixed here: the over-collection itself is safe
 * (MISSING a symbol reopens the hole this closes, and the gate's existing symbol-proximity
 * matching still decides whether any fetched fact actually pertains to the claim), so this note
 * corrects the cost claim, not the behavior -- whether the scan itself is worth indexing is an
 * open question for whoever next measures `factStore.ts` under real load (STRICT_AUDIT_2026-08-04.md
 * P2-3 and its sibling P2-5, `ProgramGraphBuilder.build`'s per-unit round trip, are both
 * "measure before changing" perf findings from the same audit, still open as of 2026-08-06).
 */

/**
 * Same window the gate uses to decide a symbol "names" a nearby number
 * (`CLAIM_SYMBOL_WINDOW_CHARS` in answerGate.ts). Kept equal on purpose: fetching facts for
 * symbols outside the window would be work the gate then ignores.
 */
export const NUMERIC_CLAIM_SYMBOL_WINDOW = 150;

/** Bare numbers, matching the gate's own numeric-claim scan. */
const NUMBER_REGEX = /\b\d+(\.\d+)?\b/g;

/**
 * Code-shaped identifiers: SCREAMING_SNAKE (`MAX_RETRIES`), snake_case (`min_words`), and
 * CamelCase (`RetryPolicy`). Deliberately excludes bare lowercase words, which are prose far
 * more often than symbols and would flood the lookup with noise.
 */
const SYMBOL_SHAPE = /\b(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Z][a-zA-Z0-9]*[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g;

/** Prose words that match SYMBOL_SHAPE by accident and never name a project constant. */
const SYMBOL_STOPWORDS = new Set([
    'JavaScript', 'TypeScript', 'GitHub', 'RepoGuide', 'OpenAI',
    'README', 'TODO', 'NOTE', 'HTTP', 'HTTPS', 'JSON', 'API'
]);

/**
 * Symbol names appearing within `windowChars` of any number in `answer`.
 *
 * Deduplicated and capped so a pathological answer cannot turn into an unbounded fact query.
 * Returns [] when the answer contains no numbers at all -- the common case, and the cheapest
 * possible outcome for the caller.
 */
export function extractSymbolsNearNumbers(
    answer: string,
    windowChars: number = NUMERIC_CLAIM_SYMBOL_WINDOW,
    maxSymbols: number = 40
): string[] {
    const numberPositions: number[] = [];
    for (const m of answer.matchAll(NUMBER_REGEX)) {
        if (m.index !== undefined) {
            numberPositions.push(m.index);
        }
    }
    if (numberPositions.length === 0) {
        return [];
    }

    const found = new Set<string>();
    for (const m of answer.matchAll(SYMBOL_SHAPE)) {
        if (m.index === undefined) {
            continue;
        }
        const symbol = m[0];
        if (SYMBOL_STOPWORDS.has(symbol)) {
            continue;
        }
        const start = m.index;
        const end = start + symbol.length;
        const near = numberPositions.some(pos => pos >= start - windowChars && pos <= end + windowChars);
        if (near) {
            found.add(symbol);
            if (found.size >= maxSymbols) {
                break;
            }
        }
    }
    return [...found];
}
