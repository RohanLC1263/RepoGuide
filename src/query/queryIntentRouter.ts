import * as fs from 'fs';
import * as path from 'path';

export type IntentType = 'LOCATION' | 'EXPLANATION' | 'FLOW' | 'ARCHITECTURE' | 'DEBUGGING' | 'IMPACT_ANALYSIS' | 'REFACTOR_RISK' | 'PREDICTION_ACCOUNTABILITY' | 'RUNTIME_INTELLIGENCE';

export interface IntentRouterResult {
    primary: IntentType;
    primaryConfidence: number;
    secondary: IntentType | null;
    secondaryConfidence: number | null;
    targets: {
        symbol: string | null;
        file: string | null;
        concept: string | null;
    };
    keywords: string[];
}

export class QueryIntentRouter {
    private conceptMapData: any = null;

    constructor(
        private understandingDir: string,
        private outputChannel?: { appendLine(msg: string): void }
    ) {}

    public load(): void {
        const cmapPath = path.join(this.understandingDir, 'concept_map.json');
        if (fs.existsSync(cmapPath)) {
            try {
                this.conceptMapData = JSON.parse(fs.readFileSync(cmapPath, 'utf8'));
            } catch (e) {
                // Ignore parse errors on load
            }
        }
    }

    public classify(query: string): IntentRouterResult {
        const queryLower = query.toLowerCase();

        const intents: Record<IntentType, { keywords: Array<{ text: string, weight: number }> }> = {
            LOCATION: { keywords: [
                { text: "where is", weight: 0.8 }, { text: "what file", weight: 0.8 }, { text: "which file", weight: 0.8 }, 
                { text: "where does", weight: 0.8 }, { text: "show me", weight: 0.7 }, { text: "find", weight: 0.6 }, { text: "locate", weight: 0.6 }
            ]},
            EXPLANATION: { keywords: [
                { text: "how does", weight: 0.8 }, { text: "what does", weight: 0.8 }, { text: "tell me about", weight: 0.8 },
                { text: "explain", weight: 0.7 }, { text: "describe", weight: 0.7 }, { text: "what is", weight: 0.6 }
            ]},
            FLOW: { keywords: [
                { text: "end to end", weight: 0.9 }, { text: "step by step", weight: 0.9 },
                { text: "walkthrough", weight: 0.8 }, { text: "lifecycle", weight: 0.8 },
                { text: "flow", weight: 0.7 }, { text: "pipeline", weight: 0.7 }, { text: "sequence", weight: 0.7 }, { text: "trace", weight: 0.7 }
            ]},
            ARCHITECTURE: { keywords: [
                { text: "how is it organized", weight: 0.9 },
                { text: "architecture", weight: 0.8 }, { text: "structure", weight: 0.8 }, { text: "design", weight: 0.7 },
                { text: "overview", weight: 0.7 }, { text: "components", weight: 0.7 }, { text: "system", weight: 0.6 }
            ]},
            DEBUGGING: { keywords: [
                { text: "why is", weight: 0.8 }, { text: "why does", weight: 0.8 },
                { text: "failing", weight: 0.8 }, { text: "broken", weight: 0.8 }, { text: "crash", weight: 0.8 },
                { text: "exception", weight: 0.8 }, { text: "error", weight: 0.7 }, { text: "bug", weight: 0.7 }, { text: "wrong", weight: 0.7 }
            ]},
            IMPACT_ANALYSIS: { keywords: [
                { text: "what breaks", weight: 0.9 }, { text: "what changes", weight: 0.9 }, { text: "impact of", weight: 0.9 },
                { text: "if i change", weight: 0.9 }, { text: "what depends on", weight: 0.8 }, { text: "what uses", weight: 0.8 }
            ]},
            REFACTOR_RISK: { keywords: [
                { text: "safe to change", weight: 0.9 }, { text: "can i change", weight: 0.9 },
                { text: "refactor", weight: 0.8 }, { text: "rename", weight: 0.8 }, { text: "delete", weight: 0.8 },
                { text: "remove", weight: 0.8 }, { text: "move", weight: 0.7 }
            ]},
            PREDICTION_ACCOUNTABILITY: { keywords: [
                { text: "how accurate are", weight: 0.9 }, { text: "can we trust", weight: 0.9 },
                { text: "brier score", weight: 0.9 }, { text: "prediction quality", weight: 0.9 },
                { text: "false positive rate", weight: 0.9 }, { text: "prediction drift", weight: 0.8 },
                { text: "false negative rate", weight: 0.9 }
            ]},
            RUNTIME_INTELLIGENCE: { keywords: [
                { text: "runtime components", weight: 0.9 },
                { text: "runtime failures", weight: 0.9 },
                { text: "runtime risks", weight: 0.9 },
                { text: "runtime health", weight: 0.9 },
                { text: "unhealthy components", weight: 0.8 },
                { text: "degraded runtime", weight: 0.8 },
                { text: "runtime", weight: 0.7 }
            ]}
        };

        const scores = new Map<IntentType, number>();
        const matchedKeywords = new Set<string>();

        // 1. Keyword scoring
        for (const [intent, data] of Object.entries(intents)) {
            let score = 0;
            for (const kw of data.keywords) {
                // simple boundary matching
                const regex = new RegExp(`\\b${escapeRegExp(kw.text)}\\b`, 'i');
                if (regex.test(queryLower)) {
                    score += kw.weight;
                    matchedKeywords.add(kw.text);
                }
            }
            scores.set(intent as IntentType, Math.min(score, 1.0));
        }

        const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
        
        let primary: IntentType = 'EXPLANATION';
        let primaryConf = 0.5;
        let secondary: IntentType | null = null;
        let secondaryConf: number | null = null;

        if (sorted.length > 0 && sorted[0][1] >= 0.6) {
            primary = sorted[0][0];
            primaryConf = sorted[0][1];

            // 2. Ambiguity resolution
            if (sorted.length > 1 && sorted[1][1] >= 0.6) {
                const diff = primaryConf - sorted[1][1];
                if (diff <= 0.1) {
                    secondary = sorted[1][0];
                    secondaryConf = sorted[1][1];
                }
            }
        }

        // Targets extraction
        const targets = {
            symbol: this.extractSymbol(query),
            file: this.extractFile(query),
            concept: this.extractConcept(queryLower)
        };

        this.outputChannel?.appendLine(
            `[Info] Query intent: ${primary} (${primaryConf.toFixed(2)})` +
            (secondary ? `, secondary: ${secondary} (${secondaryConf?.toFixed(2)})` : '')
        );
        if (targets.concept) {
            this.outputChannel?.appendLine(`       Target concept: "${targets.concept}"`);
        }
        if (matchedKeywords.size > 0) {
            this.outputChannel?.appendLine(`       Keywords matched: ${JSON.stringify(Array.from(matchedKeywords))}`);
        }

        return {
            primary,
            primaryConfidence: primaryConf,
            secondary,
            secondaryConfidence: secondaryConf,
            targets,
            keywords: Array.from(matchedKeywords)
        };
    }

