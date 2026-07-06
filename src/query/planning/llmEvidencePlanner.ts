
import { EvidencePlan, QueryType, RetrievalTask } from '../evidencePlanTypes';
import { streamChat } from '../../ollama/inferencer';
import { buildEvidencePlan as fallbackPlanBuilder } from '../evidencePlanner';
import { LogicalUnitStore } from '../../store/logicalUnitStore';

function extractJson(text: string): string {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end >= start) {
        return text.substring(start, end + 1);
    }
    throw new Error('No JSON object found in response');
}
import { RepositoryContext } from '../../context/repositoryContext';

/**
 * Checks a batch of LLM-generated hints against the real index, using the exact same
 * lookups retrieval itself will later perform (LogicalUnitStore.searchBySymbol /
 * getUnitsByFile) -- so a hint that fails this check is, by construction, one that
 * would have contributed nothing to retrieval anyway. Confirmed necessary: the planner
 * has zero grounding in the real repo (its prompt contains only the question and a JSON
 * schema, nothing about this codebase's actual files or symbols), and nothing downstream
 * previously checked its output before feeding it into high-trust injection points
 * (e.g. HybridRetrievalFusion's seed-file score boost) alongside genuine hints.
 */
async function partitionHints(
    hints: string[],
    kind: 'symbol' | 'file',
    unitStore: LogicalUnitStore
): Promise<{ valid: string[]; discarded: string[] }> {
    const valid: string[] = [];
    const discarded: string[] = [];
    for (const hint of hints) {
        const trimmed = hint.trim();
        if (!trimmed) {
            continue;
        }
        const exists = kind === 'symbol'
            ? (await unitStore.searchBySymbol(trimmed, { limit: 1 })).length > 0
            : (await unitStore.getUnitsByFile(trimmed)).length > 0;
        if (exists) {
            valid.push(trimmed);
        } else {
            discarded.push(trimmed);
        }
    }
    return { valid, discarded };
}

export async function buildLLMEvidencePlan(
    context: RepositoryContext,
    query: string,
    model: string,
    conversationContext: Array<{ role: 'user' | 'assistant'; content: string }> = [],
    unitStore?: LogicalUnitStore
): Promise<EvidencePlan> {
    const historyBlock = conversationContext.length > 0
        ? `\nConversation so far (use this to resolve pronouns and follow-up references like "it", "that", "the other one"):\n${conversationContext.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n')}\n`
        : '';
    const prompt = `You are a Repository Understanding Planner. Your job is to decompose the user's question into structured retrieval tasks.
Do NOT answer the question. Only return a JSON plan.
${historyBlock}
User Question: "${query}"

Output a JSON object with this exact schema:
{
    "queryType": "behavior_explanation" | "architecture_analysis" | "onboarding_analysis" | "impact_analysis" | "refactoring_analysis" | "decision_outcome_analysis" | "causal_analysis" | "risk_analysis" | "hotspot_analysis" | "incident_analysis" | "change_impact_prediction",
    "retrievalTasks": [
        {
            "id": "task_1",
            "description": "...",
            "symbolHints": ["..."],
            "fileHints": ["..."],
            "requiredEvidence": ["..."]
        }
    ],
    "fileScope": "implementation_only" | "both" | "docs_config_allowed",
    "constraints": ["..."]
}

Guidelines for QueryType:
- Use "decision_outcome_analysis" if asking which decisions/ADRs succeeded or failed.
- Use "causal_analysis" if asking WHY an architecture or ADR failed/succeeded.
- Use "risk_analysis" if asking about coverage risk or dangerous untested areas.
- Use "hotspot_analysis" if asking about knowledge concentration, bus factor, or risky subsystems.
- Use "incident_analysis" if asking what patterns cause incidents or what subsystem is most likely to fail.
- Use "change_impact_prediction" if asking "what happens if I change X?" or "what is the risk of modifying X and Y?".
`;

    const messages = [
        { role: 'system', content: 'You are an expert software architecture planner. Output ONLY valid JSON.' },
        { role: 'user', content: prompt }
    ];

    let fullOutput = '';
    try {
        for await (const chunk of streamChat(context, messages, model)) {
            fullOutput += chunk;
        }

        // Extract JSON reliably by finding outermost braces
        const cleanedOutput = extractJson(fullOutput);
        
        const parsed = JSON.parse(cleanedOutput);
        
        // Use the existing planner for the base so we get all required fields (factTypes, etc)
        // that are needed by the rest of the system. We then overlay the LLM results.
        const basePlan = fallbackPlanBuilder(query);

        if (parsed.queryType) basePlan.queryType = parsed.queryType as QueryType;
        if (parsed.retrievalTasks) basePlan.retrievalTasks = parsed.retrievalTasks as RetrievalTask[];
        if (parsed.fileScope) basePlan.fileScope = parsed.fileScope;
        
        // Add tasks' symbolHints to the main hints so existing logic finds them if needed.
        // Every hint is validated against the real index first (when a store is available)
        // -- the planner invents these with zero grounding in the actual repo, and a hint
        // that doesn't resolve to anything real would only poison retrieval (e.g. a
        // fabricated file hint still gets used as a direct, trusted seed-file lookup
        // downstream) rather than silently contributing nothing.
        if (parsed.retrievalTasks) {
            for (const t of parsed.retrievalTasks) {
                if (t.symbolHints) {
                    if (unitStore) {
                        const { valid, discarded } = await partitionHints(t.symbolHints, 'symbol', unitStore);
                        basePlan.symbolHints = Array.from(new Set([...basePlan.symbolHints, ...valid]));
                        if (discarded.length > 0) {
                            basePlan.diagnostics.push(`Discarded ${discarded.length} planner-generated symbol hint(s) with no match in the real repo: ${discarded.join(', ')}`);
                        }
                    } else {
                        basePlan.symbolHints = Array.from(new Set([...basePlan.symbolHints, ...t.symbolHints]));
                    }
                }
                if (t.fileHints) {
                    if (unitStore) {
                        const { valid, discarded } = await partitionHints(t.fileHints, 'file', unitStore);
                        basePlan.fileHints = Array.from(new Set([...basePlan.fileHints, ...valid]));
                        if (discarded.length > 0) {
                            basePlan.diagnostics.push(`Discarded ${discarded.length} planner-generated file hint(s) with no match in the real repo: ${discarded.join(', ')}`);
                        }
                    } else {
                        basePlan.fileHints = Array.from(new Set([...basePlan.fileHints, ...t.fileHints]));
                    }
                }
            }
        }
        
        basePlan.retrievalStrategy = 'hybrid';
        basePlan.diagnostics.push(`LLM Planner successfully executed with ${parsed.retrievalTasks?.length || 0} tasks.`);

        return basePlan;

    } catch (e: any) {
        console.warn('LLMEvidencePlanner failed, falling back to regex planner.', e);
        const fallback = fallbackPlanBuilder(query);
        fallback.diagnostics.push('LLM Planner failed, fallback used: ' + e.message);
        return fallback;
    }
}
