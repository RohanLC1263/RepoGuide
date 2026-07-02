import { RepositoryContext } from '../context/repositoryContext';

import { ClassifiedIntent, IntentType } from '../comprehension/types';
import { PLANNING_MODEL_OPTIONS } from '../ollama/inferencer';

const INTENT_PATTERNS: Record<IntentType, RegExp[]> = {
    flow: [
        /\bhow\s+does\b.{0,30}\bwork\b/i,
        /\bend\s+to\s+end\b/i,
        /\btrace\b/i,
        /\bwalk\s+me\s+through\b/i,
        /\bstep\s+by\s+step\b/i,
        /\bwhat\s+happens\s+when\b/i,
        /\bsequence\b/i,
        /\bpipeline\b/i,
        /\blifecycle\b/i,
        /\bfrom\s+start\b/i,
        /\bend-to-end\b/i
    ],
    location: [
        /\bwhere\s+is\b/i,
        /\bwhere\s+are\b/i,
        /\bwhich\s+file\b/i,
        /\bfind\b.{0,20}\bfunction\b/i,
        /\bdefined\b/i,
        /\blocated\b/i,
        /\bwhich\s+class\b/i,
        /\bwhere\s+can\s+I\s+find\b/i
    ],
    debugging: [
        /\bwhy\s+would\b/i,
        /\bwhy\s+is\b/i,
        /\bwhy\s+does\b/i,
        /\bcause\b/i,
        /\bfail\b/i,
        /\berror\b/i,
        /\bbug\b/i,
        /\bnot\s+working\b/i,
        /\bbroken\b/i,
        /\bissue\b/i,
        /\bproblem\b/i
    ],
    orientation: [
        /\bprimary\b/i,
        /\bhow\s+(does|do)\b.{0,30}\bsupport\b/i,
        /\bwhat\s+is\b.{0,30}\bpattern\b/i,
        /\bentry\s+point\b/i,
        /\bwhere\s+are\s+the\s+default\b/i,
        /\boverview\b/i
    ],
    architecture: [
        /\bhow\s+are\b.{0,20}\bconnected\b/i,
        /\boverall\s+structure\b/i,
        /\barchitecture\b/i,
        /\bdesign\b/i,
        /\bhigh\s+level\b/i,
        /\bsystem\s+overview\b/i,
        /\bhow\s+does\s+the\s+system\b/i,
        /\bcomponents\b/i,
        /\bmodules\b/i
    ],
    explanation: [
        /\bwhat\s+does\b/i,
        /\bexplain\b/i,
        /\bhow\s+is\b/i,
        /\bwhat\s+is\b/i,
        /\bdescribe\b/i,
        /\btell\s+me\s+about\b/i,
        /\bunderstand\b/i
    ]
};

export class IntentClassifier {
    private context: RepositoryContext;

    constructor(
        private ollamaUrl: string,
        private planningModel: string,
        context?: RepositoryContext
    ) {
        if (!context) { throw new Error('RepositoryContext must be provided'); }
        this.context = context;
    }

    async classify(question: string): Promise<ClassifiedIntent> {
        const modelResult = await this.classifyWithModel(question);
        if (modelResult) {
            if (modelResult.concepts.length === 0) {
                modelResult.concepts = this.extractConcepts(question);
            }
            if (!modelResult.primaryEntity) {
                const fallbackEntity = extractPrimaryEntity(question);
                modelResult.primaryEntity = fallbackEntity.entity;
                modelResult.entityConfidence = fallbackEntity.confidence;
            }
            this.context.logger.info(
                `[Info] Intent classified: ${modelResult.intent} (${modelResult.confidence.toFixed(2)}) via model - "${modelResult.primaryEntity}"`
            );
            return modelResult;
        }

        const heuristic = this.classifyWithHeuristic(question);
        this.context.logger.info(
            `[Info] Intent classified: ${heuristic.intent} (${heuristic.confidence.toFixed(2)}) via heuristic`
        );
        return heuristic;
    }

    private async classifyWithModel(question: string): Promise<ClassifiedIntent | null> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        try {
            const prompt = buildClassificationPrompt(question);
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
            if (!response.ok) {
                return null;
            }

            const data = await response.json() as { response?: string };
            return parseClassificationResponse(data.response ?? '', question);
        } catch {
            clearTimeout(timeoutId);
            return null;
        }
    }

    private classifyWithHeuristic(question: string): ClassifiedIntent {
        const checkOrder: IntentType[] = ['flow', 'orientation', 'location', 'debugging', 'architecture', 'explanation'];
        for (const intent of checkOrder) {
            const patterns = INTENT_PATTERNS[intent] ?? [];
            if (patterns.some(pattern => pattern.test(question))) {
                return buildHeuristicResult(intent, question, this.extractConcepts(question));
            }
        }
        return buildHeuristicResult('explanation', question, this.extractConcepts(question));
    }

    extractConcepts(question: string): string[] {
        const stopWords = new Set([
            'what', 'does', 'the', 'this', 'that', 'with',
            'from', 'have', 'where', 'which', 'about', 'their', 'there', 'would',
            'could', 'should', 'explain', 'describe', 'tell', 'show', 'find',
            'give', 'how', 'work', 'used', 'uses', 'using', 'code', 'file',
            'function', 'class', 'method', 'module', 'project', 'please',
            'when', 'why', 'who', 'and', 'for', 'are', 'not'
        ]);

        return Array.from(new Set(
            question.toLowerCase()
                .replace(/[^a-z0-9\s_]/g, ' ')
                .split(/\s+/)
                .filter(word => word.length > 2 && !stopWords.has(word))
        ));
    }
}

