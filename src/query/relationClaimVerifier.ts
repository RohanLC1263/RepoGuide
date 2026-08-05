/**
 * Mechanically checks a prose RELATION claim -- "<file> calls/uses <symbol>" -- against the
 * claimed file's real source.
 *
 * THE FAILURE THIS TARGETS. Asked "what depends on X", the local model narrates over
 * co-occurring retrieval chunks and asserts inbound dependents that do not exist. Two
 * distinct classes were measured against real CraftConnect source (2026-08-04):
 *
 *   Class A -- TRUE ABSENCE. The claimed dependent does not contain the symbol at all.
 *     All seven instances recorded in ROADMAP.md ("Still open", 2026-07-25) are this shape:
 *     `ArtifactManager` claimed in community_engine.py / studio_read.py / studio_write.py /
 *     auth.py, and `RAGRetrieverAgent` claimed in conversation_agent.py /
 *     explanation_agent.py / auth_validator_agent.py -- 0 occurrences in every one.
 *
 *   Class B -- DIRECTION INVERSION. The claimed dependent DOES contain the symbol, but only
 *     as its own definition. The recorded `adv-hot-3` run named ten callers of `execute`;
 *     every one has exactly one `def execute` and zero call sites. The model enumerated the
 *     DEFINERS of a method and narrated them as its CALLERS. The sole real caller in that
 *     repo is base_agent.py:171 (`output = await self.execute(inputs)`), which the answer
 *     never mentions.
 *
 * WHY THIS READS FILES INSTEAD OF ASKING THE GRAPH. A symbol-scoped usage check was built
 * previously and rejected (see the comment above `detectFileUsageClaims` in answerGate.ts):
 * it asked the program graph, and framework wiring produces no graph edge, so genuinely-used
 * symbols got flagged. `ObservabilityMiddleware` is the canonical case -- registered via
 * `app.add_middleware(ObservabilityMiddleware)`, real, but invisible to the import graph.
 * Reading the file gets that right where the graph could not: main.py textually contains the
 * symbol in code position, so it is correctly NOT flagged. This check therefore inherits
 * neither the ~38%/13% inbound-edge precision wall documented in deadFileDetector.ts nor the
 * lowercased bare-name collisions in ProgramGraphStore's symbol index (where `execute`
 * unifies every agent method with sqlite3's `cursor.execute`).
 *
 * SAFETY PROPERTY: only claims that NAME THE FILE are verified. The detector requires a file
 * path and a symbol in the same clause, so the file to read comes from the answer itself --
 * there is no symbol->file resolution step and therefore no resolution ambiguity. A claim
 * that names no file is left alone rather than guessed at.
 *
 * DIRECTION OF ERROR: every ambiguity resolves toward NOT flagging. If a definition site is
 * not recognised and survives stripping, it counts as a use and the claim passes unflagged
 * (a false negative). Only a precise, recognised definition is removed. Over-removal is what
 * would produce a false positive, so the definition patterns are deliberately narrow.
 *
 * DELIBERATELY OUT OF SCOPE: claims with no file named, anaphoric subjects ("it uses this
 * instance"), and the transitive shape ("other methods ... which ultimately depend on X").
 * Measured recall on the real recorded fabrication is 9 of 10 claims; the missed one is the
 * transitive shape. Recall can grow later -- precision is the property worth protecting here,
 * because this project has already reverted two checks for over-flagging.
 */

/** A prose claim that a specific FILE uses a specific SYMBOL. */
export interface RelationClaim {
    /** Path as written in the answer (relative, e.g. "app/agents/packager_agent.py"). */
    file: string;
    /** The symbol the file is claimed to use. */
    symbol: string;
    /** Matched text, for diagnostics. */
    context: string;
}

/** A claim contradicted by the file's real contents. */
export interface RelationViolation extends RelationClaim {
    /** 'absent'  -- the symbol appears nowhere in the file (Class A).
     *  'defines' -- the symbol appears ONLY as this file's own definition (Class B). */
    reason: 'absent' | 'defines';
}

/** Relation predicates the model actually used in the measured answers, plus close variants.
 *  Kept to verbs that assert USE; "defines", "implements" and "contains" are deliberately
 *  absent because they are true statements about a definer and must never be flagged.
 *
 *  The optional `s` is load-bearing, not cosmetic: the one claim this check originally missed
 *  reads "...which ultimately depend on the `execute` method" -- plural subject, so bare
 *  "depend", which a `depends`-only pattern cannot see. */
