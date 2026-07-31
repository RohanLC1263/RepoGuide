import { EvidenceItem } from '../query/evidencePacket';

/**
 * Tells a caller whether returned evidence is actually ABOUT what they asked for.
 *
 * WHY THIS EXISTS. `get_facts("NoSuchSymbolZZZ")` returned 49,762 characters of real,
 * correctly-formed facts about entirely unrelated symbols, and the query term appeared
 * nowhere in the response. Nothing was malformed and nothing errored -- the retrieval layer
 * simply falls back to its best-scoring items when a term matches nothing. To a calling
 * model that is indistinguishable from "here is the evidence for your question", which is a
 * fabrication trigger: it invites a confident answer about something that does not exist.
 *
 * The signal is DELIBERATELY STRUCTURED rather than a prose disclaimer, matching the
 * deterministic checks used everywhere else in this project: a caller (or the gate, or an
 * external agent) can branch on `verdict === 'none'` without parsing English.
 *
 * SCOPE NOTE, corrected from the audit that prompted this: `retrieveRawEvidence`'s only
 * production callers are the MCP tools -- the Chat path builds its packet through
 * `buildPacket` instead. Both share `retrievalOrchestrator.execute()` one level down, but
 * this signal is computed on the MCP side only and cannot alter Chat retrieval.
 */

export type RelevanceVerdict = 'exact' | 'partial' | 'none';

export interface EvidenceRelevance {
    /**
     * `exact`   -- at least one item names the query term itself.
     * `partial` -- items mention some query terms but none is a direct hit.
     * `none`    -- nothing returned relates to the query; treat the payload as NOT evidence
     *              for this question.
     */
    verdict: RelevanceVerdict;
    /** Items containing at least one significant query term. */
    matchedItems: number;
    totalItems: number;
    /** The terms actually searched for, so a caller can see what was matched against. */
    queryTerms: string[];
    /** Plain-language line for hosts that surface text rather than branching on the verdict. */
    note: string;
}

/** Too generic to indicate relevance if matched. */
const STOPWORDS = new Set([
    'the', 'this', 'that', 'and', 'for', 'with', 'from', 'what', 'where', 'when', 'how',
    'does', 'get', 'set', 'use', 'used', 'uses', 'any', 'all', 'its', 'are', 'was', 'were',
    'code', 'file', 'files', 'function', 'functions', 'class', 'method', 'value', 'about'
]);

/** Significant lowercase terms from the query. */
export function significantTerms(query: string): string[] {
    const raw = query.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    return Array.from(new Set(raw)).filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Deterministic, no model involved: an item is relevant if a significant query term appears
 * in its symbol, its file path, or its content. `exact` additionally requires that the
 * symbol IS the term (or the full query), which is what "I asked about X and got X" means.
 */
export function assessEvidenceRelevance(query: string, items: EvidenceItem[]): EvidenceRelevance {
    const terms = significantTerms(query);
    const totalItems = items.length;

    if (terms.length === 0 || totalItems === 0) {
        return {
            verdict: totalItems === 0 ? 'none' : 'partial',
            matchedItems: 0,
            totalItems,
            queryTerms: terms,
            note: totalItems === 0
                ? 'No evidence was retrieved for this query.'
                : 'The query had no distinctive terms to match against; relevance could not be assessed.'
        };
    }

    const queryLower = query.toLowerCase().trim();
    let matchedItems = 0;
    let exact = false;

    for (const item of items) {
        const symbol = (item.symbol ?? '').toLowerCase();
        const haystack = `${symbol}\n${(item.file ?? '').toLowerCase()}\n${(item.content ?? '').toLowerCase()}`;
        const hits = terms.filter(t => haystack.includes(t));
        if (hits.length > 0) {
            matchedItems++;
            if (symbol && (symbol === queryLower || terms.some(t => symbol === t))) {
                exact = true;
            }
        }
    }

    if (matchedItems === 0) {
        return {
            verdict: 'none',
            matchedItems,
            totalItems,
            queryTerms: terms,
            note: `Nothing retrieved matches "${query}". The ${totalItems} item(s) below are the ` +
                'retrieval layer\'s next-best results and are NOT evidence for this query -- do not ' +
                'treat them as support for a claim about it.'
        };
    }

    return {
        verdict: exact ? 'exact' : 'partial',
        matchedItems,
        totalItems,
        queryTerms: terms,
        note: exact
            ? `${matchedItems} of ${totalItems} item(s) directly reference "${query}".`
            : `${matchedItems} of ${totalItems} item(s) mention terms from "${query}", but none names it directly.`
    };
}
