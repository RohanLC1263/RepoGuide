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
const SYMBOL_SHAPE = /\b([A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;

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
        // Nearest file mention within the window.
        let nearest: { file: string; index: number } | undefined;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const f of files) {
            const distance = Math.abs(f.index - sm.index);
            if (distance < bestDistance) { bestDistance = distance; nearest = f; }
        }
        if (!nearest || bestDistance > CLAIM_WINDOW) {
            continue;
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
    readFile: (absPath: string) => string | null
): CitationViolation[] {
    if (!workspaceRoot) {
        return [];
    }
    const violations: CitationViolation[] = [];
    for (const claim of extractCitedSymbolClaims(answer)) {
        const abs = path.isAbsolute(claim.file) ? claim.file : path.join(workspaceRoot, claim.file);
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

/** Convenience reader used when the caller has no memoized reader of its own. */
export function readFileOrNull(absPath: string): string | null {
    try {
        return fs.readFileSync(absPath, 'utf8');
    } catch {
        return null;
    }
}
