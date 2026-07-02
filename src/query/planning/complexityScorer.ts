export interface ComplexityResult {
    score: number;
    classification: 'simple' | 'complex';
    reasons: string[];
}

const ANAPHORIC_PATTERN = /\b(it|that|this one|the other one|why did (it|that) fail|what about (it|that|them))\b/i;

export function scoreQueryComplexity(query: string, hasConversationHistory: boolean = false): ComplexityResult {
    const reasons: string[] = [];
    let score = 0;

    const tokens = query.split(/\s+/);

    // Follow-up questions referencing prior turns need the LLM planner's history-aware
    // decomposition to resolve — route them there via the same complexity signal used
    // for everything else, rather than adding a separate rewrite stage.
    if (hasConversationHistory && (tokens.length <= 6 || ANAPHORIC_PATTERN.test(query))) {
        score += 2;
        reasons.push('Likely follow-up question with conversation history present');
    }
    
    // 1. query length
    if (tokens.length > 7) {
        score += 1;
        reasons.push('Long query length (> 7 words)');
    }
    
    // 2. relational verbs
    const relVerbs = ['interact', 'depend', 'call', 'use', 'connect', 'communicate'];
    for (const v of relVerbs) {
        if (query.toLowerCase().includes(v)) {
            score += 1;
            reasons.push(`Relational verb found: ${v}`);
        }
    }

    // 3. architectural/domain keywords
    const archKeywords = [
        'architecture', 'system', 'ingestion', 'retrieval', 'memory', 'planner', 
        'explorer', 'store', 'packet', 'builder', 'pipeline', 'routing', 
        'token', 'budget', 'synthesizer', 'dispatcher', 'ranking', 'model', 
        'flow', 'rationale', 'design', 'module', 'component', 'codebase', 
        'logic', 'process', 'subsystem'
    ];
    for (const kw of archKeywords) {
        const regex = new RegExp(`\\b${kw}\\b`, 'i');
        if (regex.test(query)) {
            score += 1;
            reasons.push(`Architectural keyword found: ${kw}`);
        }
    }

    // 4. debugging and onboarding keywords
    const bugKeywords = [
        'error', 'fail', 'bug', 'crash', 'why did', 'issue', 'wrong', 
        'broken', 'not working', 'trace', 'exception', 'new developer', 
        'get started', 'start looking', 'understand'
    ];
    for (const kw of bugKeywords) {
        if (query.toLowerCase().includes(kw)) {
            score += 1;
            reasons.push(`Debugging/Onboarding keyword found: ${kw}`);
        }
    }

    // 5. conjunction count
    const conjunctions = ['and', 'but', 'or', 'while', 'although'];
    let conjCount = 0;
    for (const t of tokens) {
        if (conjunctions.includes(t.toLowerCase())) {
            conjCount++;
            reasons.push(`Conjunction found: ${t}`);
        }
    }
    if (conjCount > 0) {
        score += conjCount;
    }

    // 6. "How does" / "Why" style reasoning requests
    const reasKeywords = ['how does', 'why', 'explain', 'what is the purpose', 'how do we', 'what is the overall', 'rationale behind'];
    for (const r of reasKeywords) {
        if (query.toLowerCase().includes(r)) {
            score += 2;
            reasons.push(`Reasoning request prefix: ${r}`);
        }
    }

    const threshold = 2;
    
    return {
        score,
        classification: score >= threshold ? 'complex' : 'simple',
        reasons
    };
}
