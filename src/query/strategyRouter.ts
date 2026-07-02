import { ClassifiedIntent } from '../comprehension/types';
import { PLANNING_MODEL_OPTIONS } from '../ollama/inferencer';
import { RepositoryContext } from '../context/repositoryContext';

export type StrategyName = 
    | 'symbol_lookup' 
    | 'configuration_lookup' 
    | 'targeted_extraction' 
    | 'flow_tracing' 
    | 'behavior_explanation' 
    | 'architecture_analysis' 
    | 'error_investigation';

export interface RoutedStrategy {
    strategy: StrategyName;
    minChunks: number;
    maxChunks: number;
    confidence: number;
}

const STRATEGY_CHUNKS: Record<StrategyName, { min: number, max: number }> = {
    symbol_lookup: { min: 5, max: 20 },
    configuration_lookup: { min: 5, max: 10 },
    targeted_extraction: { min: 3, max: 8 },
    flow_tracing: { min: 20, max: 50 },
    behavior_explanation: { min: 50, max: 150 },
    architecture_analysis: { min: 100, max: 300 }, // user said 300+, cap at 300 for safety
    error_investigation: { min: 15, max: 40 }
};

export class StrategyRouter {
    constructor(
        private ollamaUrl: string,
        private planningModel: string,
        private context: RepositoryContext
    ) {}

    async route(question: string, intent: ClassifiedIntent): Promise<RoutedStrategy> {
        const modelResult = await this.routeWithModel(question);
        if (modelResult) {
            this.context.logger.info(`[StrategyRouter] Routed via model to ${modelResult.strategy} (${modelResult.confidence.toFixed(2)})`);
            return modelResult;
        }

        const fallback = this.routeViaHeuristic(question, intent);
        this.context.logger.info(`[StrategyRouter] Routed via heuristic to ${fallback.strategy}`);
        return fallback;
    }

    private async routeWithModel(question: string): Promise<RoutedStrategy | null> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        try {
            const prompt = [
                'You are an advanced retrieval strategy router.',
                'Analyze the following developer question and select exactly ONE retrieval strategy.',
                '',
                'Strategies:',
                '- symbol_lookup: Locate the definition of a specific class, function, or variable.',
                '- configuration_lookup: Find specific constants, weights, thresholds, or config defaults (e.g. "ranking weights", "default timeout").',
                '- targeted_extraction: Extract a very specific detail, string, regex, or query without needing surrounding logic.',
                '- flow_tracing: Follow a sequence of steps, request lifecycles, or state transitions (e.g. "how does X handle Y", "app initialization").',
                '- behavior_explanation: General explanation of what a component does.',
                '- architecture_analysis: High-level design, component connections.',
                '- error_investigation: Debugging a crash, error, or failure.',
                '',
                'Return ONLY valid JSON:',
                '{',
                '  "strategy": "<one of the 7 strategies above>",',
                '  "confidence": <0.0-1.0>',
                '}',
                '',
                `Question: "${question}"`
            ].join('\n');

            const response = await fetch(`${this.ollamaUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.planningModel,
                    prompt,
                    stream: false,
                    options: PLANNING_MODEL_OPTIONS,
                    keep_alive: '5m'
                }),
                signal: controller.signal as RequestInit['signal']
            });

            clearTimeout(timeoutId);
            if (!response.ok) return null;

            const data = await response.json() as { response?: string };
            const cleaned = (data.response ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
            const parsed = JSON.parse(cleaned);

            const validStrategies = Object.keys(STRATEGY_CHUNKS);
            if (parsed.strategy && validStrategies.includes(parsed.strategy)) {
                return {
                    strategy: parsed.strategy as StrategyName,
                    minChunks: STRATEGY_CHUNKS[parsed.strategy as StrategyName].min,
                    maxChunks: STRATEGY_CHUNKS[parsed.strategy as StrategyName].max,
                    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8
                };
            }
            return null;
        } catch (e) {
            clearTimeout(timeoutId);
            return null;
        }
    }

    private routeViaHeuristic(question: string, intent: ClassifiedIntent): RoutedStrategy {
        const patterns: Record<StrategyName, RegExp[]> = {
            symbol_lookup: [
                /\bwhere\s+is\b/i, /\bwhere\s+are\b/i, /\bwhich\s+file\b/i, /\bfind\b/i, /\blocated\b/i, /\blocate\b/i
            ],
            flow_tracing: [
                /\btrace\b/i, /\bwalk\s+me\s+through\b/i, /\bstep\s+by\s+step\b/i, /\bwhat\s+happens\b/i, 
                /\bsequence\b/i, /\blifecycle\b/i, /\bend\s+to\s+end\b/i, /\bflow\b/i, /\bhow\s+does\b.*?\bhandle\b/i,
                /\binitialized\b/i
            ],
            configuration_lookup: [
                /\bconfiguration\b/i, /\bconfig\b/i, /\bproperties\b/i, /threshold/i, 
                /\bweights\b/i, /\bdefault\b/i, /\bvalue\b/i, /timeout/i, /\bport\b/i, /\bhow\s+many\b/i, /\blist\s+all\b/i
            ],
            targeted_extraction: [
                /\bextract\b/i, /\bexact\b/i, /\bshow\s+me\s+the\b/i, /\bget\s+the\b/i, 
                /\bschema\b/i, /prompt/i, /\bregex\b/i, /\bsql\b/i, /\bstring\b/i
            ],
            error_investigation: [
                /\bwhy\b/i, /\berror\b/i, /\bcause\b/i, /\bfail\b/i, /\bbug\b/i, /\bcrash\b/i, /\bnot\s+found\b/i
            ],
            architecture_analysis: [
                /\bconnected\b/i, /\bstructure\b/i, /\bdesign\b/i, /\bcomponents\b/i, 
                /\bdatabase\s+transactions\b/i, /\bmodules\b/i, /\bsystem\s+overview\b/i
            ],
            behavior_explanation: [
                /\bwhat\s+does\b/i, /\bexplain\b/i, /\bhow\s+is\b/i, /\bdescribe\b/i, 
                /\bpurpose\b/i, /\brole\b/i, /\baccomplish\b/i
            ]
        };

        const checkOrder: StrategyName[] = [
            'symbol_lookup', 'flow_tracing', 'targeted_extraction', 'error_investigation', 
            'configuration_lookup', 'architecture_analysis', 'behavior_explanation'
        ];
        
        for (const strategy of checkOrder) {
            if (patterns[strategy].some(p => p.test(question))) {
                return {
                    strategy,
                    minChunks: STRATEGY_CHUNKS[strategy].min,
                    maxChunks: STRATEGY_CHUNKS[strategy].max,
                    confidence: 0.7
                };
            }
        }

        let strategy: StrategyName = 'behavior_explanation';
        switch (intent.intent) {
            case 'location': strategy = 'symbol_lookup'; break;
            case 'explanation': strategy = 'behavior_explanation'; break;
            case 'flow': strategy = 'flow_tracing'; break;
            case 'architecture': strategy = 'architecture_analysis'; break;
            case 'debugging': strategy = 'error_investigation'; break;
            case 'orientation': strategy = 'architecture_analysis'; break;
        }
        
        return {
            strategy,
            minChunks: STRATEGY_CHUNKS[strategy].min,
            maxChunks: STRATEGY_CHUNKS[strategy].max,
            confidence: 0.6
        };
    }
}