    private extractSymbol(query: string): string | null {
        // Check for explicitly quoted string first (e.g. "run_mission")
        const quoted = query.match(/['"]([a-zA-Z0-9_]+)['"]/);
        if (quoted && quoted[1].length > 2) return quoted[1];
        
        // Match PascalCase, camelCase, or snake_case
        const match = query.match(/\b([A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*|[a-z]+[A-Z][a-zA-Z0-9]*|[a-z]+_[a-z0-9_]+)\b/);
        return match ? match[1] : null;
    }

    private extractFile(query: string): string | null {
        const match = query.match(/\b([a-zA-Z0-9_-]+\.(?:ts|js|py|tsx|jsx|json|md|html|css|java|go|cpp|c|h|rs|sh))\b/i);
        return match ? match[1] : null;
    }

    private extractConcept(queryLower: string): string | null {
        if (!this.conceptMapData || !this.conceptMapData.concepts) return null;

        let bestMatch: string | null = null;
        let maxLength = 0;

        for (const [canonical, data] of Object.entries(this.conceptMapData.concepts)) {
            const terms = [canonical, ...((data as any).synonyms || [])];
            for (const term of terms) {
                const t = term.toLowerCase();
                // Ensure it's longer than what we already have and at least 3 chars
                if (queryLower.includes(t) && t.length > maxLength && t.length > 3) {
                    // Check for word boundaries so we don't match "art" inside "startup"
                    const regex = new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i');
                    if (regex.test(queryLower)) {
                        maxLength = t.length;
                        bestMatch = canonical;
                    }
                }
            }
        }

        return bestMatch;
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