const RELATION_PREDICATE = '(?:calls?|uses?|depends?\\s+on|invokes?|instantiates?|references?|imports?|consumes?)';

/** A repo-relative source path with a directory component. Requiring the separator keeps bare
 *  mentions like "agent.py" -- which cannot be resolved unambiguously -- out of scope. */
const FILE_IN_CLAIM = '((?:[\\w.-]+[/\\\\])+[\\w.-]+\\.(?:py|ts|tsx|js|jsx|java|go|rs|cs|rb))';

/**
 * `<file> ... <predicate> ... \`<symbol>\``, within one clause.
 *
 * Clause-bounded by `[^.\n]` on both gaps: a period or newline ends the claim, so a file named
 * in one sentence cannot be paired with a symbol from the next. That bound is what keeps
 * precision high enough to act on -- measured 0 false detections across both recorded
 * accurate answers (adv-hot-1, adv-hot-2).
 */
const RELATION_CLAIM_REGEX = new RegExp(
    '`?' + FILE_IN_CLAIM + '`?[^.\\n]{0,80}?\\b' + RELATION_PREDICATE + '\\b[^.\\n]{0,60}?`([A-Za-z_][\\w]*)`',
    'gi'
);

/** Negated clauses ("does not call", "is never used by") are honest denials, not claims. */
const RELATION_NEGATION_REGEX = /\b(?:not|never|no|n't|nowhere|without)\b/i;

/** Start of a numbered markdown list item -- the format every measured inbound-dependency
 *  answer used, one claimed dependent per item. */
const LIST_ITEM_SPLIT_REGEX = /^[ \t]*\d+\.[ \t]/m;

/** Any repo-relative source path mentioned in a block. */
const FILE_MENTION_REGEX = new RegExp('`?' + FILE_IN_CLAIM + '`?', 'gi');

/** `<predicate> ... \`<symbol>\`` within one clause, with no file required -- the file comes
 *  from the enclosing list item. */
const PREDICATE_SYMBOL_REGEX = new RegExp(
    '\\b' + RELATION_PREDICATE + '\\b[^.\\n]{0,60}?`([A-Za-z_][\\w]*)`',
    'gi'
);

/**
 * Extracts "<file> uses <symbol>" claims from an answer. Exported for direct testing.
 *
 * Two passes, because the measured fabrication uses two structures:
 *
 *  1. CLAUSE-LOCAL -- "The `PackagerAgent` in `app/agents/packager_agent.py` calls the
 *     `execute` method". File and symbol sit in one clause; this is the dominant shape.
 *
 *  2. LIST-ITEM-SCOPED -- the file is named in the item's first sentence and the assertion
 *     lands in the second: "The `execute` method in `app/agents/customization_interview_agent.py`
 *     handles different actions[...]. Other methods within this class call [...] which
 *     ultimately depend on the `execute` method." A clause-local pattern cannot cross that
 *     period, and the clause bound is exactly what keeps pass 1 precise, so widening it is not
 *     an option -- the item boundary supplies the missing scope instead.
 *
 * Pass 2 fires ONLY when the list item names exactly one distinct file. Two or more files in
 * one item makes the subject genuinely ambiguous, and guessing there is how a precision-first
 * check turns into an over-flagging one; such items are skipped rather than resolved.
 *
 * Measured on the real recorded answers: pass 1 alone caught 9 of 10 fabricated claims; both
 * passes catch 10 of 10, while the two accurate answers still produce zero violations.
 */
export function detectRelationClaims(answer: string): RelationClaim[] {
    const claims: RelationClaim[] = [];
    const seen = new Set<string>();
    const add = (file: string, symbol: string, context: string): void => {
        const key = `${file}::${symbol}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        claims.push({ file, symbol, context: context.trim() });
    };

    // Pass 1 -- clause-local.
    const clauseRegex = new RegExp(RELATION_CLAIM_REGEX.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = clauseRegex.exec(answer)) !== null) {
        const [context, file, symbol] = m;
        if (RELATION_NEGATION_REGEX.test(context)) {
            continue;
        }
        add(file, symbol, context);
    }

    // Pass 2 -- list-item-scoped.
    const blocks = answer.split(new RegExp(LIST_ITEM_SPLIT_REGEX.source, 'gm')).slice(1);
    for (const block of blocks) {
        const files = new Set<string>();
        const fileRegex = new RegExp(FILE_MENTION_REGEX.source, 'gi');
        let fm: RegExpExecArray | null;
        while ((fm = fileRegex.exec(block)) !== null) {
            files.add(fm[1]);
        }
        if (files.size !== 1) {
            continue;
        }
        const file = [...files][0];
        const predRegex = new RegExp(PREDICATE_SYMBOL_REGEX.source, 'gi');
        let pm: RegExpExecArray | null;
        while ((pm = predRegex.exec(block)) !== null) {
            const window = block.slice(Math.max(0, pm.index - 25), pm.index + pm[0].length);
            if (RELATION_NEGATION_REGEX.test(window)) {
                continue;
            }
            add(file, pm[1], pm[0]);
        }
    }
    return claims;
}

/**
 * Removes comments and string literals so a symbol named only in prose, a docstring or a log
 * message is never mistaken for a use.
 *
 * This is load-bearing on real data. base_agent.py -- the one genuine caller of `execute` --
 * names it twice in its module docstring before the real call at line 171, and
 * story_gen_agent.py contains the literal `"StoryGenAgent.execute() called on deprecated
 * agent"` inside a `logger.warning(...)`, which reads exactly like a call site but is a
 * string. Without stripping, that string alone would mask a real Class B fabrication.
 *
 * Ordering matters: triple-quoted forms are consumed before single-quoted ones so a docstring
 * containing an apostrophe cannot desynchronise the single-quote pass.
 */
export function stripCommentsAndStrings(source: string): string {
    let out = source;
    out = out.replace(/"""[\s\S]*?"""/g, ' ');
    out = out.replace(/'''[\s\S]*?'''/g, ' ');
    out = out.replace(/\/\*[\s\S]*?\*\//g, ' ');
    out = out.replace(/"(?:[^"\\\n]|\\.)*"/g, ' ');
    out = out.replace(/'(?:[^'\\\n]|\\.)*'/g, ' ');
    out = out.replace(/`(?:[^`\\]|\\.)*`/g, ' ');
    out = out.replace(/#[^\n]*/g, ' ');
    out = out.replace(/\/\/[^\n]*/g, ' ');
    return out;
}

/**
 * True when `source` references `symbol` somewhere OTHER than its own definition.
 *
 * Definition forms removed are narrow and language-spanning: `def X`, `async def X`, `class X`
 * (Python), `function X`, `class X` (JS/TS), and `func X` (Go). Anything not matched survives
 * and counts as a use, which is the conservative direction -- see DIRECTION OF ERROR above.
 */
export function usesSymbolInCodePosition(source: string, symbol: string): boolean {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let code = stripCommentsAndStrings(source);
    code = code.replace(new RegExp('\\b(?:async\\s+)?def\\s+' + escaped + '\\b', 'g'), ' ');
    code = code.replace(new RegExp('\\bclass\\s+' + escaped + '\\b', 'g'), ' ');
    code = code.replace(new RegExp('\\b(?:async\\s+)?function\\s+' + escaped + '\\b', 'g'), ' ');
    code = code.replace(new RegExp('\\bfunc\\s+' + escaped + '\\b', 'g'), ' ');
    return new RegExp('\\b' + escaped + '\\b').test(code);
}

/**
 * Verifies every detected relation claim against the claimed file's real source.
 *
 * `readFile` receives the path exactly as written in the answer and returns its contents, or
 * null when the file cannot be read. An unreadable file yields NO violation: the check only
 * ever reports a contradiction it positively established.
 */
export function verifyRelationClaims(
    answer: string,
    readFile: (relativePath: string) => string | null
): RelationViolation[] {
    const violations: RelationViolation[] = [];
    for (const claim of detectRelationClaims(answer)) {
        const source = readFile(claim.file);
        if (source === null) {
            continue;
        }
        if (usesSymbolInCodePosition(source, claim.symbol)) {
            continue;
        }
        const present = new RegExp('\\b' + claim.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(source);
        violations.push({ ...claim, reason: present ? 'defines' : 'absent' });
    }
    return violations;
}
