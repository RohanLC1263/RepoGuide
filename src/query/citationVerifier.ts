import * as fs from 'fs';
import * as path from 'path';

/**
 * Mechanically checks that a claim's citation actually SUPPORTS the claim, rather than
 * merely being a real file that exists.
 *
 * WHY THIS IS NOT MORE PROMPTING. Forcing the model to emit a claims table with an
 * explicit `SUPPORT:` citation per claim was measured on the local model against a
 * matched baseline. It fixes exactly one failure class -- fabrication when the packet
 * contains nothing to cite, where the model does write `SUPPORT: NONE` and abstain.
 * It does NOT fix misattribution, because the local model treats `SUPPORT` as a LOOKUP
 * ("find an evidence item containing a related token") rather than a VERIFICATION
 * ("does this item establish this claim?"). The starkest measured instance: asked what
 * depends on `RAGRetrieverAgent`, it claimed `Depends` is used to depend on
 * RAGRetrieverAgent and cited ~20 real file:line locations -- every one a route
 * decorator or unrelated signature, in a file where `RAGRetrieverAgent` appears zero
 * times. The citations were all real; none supported the claim.
 *
 * A model cannot be prompted out of that, because it believes it complied. So the check
 * is moved off the model entirely: for a claim of the form "<symbol> ... <file>", read
 * the real file and confirm the symbol is actually in it. Deterministic, no inference.
 *
 * DELIBERATELY OUT OF SCOPE: branch-logic inversion. A citation can be entirely correct
 * and still be attached to an inverted conclusion (measured: MADHUBANI at confidence
 * 0.86 / second-best 0.75 must yield REQUIRE_USER_CONFIRMATION because margin 0.11 <
 * 0.15, and both prompting conditions answered AUTO_ACCEPT while citing the right
 * lines). This verifies provenance, not reasoning; that ceiling is why the separate
 * deterministic branch-bypass exists.
 */

/** A claim the answer makes, pairing an asserted symbol with the file it cites. */
export interface CitedSymbolClaim {
    symbol: string;
    file: string;
    /** The matched text, for diagnostics. */
    context: string;
}

/**
 * Identifier-shaped tokens worth verifying. Deliberately requires a code-ish shape
 * (CamelCase, snake_case, or an explicit call) so ordinary prose nouns are not treated
 * as symbols -- flagging "the mission" or "the request" would be constant noise.
 */
