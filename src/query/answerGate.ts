import * as fs from 'fs';
import * as path from 'path';
import { EvidencePacket } from './evidencePacket';
import { getAllIgnorePatterns, isIgnoredByPatterns } from '../indexing/fileWalker';

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
/** Below this length a quote reads as a short phrase/stopword, not a real code excerpt worth a disk re-read. */
const CODE_QUOTE_MIN_LENGTH = 20;
/** Matches fenced code blocks (```lang\n...\n```) -- the same "this is real code" claim as a "..." quote, just a different syntax the model reaches for when illustrating something longer than a single line. */
const FENCED_CODE_REGEX = /```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g;

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

export class AnswerGate {
    verify(answer: string, packet: EvidencePacket, policy: AnswerGatePolicy = DEFAULT_POLICY, workspaceRoot?: string): GateResult {
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
        const numberRegex = /\b\d+(\.\d+)?\b/g;
        const numberMatches = policy.checkNumericClaims ? Array.from(answer.matchAll(numberRegex)) : [];
        const indicesByNumber = new Map<string, number[]>();
        for (const m of numberMatches) {
            const list = indicesByNumber.get(m[0]) ?? [];
            list.push(m.index);
            indicesByNumber.set(m[0], list);
        }
        for (const num of indicesByNumber.keys()) {
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
            const numVal = Number(num);
            const supportedByLineSpan = !supportedByContent && !supportedByListCount && !supportedById &&
                indicesByNumber.get(num)!.some(idx => isLineNumberContext(answer, idx, num.length)) &&
                packet.items.some(item => numVal >= item.startLine && numVal <= item.endLine);

            if (supportedByContent || supportedByListCount || supportedById || supportedByLineSpan) {
                result.supported_claims.push(`Numeric: ${num}`);
            } else {
                result.unsupported_claims.push(`Numeric: ${num}`);
                if (!skipStrictBlocking) {
                    const mode = packet.plan.confidence_mode || 'exact';
                    if (mode === 'exact') {
                        result.diagnostics.push(`Unsupported numeric claim: ${num}`);
                        result.outcome = 'block';
                    } else if (mode === 'grounded') {
                        const numVal = Number(num);
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
                normalizedAllContent.includes(normalizeCodeForComparison(innerStr.replace(/"/g, "'")));
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
                            normalizedReal.includes(normalizeCodeForComparison(innerStr.replace(/"/g, "'")));
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
        while (policy.checkQuotedStrings && (fenceMatch = FENCED_CODE_REGEX.exec(answer)) !== null) {
            const rawCode = fenceMatch[1];
            const normalizedCode = normalizeCodeForComparison(rawCode);
            if (normalizedCode.length < CODE_QUOTE_MIN_LENGTH) {
                continue;
            }
            const fenceIndex = fenceMatch.index;

            if (!normalizedAllContent.includes(normalizedCode)) {
                result.unsupported_claims.push(`Fenced code block (not found in evidence): ${rawCode.trim().slice(0, 80)}...`);
                if (!skipStrictBlocking) {
                    const mode = packet.plan.confidence_mode || 'exact';
                    if (mode === 'exact' || mode === 'grounded') {
                        result.diagnostics.push('Fenced code block does not match any evidence content -- likely fabricated illustrative code.');
                        result.outcome = 'block';
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
                        const matchesClaimedFile = normalizeCodeForComparison(realContent).includes(normalizedCode);
                        if (!matchesClaimedFile) {
                            result.unsupported_claims.push(`Misattributed fenced code block (claimed from ${claimedFile}): ${rawCode.trim().slice(0, 80)}...`);
                            if (!skipStrictBlocking) {
                                const mode = packet.plan.confidence_mode || 'exact';
                                if (mode === 'exact' || mode === 'grounded') {
                                    result.diagnostics.push(`Fenced code block attributed to ${claimedFile} does not appear in that file's real content -- likely misattributed from a different cited file.`);
                                    result.outcome = 'block';
                                }
                            }
                            continue;
                        }
                    }
                }
            }

            result.supported_claims.push(`Fenced code block: ${rawCode.trim().slice(0, 80)}...`);
        }

        // 4. Check file paths and symbols mentioned as file/paths
        const pathMatches = policy.checkFilePaths ? (answer.match(FILE_PATH_REGEX) || []) : [];
        for (const p of new Set(pathMatches)) {
            // See if this path ends with any of the files in evidence
            const supported = Array.from(allFiles).some(f => f.endsWith(p));
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

        // 7. Conceptual Mode Fallback
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
}
