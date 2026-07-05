import * as fs from 'fs';
import * as path from 'path';
import { EvidencePacket } from './evidencePacket';

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

/**
 * Finds the file path mentioned nearest a quote (checked before the quote first,
 * since "file.py: `...quoted code...`" is the common shape; falls back to after).
 * Returns null rather than guessing when no path-shaped token is nearby.
 */
function findNearestClaimedFile(answer: string, quoteIndex: number): string | null {
    const before = answer.slice(Math.max(0, quoteIndex - CLAIM_FILE_WINDOW_CHARS), quoteIndex);
    const beforeMatches = before.match(FILE_PATH_REGEX);
    if (beforeMatches && beforeMatches.length > 0) {
        return beforeMatches[beforeMatches.length - 1];
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
        const matches = policy.checkNumericClaims ? (answer.match(numberRegex) || []) : [];
        for (const num of new Set(matches)) {
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

            if (supportedByContent || supportedByListCount || supportedById) {
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

        // 3. Check quoted strings, including per-citation attribution verification
        const quoteRegex = /"([^"]+)"/g;
        let quoteMatch;
        while (policy.checkQuotedStrings && (quoteMatch = quoteRegex.exec(answer)) !== null) {
            const innerStr = quoteMatch[1];
            const quoteIndex = quoteMatch.index;
            // Disallow hallucinated quotes unless it's a short stopword/phrase or it appears in evidence.
            // We check both exact match and a version where the original might have used single quotes.
            if (innerStr.length > 5 && !allContent.includes(innerStr) && !allContent.includes(innerStr.replace(/"/g, "'"))) {
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
                const claimedFile = findNearestClaimedFile(answer, quoteIndex);
                if (claimedFile) {
                    const absolutePath = resolveEvidenceFilePath(claimedFile, allFiles, workspaceRoot);
                    const realContent = absolutePath ? readFileFresh(absolutePath) : null;
                    if (realContent !== null) {
                        const matchesClaimedFile = realContent.includes(innerStr) || realContent.includes(innerStr.replace(/"/g, "'"));
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

        // 4. Check file paths and symbols mentioned as file/paths
        const pathMatches = policy.checkFilePaths ? (answer.match(FILE_PATH_REGEX) || []) : [];
        for (const p of new Set(pathMatches)) {
            // See if this path ends with any of the files in evidence
            const supported = Array.from(allFiles).some(f => f.endsWith(p));
            if (!supported) {
                result.unsupported_claims.push(`Path: ${p}`);
                const mode = packet.plan.confidence_mode || 'exact';
                if (mode === 'exact' || mode === 'grounded') {
                    result.diagnostics.push(`Unsupported path: ${p}`);
                    result.outcome = 'block';
                }
            } else {
                result.supported_claims.push(`Path: ${p}`);
            }
        }

        // 5. Fallback chains
        const fallbackFacts = packet.facts.filter(f => f.type === 'fallback_chain');
        if (fallbackFacts.length > 0) {
            // Find positions of the facts in the answer
            // The chain expects them to appear in a certain order.
            // Simplified: verify the indices of their symbols in the answer are strictly increasing.
            let lastIndex = -1;
            let valid = true;
            for (const f of fallbackFacts) {
                if (!f.symbol) continue;
                const idx = answer.indexOf(f.symbol);
                if (idx !== -1) {
                    if (idx < lastIndex) {
                        valid = false;
                        result.unsupported_claims.push(`Fallback Chain Mismatch: ${f.symbol}`);
                        result.diagnostics.push(`Symbol ${f.symbol} appeared out of order in fallback chain.`);
                    }
                    lastIndex = idx;
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
