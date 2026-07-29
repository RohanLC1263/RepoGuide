import { CHARS_PER_TOKEN, deriveEvidenceBudgetChars } from './evidencePrompt';
import { INFERENCE_MODEL_OPTIONS } from '../ollama/inferencer';

export interface GatedSubAnswer {
    question: string;
    answer: string;
}

/**
 * Merge prompt for decomposed queries: the input is NOT raw evidence -- it is
 * the set of per-sub-question answers that have each ALREADY passed AnswerGate
 * individually. The model's only job is to weave them into one coherent
 * explanation. It is explicitly forbidden from adding facts, and explicitly
 * required to surface disagreements between sections rather than reconciling
 * them -- this session found a real case of two subsystems reaching
 * contradictory conclusions inside one answer, and a merge that smooths that
 * over is worse than no merge. The merged output still gets a full final
 * AnswerGate pass against the union of the sub-answers' evidence packets, so
 * anything invented here is caught the same way it would be anywhere else.
 */
export function buildMergeMessages(
    masterQuestion: string,
    subAnswers: GatedSubAnswer[]
): Array<{ role: string; content: string }> {
    const rules = [
        'You are a code-comprehension assistant combining several already-verified partial answers into one coherent final answer.',
        '',
        'CRITICAL RULES:',
        '1. USE ONLY THE PARTIAL ANSWERS BELOW. Every fact in your output must come from one of them. Do NOT add new facts, new file names, new code, new numbers, or plausible-sounding filler -- your output is automatically verified against the underlying evidence, and anything not traceable to it blocks the whole answer.',
        '2. WEAVE, DO NOT CONCATENATE: connect the parts into one flowing explanation that answers the original question end-to-end, in the order given. Remove redundancy between parts. Keep every citation marker (e.g. [id: ...]) exactly as written next to the claim it supports.',
        '3. DISAGREEMENTS ARE FINDINGS, NOT NOISE: if two partial answers contradict each other on any point, state the contradiction explicitly ("Part N says X, but part M says Y -- the evidence does not resolve this"). NEVER silently pick one side or invent a reconciliation.',
        '4. PRESERVE HONESTY: if a partial answer says evidence does not determine something, keep that statement in the merged answer.',
        '5. Do not mention "partial answers", "parts", or this merging process in your output except when reporting a contradiction per rule 3.'
    ].join('\n');

    const sections = subAnswers.map((sub, index) =>
        `--- PART ${index + 1}: ${sub.question} ---\n${sub.answer}`
    ).join('\n\n');

    // Sub-answers are prose (1-3k chars each, at most 4 of them), so this rarely
    // binds -- but the same num_ctx discipline applies: never hand the backend an
    // over-length prompt it would silently truncate.
    const fixedChars = rules.length + masterQuestion.length + 200;
    const budget = deriveEvidenceBudgetChars(fixedChars);
    const body = sections.length > budget
        ? sections.slice(0, budget) + '\n[remaining partial-answer content truncated to fit the context window]'
        : sections;

    const messages = [
        { role: 'system', content: `${rules}\n\n--- VERIFIED PARTIAL ANSWERS ---\n${body}` },
        { role: 'user', content: `Original question: ${masterQuestion}\nCombine the verified partial answers above into one coherent, complete answer to it.` }
    ];

    const promptChars = JSON.stringify(messages).length;
    // stderr, not stdout: see the channel note in evidencePrompt.ts (MCP stdout is JSON-RPC).
    console.error(`[PromptBudget] merge: ~${Math.round(promptChars / CHARS_PER_TOKEN)} est tokens (${promptChars} chars) vs num_ctx=${INFERENCE_MODEL_OPTIONS.num_ctx}`);
    return messages;
}