function buildClassificationPrompt(question: string): string {
    return [
        'You are a code search intent classifier.',
        'Classify the developer question below into exactly one intent type.',
        '',
        'Intent types:',
        '- location: asking WHERE something is in the codebase',
        '- explanation: asking WHAT something does or HOW it is implemented',
        '- flow: asking about a sequence, pipeline, or end-to-end process',
        '- architecture: asking about overall structure, connections, or design',
        '- debugging: asking WHY something fails or what could cause a problem',
        '- orientation: asking for high-level design, entry points, or primary configurations',
        '',
        'Return ONLY valid JSON with no markdown:',
        '{',
        '  "intent": "<location|explanation|flow|architecture|debugging|orientation>",',
        '  "confidence": <0.0-1.0>,',
        '  "concepts": ["<concept1>", "<concept2>"],',
        '  "primaryEntity": "<main thing being asked about>",',
        '  "reasoning": "<one sentence>"',
        '}',
        '',
        `Question: "${question}"`
    ].join('\n');
}

function parseClassificationResponse(
    text: string,
    question: string
): ClassifiedIntent | null {
    const cleaned = text.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    try {
        const parsed = JSON.parse(cleaned) as {
            intent?: string;
            confidence?: number;
            concepts?: string[];
            primaryEntity?: string;
            reasoning?: string;
        };
        const validIntents: IntentType[] = ['location', 'explanation', 'flow', 'architecture', 'debugging', 'orientation'];
        if (!parsed.intent || !validIntents.includes(parsed.intent as IntentType)) {
            return null;
        }

        return {
            intent: parsed.intent as IntentType,
            confidence: typeof parsed.confidence === 'number'
                ? Math.max(0, Math.min(1, parsed.confidence))
                : 0.8,
            concepts: Array.isArray(parsed.concepts)
                ? parsed.concepts.filter(concept => typeof concept === 'string')
                : [],
            primaryEntity: resolvePrimaryEntity(parsed.primaryEntity, question).entity,
            entityConfidence: resolvePrimaryEntity(parsed.primaryEntity, question).confidence,
            reasoning: typeof parsed.reasoning === 'string'
                ? parsed.reasoning
                : '',
            classifiedBy: 'model',
            classifiedAt: new Date().toISOString()
        };
    } catch {
        return null;
    }
}

function buildHeuristicResult(intent: IntentType, question: string, concepts: string[]): ClassifiedIntent {
    const entity = extractPrimaryEntity(question);
    return {
        intent,
        confidence: 0.6,
        concepts,
        primaryEntity: entity.entity,
        entityConfidence: entity.confidence,
        reasoning: `Heuristic pattern match for ${intent}`,
        classifiedBy: 'heuristic',
        classifiedAt: new Date().toISOString()
    };
}

function resolvePrimaryEntity(
    provided: string | undefined,
    question: string
): { entity: string; confidence: number } {
    if (typeof provided === 'string' && provided.trim().length > 0) {
        return { entity: provided.trim(), confidence: 0.9 };
    }
    return extractPrimaryEntity(question);
}

function extractPrimaryEntity(question: string): { entity: string; confidence: number } {
    const quoted = question.match(/["']([^"']{2,60})["']/)?.[1]?.trim();
    if (quoted) {
        return { entity: quoted, confidence: 1.0 };
    }

    const codeSymbol = question.match(/\b([A-Z][a-zA-Z0-9]{2,}(?:[A-Z][a-zA-Z0-9]*)*)\b/)?.[1]?.trim();
    if (codeSymbol) {
        return { entity: codeSymbol, confidence: 1.0 };
    }

    const snakeCase = question.match(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+){1,})\b/)?.[1]?.trim();
    if (snakeCase) {
        return { entity: snakeCase, confidence: 0.8 };
    }

    // Extract noun phrase from location patterns like "where is the X feature"
    const locationNounPhrase = question.match(
        /\bwhere\s+(?:is|are|can\s+I\s+find)\s+(?:the\s+)?(.+?)(?:\s+(?:feature|functionality|module|system|component|logic|code|executed|implemented|defined|located|handled|used|called|in\s+the\s+project))/i
    )?.[1]?.trim();
    if (locationNounPhrase) {
        // Filter out generic qualifiers, keep the core domain term(s)
        const genericWords = new Set([
            'main', 'primary', 'core', 'entire', 'whole', 'full', 'actual', 'new', 'old'
        ]);
        const coreTerms = locationNounPhrase
            .toLowerCase()
            .split(/\s+/)
            .filter(w => w.length > 2 && !genericWords.has(w));
        if (coreTerms.length > 0) {
            return { entity: coreTerms.join('_'), confidence: 0.85 };
        }
    }

    const stopWords = new Set([
        'is', 'are', 'was', 'were', 'does', 'do', 'did', 'where',
        'how', 'what', 'why', 'when', 'which', 'who', 'find', 'show', 'tell', 'explain',
        'the', 'a', 'an', 'in', 'on', 'at', 'by', 'for', 'of', 'to', 'from', 'with',
        'and', 'or', 'but', 'not', 'defined', 'located', 'handled', 'implemented',
        'called', 'used', 'function', 'class', 'method', 'file', 'module', 'code',
        'feature', 'functionality', 'system', 'component', 'logic', 'executed',
        'project', 'codebase'
    ]);

    const words = question
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.has(word));

    const phrase = words.slice(0, 2).join('_').trim();
    if (phrase) {
        return { entity: phrase, confidence: 0.6 };
    }

    return { entity: '', confidence: 0 };
}