// The leading `_?` is load-bearing: private helpers are exactly what fabricated
// helper-function lists are made of. The measured pdf_generator.py case invented five
// names and every one of them began with an underscore (`_truncate`, `_safe_list`,
// `_get_title`, `_get_description`, `_get_materials`), so a pattern requiring a leading
// letter could not see any of them.
// Third alternative (`_name`) is separate because a leading underscore with NO internal
// underscore -- `_truncate` -- is not snake_case and was invisible to the other two.
// That is the exact shape of the measured fabrication, so it must be its own case.
const SYMBOL_SHAPE = /\b(_?[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|_?[a-z][a-z0-9]*(?:_[a-z0-9]+)+|_[a-z][a-z0-9]{2,})\b/g;

/** A file path mentioned in the answer (with extension, optionally with :line). */
const FILE_MENTION = /\b((?:[\w.-]+[/\\])*[\w.-]+\.(?:py|ts|tsx|js|jsx|java|go|rs|cs|cpp|rb))\b/g;

/** Words that look like symbols but are prose or framework nouns, not project symbols. */
const SYMBOL_STOPWORDS = new Set([
    'JavaScript', 'TypeScript', 'JSON', 'HTTP', 'HTTPS', 'API', 'URL', 'UUID',
    'README', 'TODO', 'NOTE', 'FastAPI', 'PostgreSQL', 'SQLite'
]);

/** Max chars between a symbol and a file mention for them to be considered one claim. */
const CLAIM_WINDOW = 200;

/**
 * A markdown section boundary: a heading, or a numbered/bulleted item introducing a bold
 * label. Proximity must not reach across one of these.
 *
 * WHY. Measured false positive: an answer opened "The `MissionOrchestratorAgent`,
 * `MissionCoordinator`, and `OrchestratorAgent` classes serve distinct purposes", then
 * began "### 1. **MissionOrchestratorAgent** - **File**: app/agents/mission_orchestrator.py".
 * The third name in that opening list sat 155 characters from a citation that plainly
 * belonged to the FIRST name, so it was paired with it and reported as unsupported --
 * even though `OrchestratorAgent` is a real class in app/agents/orchestrator_agent.py and
 * the answer never claimed otherwise. The answer was right; the checker invented the
 * claim. A citation introduced under its own heading belongs to that heading.
 */
const SECTION_BOUNDARY = /\n\s*(?:#{1,6}\s|(?:[-*+]|\d+\.)\s+\*\*)/g;

/**
 * Anaphoric reference back to a file established earlier ("the file contains...",
 * "this module exposes...").
 *
 * WHY. The most common real fabrication shape on the broader test set is a bulleted list
 * of invented names sitting far outside CLAIM_WINDOW from the filename that governs it.
 * Measured: an answer about `pdf_generator.py` invented five helper functions
 * (`_truncate`, `_safe_list`, `_get_title`, `_get_description`, `_get_materials` -- the
 * real ones are `_register_font_alias`, `fmt_craft`, `draw_shell`, `divider`,
 * `section_label`, `wrap`) and introduced them with "The file contains several helper
 * functions like ...", 1,444 characters after the filename. Pure proximity could never
 * reach that, so the checker never even formed the pair. An explicit textual reference
 * back to the file is a stronger binding signal than nearness, so it overrides the window.
 */
const FILE_ANAPHORA = /\b(?:the|this|that|its)\s+(?:file|module|script)\b/i;

/**
 * Extracts "<symbol> is in/used by <file>"-shaped pairings: any identifier-shaped token
 * appearing within CLAIM_WINDOW characters of a file path. Intentionally recall-oriented
 * -- verifyCitedSymbolClaims below only reports a pair when the file is readable AND the
 * symbol is genuinely absent, so an over-broad pairing cannot by itself produce a
 * false accusation.
 */
export function extractCitedSymbolClaims(answer: string): CitedSymbolClaim[] {
    const claims: CitedSymbolClaim[] = [];
    const seen = new Set<string>();

    const files: Array<{ file: string; index: number }> = [];
    let fm: RegExpExecArray | null;
    const fileRegex = new RegExp(FILE_MENTION.source, 'g');
    while ((fm = fileRegex.exec(answer)) !== null) {
        files.push({ file: fm[1], index: fm.index });
    }
    if (files.length === 0) {
        return claims;
    }

    let sm: RegExpExecArray | null;
    const symbolRegex = new RegExp(SYMBOL_SHAPE.source, 'g');
    while ((sm = symbolRegex.exec(answer)) !== null) {
        const symbol = sm[1];
        if (SYMBOL_STOPWORDS.has(symbol) || symbol.length < 4) {
            continue;
        }
        // Two ways a symbol can be bound to a file, checked in order of strength.
        //
        // 1. ANAPHORA (strongest): the sentence says "the file"/"this module", which
        //    explicitly refers back to the last filename mentioned. Distance is
        //    irrelevant -- the text states the binding.
        // 2. PROXIMITY: the nearest filename within CLAIM_WINDOW, provided no section
        //    boundary sits between them.
        const sentence = sentenceAround(answer, sm.index);
        let nearest: { file: string; index: number } | undefined;

        if (FILE_ANAPHORA.test(sentence)) {
            for (const f of files) {
                if (f.index < sm.index) { nearest = f; } else { break; }
            }
        }

        if (!nearest) {
            let bestDistance = Number.POSITIVE_INFINITY;
            for (const f of files) {
                const distance = Math.abs(f.index - sm.index);
                if (distance < bestDistance) { bestDistance = distance; nearest = f; }
            }
            if (!nearest || bestDistance > CLAIM_WINDOW || crossesSectionBoundary(answer, sm.index, nearest.index)) {
                continue;
            }
        }
        // A symbol that is part of the cited PATH (the filename, or any directory in it)
        // is a path fragment, not a claim about that file's contents -- e.g.
        // "craft_classifier_agent/decision_policy.py" would otherwise be read as a claim
        // that the symbol `craft_classifier_agent` lives inside decision_policy.py, and
        // reported as a violation. Measured as a real false positive before this guard.
        const pathLower = nearest.file.toLowerCase().replace(/\\/g, '/');
        const symbolLower = symbol.toLowerCase();
        const pathSegments = pathLower.split('/');
        const isPathFragment = pathSegments.some(seg =>
            seg === symbolLower || seg.replace(/\.[^.]+$/, '') === symbolLower || seg.startsWith(symbolLower));
        if (isPathFragment || pathLower.includes(symbolLower)) {
            continue;
        }
        const key = `${symbol}::${nearest.file}`;
        if (seen.has(key)) { continue; }
        seen.add(key);
        claims.push({
            symbol, file: nearest.file,
            context: answer.slice(Math.max(0, sm.index - 60), sm.index + 60).replace(/\s+/g, ' ').trim()
        });
    }
    return claims;
}

/** The sentence (or list item) containing `index`, used to look for an anaphoric binding. */
function sentenceAround(answer: string, index: number): string {
    const NEWLINE = String.fromCharCode(10);
    const start = Math.max(
        answer.lastIndexOf('. ', index),
        answer.lastIndexOf(NEWLINE, index)
    );
    let end = answer.indexOf('. ', index);
    const newline = answer.indexOf(NEWLINE, index);
    if (end === -1 || (newline !== -1 && newline < end)) { end = newline; }
    return answer.slice(start === -1 ? 0 : start + 1, end === -1 ? answer.length : end);
}

/** True when a markdown heading or bold list item separates the two offsets. */
function crossesSectionBoundary(answer: string, a: number, b: number): boolean {
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    const regex = new RegExp(SECTION_BOUNDARY.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = regex.exec(answer)) !== null) {
        if (m.index > to) { break; }
        if (m.index >= from && m.index < to) { return true; }
    }
    return false;
}

export interface CitationViolation extends CitedSymbolClaim {
    reason: string;
}

/**
 * Reports claims whose cited file demonstrably does NOT contain the symbol.
 *
 * Conservative by construction -- a claim is only reported when the file resolves on
 * disk AND is readable AND the symbol is absent from its full text. An unresolvable
 * path, a read failure, or anything ambiguous yields no violation, so the check can
 * only ever catch a citation that is provably wrong.
 */
export function verifyCitedSymbolClaims(
    answer: string,
    workspaceRoot: string | undefined,
    readFile: (absPath: string) => string | null,
    knownFiles: string[] = []
): CitationViolation[] {
    if (!workspaceRoot) {
        return [];
    }
    // Answers routinely cite a bare filename ("the pdf_generator.py file") rather than a
    // workspace-relative path. Such a citation cannot be resolved from the workspace root,
    // so before this it silently yielded no violation -- which is how the measured
    // five-invented-helper-functions case escaped even once its claims were being paired.
    // Bare names are resolved against the files actually in the evidence packet, and only
    // when exactly one of them has that basename; an ambiguous basename stays unresolved
    // rather than guessing which file the answer meant.
    const byBasename = new Map<string, string[]>();
    for (const file of knownFiles) {
        const base = normalizeSeparators(file).split('/').pop()?.toLowerCase();
        if (!base) { continue; }
        const bucket = byBasename.get(base) ?? [];
        if (!bucket.includes(file)) { bucket.push(file); }
        byBasename.set(base, bucket);
    }

    const violations: CitationViolation[] = [];
    for (const claim of extractCitedSymbolClaims(answer)) {
        let cited = claim.file;
        if (!/[/\\]/.test(cited)) {
            const matches = byBasename.get(cited.toLowerCase());
            if (matches && matches.length === 1) {
                cited = matches[0];
            }
        }
        const abs = path.isAbsolute(cited) ? cited : path.join(workspaceRoot, cited);
        let content: string | null;
        try {
            content = readFile(abs);
        } catch {
            continue;
        }
        if (content === null) {
            continue; // unresolvable path -- cannot prove anything
        }
        if (!new RegExp('\\b' + claim.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(content)) {
            violations.push({
                ...claim,
                reason: `"${claim.symbol}" does not appear anywhere in ${claim.file}`
            });
        }
    }
    return violations;
}

/** Windows and POSIX separators normalised, so path comparisons agree. */
function normalizeSeparators(file: string): string {
    return file.split('\\').join('/');
}

/** Convenience reader used when the caller has no memoized reader of its own. */
export function readFileOrNull(absPath: string): string | null {
    try {
        return fs.readFileSync(absPath, 'utf8');
    } catch {
        return null;
    }
}
