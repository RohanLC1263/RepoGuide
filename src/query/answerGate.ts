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

export class AnswerGate {
    verify(answer: string, packet: EvidencePacket): GateResult {
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
        const matches = answer.match(numberRegex) || [];
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

        // 3. Check quoted strings
        const quoteRegex = /"([^"]+)"/g;
        let quoteMatch;
        while ((quoteMatch = quoteRegex.exec(answer)) !== null) {
            const innerStr = quoteMatch[1];
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
            } else {
                result.supported_claims.push(`Quote: "${innerStr}"`);
            }
        }

        // 4. Check file paths and symbols mentioned as file/paths
        const pathRegex = /\b[\w-]+\.(ts|js|py|json|md|tsx|jsx)\b/g;
        const pathMatches = answer.match(pathRegex) || [];
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

        // 6. Conceptual Mode Fallback
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
