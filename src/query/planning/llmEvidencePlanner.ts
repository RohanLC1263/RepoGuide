
import { EvidencePlan, QueryType, RetrievalTask } from '../evidencePlanTypes';
import { streamChat } from '../../ollama/inferencer';
import { buildEvidencePlan as fallbackPlanBuilder } from '../evidencePlanner';

function extractJson(text: string): string {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end >= start) {
        return text.substring(start, end + 1);
    }
    throw new Error('No JSON object found in response');
}
import { RepositoryContext } from '../../context/repositoryContext';

export async function buildLLMEvidencePlan(context: RepositoryContext, query: string, model: string): Promise<EvidencePlan> {
    const prompt = `You are a Repository Understanding Planner. Your job is to decompose the user's question into structured retrieval tasks.
Do NOT answer the question. Only return a JSON plan.

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
        
        // Add tasks' symbolHints to the main hints so existing logic finds them if needed
        if (parsed.retrievalTasks) {
            for (const t of parsed.retrievalTasks) {
                if (t.symbolHints) {
                    basePlan.symbolHints = Array.from(new Set([...basePlan.symbolHints, ...t.symbolHints]));
                }
                if (t.fileHints) {
                    basePlan.fileHints = Array.from(new Set([...basePlan.fileHints, ...t.fileHints]));
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
