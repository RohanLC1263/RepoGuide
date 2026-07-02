import { IntentType } from './intentTypes';
import { IntentRule, INTENT_RULES } from './intentRules';

export interface IntentCandidate {
    type: IntentType;
    canonicalTopic: string;
    matchedText: string;
}

export class IntentNormalizer {
    /**
     * Given raw text, matches rules and returns unique normalized candidates.
     */
    public extractAndNormalize(text: string): IntentCandidate[] {
        if (!text) return [];

        const candidates: IntentCandidate[] = [];
        const seenIdentity = new Set<string>();

        for (const rule of INTENT_RULES) {
            const match = rule.pattern.exec(text);
            if (match) {
                const identity = `${rule.type}:${rule.canonicalTopic}`;
                if (!seenIdentity.has(identity)) {
                    seenIdentity.add(identity);
                    candidates.push({
                        type: rule.type,
                        canonicalTopic: rule.canonicalTopic,
                        matchedText: match[0]
                    });
                }
            }
        }

        return candidates;
    }
}
