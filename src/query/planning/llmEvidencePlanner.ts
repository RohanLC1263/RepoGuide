
import { EvidencePlan, QueryType, RetrievalTask } from '../evidencePlanTypes';
import { streamChat } from '../../ollama/inferencer';
import { buildEvidencePlan as fallbackPlanBuilder } from '../evidencePlanner';
import { LogicalUnitStore } from '../../store/logicalUnitStore';
// Circular at module level (executionPlanner imports this file), but safe: the
// compiled CJS resolves the property at call time, long after both modules load.
import { extractIdentifierKeywords } from '../executionPlanner';

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
const MAX_SUB_QUESTIONS = 5;
/**
 * Minimum retrievalTasks count for deriving sub-questions from task
 * descriptions. Validated against all 25 real dogfood questions
 * (decompositionTriggerValidation.ts): single-facet questions produce 1-3
 * retrieval tasks (find X, then check Y -- ordinary retrieval structure, even
 * for high-complexity questions like rc-11's Firestore-vs-Supabase at 3
 * near-duplicate tasks), while the one genuinely multi-facet walkthrough
 * produced 5 distinct tasks. 4+ separate investigations IS the multi-facet
 * signature. Deliberately conservative: under-firing just means today's
 * single-shot behavior.
 */
const TASK_DERIVATION_MIN_TASKS = 4;

/**
 * Validates planner-emitted sub-questions the same way symbol/file hints are
 * validated: the planner invents these with zero repo grounding, so each one
 * must earn its place. A sub-question survives only if it is a non-trivial,
 * non-duplicate string that shares at least one significant term with the
 * master question -- topic drift here would send a whole retrieval+generation
 * pass chasing something the user never asked about.
 */
export function validateSubQuestions(raw: unknown, masterQuery: string): { valid: string[]; discarded: string[] } {
    if (!Array.isArray(raw)) {
        return { valid: [], discarded: [] };
    }
    const masterTerms = new Set(
        (masterQuery.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(t => t.length > 3)
    );
    const valid: string[] = [];
    const discarded: string[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
        const text = typeof entry === 'string' ? entry.trim() : '';
        const key = text.toLowerCase();
        if (text.length < 12 || seen.has(key)) {
            if (text) { discarded.push(text); }
            continue;
        }
        const terms = key.match(/[a-z0-9_]+/g) ?? [];
        const overlaps = terms.some(t => t.length > 3 && masterTerms.has(t));
        if (!overlaps) {
            discarded.push(text);
            continue;
        }
        seen.add(key);
        if (valid.length < MAX_SUB_QUESTIONS) {
            valid.push(text);
        } else {
            discarded.push(text);
        }
    }
    return { valid, discarded };
}

/** Keep the facet terms dominant: a handful of anchors sharpens retrieval; a
 * dozen drowns the sub-question's own terms and re-converges every facet onto
 * the same evidence, defeating the point of decomposing. */
const MAX_ANCHOR_HINTS = 6;
/** How many one-hop-expanded anchors may join the directly-validated ones. */
const MAX_EXPANDED_ANCHORS = 4;

/**
 * Expands validated anchors one hop through the unit store: for each anchor's
 * real unit, identifier-shaped tokens in its CONTENT that themselves resolve
 * to real units become additional anchors. Measured motivation (live run,
 * 2026-07-07): the master plan for a walkthrough question validated exactly
 * one hint (execute_mission), and a single anchor acts as a magnet -- every
 * facet's retrieval converged on mission_service.py while the per-agent
 * timeout evidence lives one call-hop away in MissionCoordinator.
 * execute_mission's own body contains run_mission and MissionOrchestratorAgent
 * -- both real units -- so one hop reaches the delegation target through
 * store-verified strings only. Every expanded anchor must itself validate, so
 * this can never introduce a fabricated symbol.
 */
export async function expandAnchorsOneHop(anchors: string[], unitStore: LogicalUnitStore): Promise<string[]> {
    const expanded: string[] = [];
    const known = new Set(anchors.map(a => a.toLowerCase()));
    for (const anchor of anchors) {
        const refs = await unitStore.searchBySymbol(anchor, { limit: 2 });
        for (const ref of refs) {
            const unit = await unitStore.getUnit(ref.id);
            if (!unit) {
                continue;
            }
            for (const candidate of extractIdentifierKeywords(unit.content)) {
                const key = candidate.toLowerCase();
                if (candidate.length <= 4 || known.has(key)) {
                    continue;
                }
                known.add(key); // don't re-check rejected candidates either
                const exists = (await unitStore.searchBySymbol(candidate, { limit: 1 })).length > 0;
                if (exists) {
                    expanded.push(candidate);
                    if (expanded.length >= MAX_EXPANDED_ANCHORS) {
                        return expanded;
                    }
                }
            }
        }
    }
    return expanded;
}

/**
 * Anchors a task-description-derived sub-question with the master plan's
 * validated symbol/file hints. Task descriptions are lexically weaker than
 * hand-written sub-questions -- found in the first live decomposed run, where
 * "Analyze how per-agent failures and timeouts are handled." (no
 * MissionCoordinator/run_mission anchor) retrieved prompt-template noise and
 * degraded a facet the identically-scoped hand-written question had answered
 * in full. Appending the anchors to the question TEXT (not just a hint list)
 * matters: the text is what BM25, vector embedding, and the sub-plan's own
 * regex hint extraction all consume. Only validated hints are used, so this
 * can never inject a planner fabrication.
 */
export function anchorDerivedSubQuestion(text: string, symbolHints: string[], fileHints: string[]): string {
    const anchors = Array.from(new Set([...symbolHints, ...fileHints]))
        .filter(hint => hint.length > 2)
        // Skip anchors already present in the sub-question -- no point repeating them.
        .filter(hint => !text.toLowerCase().includes(hint.toLowerCase()))
        .slice(0, MAX_ANCHOR_HINTS);
    if (anchors.length === 0) {
        return text;
    }
    return `${text} (Focus on: ${anchors.join(', ')})`;
}

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
    "constraints": ["..."],
    "subQuestions": ["..."]
}

Guidelines for QueryType:
- Use "decision_outcome_analysis" if asking which decisions/ADRs succeeded or failed.
- Use "causal_analysis" if asking WHY an architecture or ADR failed/succeeded.
- Use "risk_analysis" if asking about coverage risk or dangerous untested areas.
- Use "hotspot_analysis" if asking about knowledge concentration, bus factor, or risky subsystems.
- Use "incident_analysis" if asking what patterns cause incidents or what subsystem is most likely to fail.
- Use "change_impact_prediction" if asking "what happens if I change X?" or "what is the risk of modifying X and Y?".

Guidelines for subQuestions (IMPORTANT -- most questions must NOT have any):
- Leave subQuestions as an empty array [] unless the question genuinely spans MULTIPLE DISTINCT FACETS that each need their own separate investigation (e.g. a full architecture walkthrough asking for entry point AND component sequence AND error handling AND persistence).
- A question about one thing -- one value, one file, one behavior, one relationship, whether something exists -- must have subQuestions: []. When in doubt, use [].
- If you do emit them: 2 to 4 sub-questions, each a complete standalone question answerable on its own, in the order the facets should be explained, together covering the original question.
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
        //
        // Store-validated hints are ALSO collected separately for sub-question
        // anchoring below: basePlan.symbolHints starts as the regex planner's raw
        // word extraction ("walk", "through", ...), which must never be used as
        // anchors -- only hints that resolved against the real index qualify.
        const storeValidatedSymbolHints: string[] = [];
        const storeValidatedFileHints: string[] = [];
        if (parsed.retrievalTasks) {
            for (const t of parsed.retrievalTasks) {
                if (t.symbolHints) {
                    if (unitStore) {
                        const { valid, discarded } = await partitionHints(t.symbolHints, 'symbol', unitStore);
                        storeValidatedSymbolHints.push(...valid);
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
                        storeValidatedFileHints.push(...valid);
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
        
        if (parsed.subQuestions !== undefined) {
            const { valid, discarded } = validateSubQuestions(parsed.subQuestions, query);
            // A single sub-question is not a decomposition -- it's the same question
            // reworded; only 2+ distinct facets justify the multi-pass cost.
            if (valid.length >= 2) {
                basePlan.subQuestions = valid;
                basePlan.diagnostics.push(`Planner proposed ${valid.length} sub-question(s) for decomposition.`);
            }
            if (discarded.length > 0) {
                basePlan.diagnostics.push(`Discarded ${discarded.length} planner-generated sub-question(s) (trivial, duplicate, off-topic, or over the cap of ${MAX_SUB_QUESTIONS}).`);
            }
        }

        // Small-model reality (measured, decompositionTriggerValidation.ts): a 7B
        // planner told "most questions must NOT have subQuestions -- when in doubt,
        // use []" takes the safe default on EVERY question, including ones it
        // simultaneously decomposes into 5 perfect retrievalTasks. Asking a small
        // model to JUDGE decomposition fails; reading the decomposition it already
        // performs works. So when the model emitted no usable subQuestions but did
        // emit >= TASK_DERIVATION_MIN_TASKS distinct retrieval tasks, derive
        // sub-questions from the task descriptions deterministically. LLM-emitted
        // subQuestions still win when present -- larger models that do emit them
        // get the more natural phrasing with no code change.
        if ((basePlan.subQuestions === undefined || basePlan.subQuestions.length < 2)
            && Array.isArray(parsed.retrievalTasks)
            && parsed.retrievalTasks.length >= TASK_DERIVATION_MIN_TASKS) {
            const { valid } = validateSubQuestions(parsed.retrievalTasks.map((t: RetrievalTask) => t.description), query);
            if (valid.length >= 2) {
                // A too-small anchor pool acts as a magnet (measured: one lone anchor
                // converged every facet's retrieval on the same file), so top it up
                // one store-verified hop when there is room.
                let anchorSymbols = [...new Set(storeValidatedSymbolHints)];
                if (unitStore && anchorSymbols.length > 0 && anchorSymbols.length < MAX_ANCHOR_HINTS) {
                    anchorSymbols = [...anchorSymbols, ...await expandAnchorsOneHop(anchorSymbols, unitStore)];
                }
                basePlan.subQuestions = valid.map(text => anchorDerivedSubQuestion(text, anchorSymbols, storeValidatedFileHints));
                basePlan.diagnostics.push(`Derived ${valid.length} sub-question(s) from ${parsed.retrievalTasks.length} retrieval-task descriptions (planner emitted none directly), anchored with ${anchorSymbols.length} store-validated symbol anchor(s).`);
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
