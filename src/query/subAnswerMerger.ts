import { EvidencePacket, EvidenceItem } from './evidencePacket';
import { EvidencePlan } from './evidencePlanTypes';
import { AnswerGate, AnswerGatePolicy, GateResult } from './answerGate';
import { buildMergeMessages } from '../prompts/evidenceMergePrompt';

export interface SubTaskResult {
    question: string;
    answer: string;
    packet: EvidencePacket;
    gate: GateResult;
}

export interface MergeOutcome {
    answer: string;
    unionPacket: EvidencePacket;
    finalGate: GateResult | null;
    /** True when the merge generation was blocked by the final gate and the
     * per-section fallback (each section individually gate-approved) was used. */
    usedFallback: boolean;
    diagnostics: string[];
}

/** Signature intentionally backend-agnostic: any function that turns chat
 * messages into a completed string works (Ollama today, anything later). */
export type ChatFn = (messages: Array<{ role: string; content: string }>) => Promise<string>;

/**
 * Merges individually gate-approved sub-answers into one final answer, then
 * verifies the merged whole with its own full AnswerGate pass against the
 * UNION of the sub-answers' evidence packets. Per-sub gating alone is not
 * enough: the merge generation is one more LLM call and can fabricate
 * "connective" content just like any other call -- and it is also the point
 * where two sub-answers' contradictory conclusions would otherwise get
 * silently smoothed over.
 *
 * If the final gate blocks the merged narrative, the fallback is a sectioned
 * presentation of the sub-answers verbatim -- each of those already passed the
 * gate individually, so presenting them unmodified is safe by construction,
 * and 3 good verified sections beat discarding several minutes of grounded work
 * because one connective sentence failed verification.
 */
export class SubAnswerMerger {
    constructor(
        private readonly chat: ChatFn,
        private readonly answerGate: AnswerGate = new AnswerGate()
    ) {}

    async merge(
        masterQuestion: string,
        masterPlan: EvidencePlan,
        passed: SubTaskResult[],
        blocked: SubTaskResult[],
        policy: AnswerGatePolicy,
        workspaceRoot?: string
    ): Promise<MergeOutcome> {
        const diagnostics: string[] = [];
        const unionPacket = this.buildUnionPacket(masterQuestion, masterPlan, passed);

        if (passed.length === 0) {
            throw new Error('SubAnswerMerger.merge() requires at least one gate-approved sub-answer.');
        }

        let answer: string;
        let finalGate: GateResult | null = null;
        let usedFallback = false;

        if (passed.length === 1) {
            // One surviving section is not a merge -- use it directly (it already
            // passed the gate against its own packet; no second generation to verify).
            answer = passed[0].answer;
            diagnostics.push('Single surviving sub-answer used directly; no merge generation needed.');
        } else {
            const messages = buildMergeMessages(masterQuestion, passed.map(p => ({ question: p.question, answer: p.answer })));
            const merged = await this.chat(messages);
            finalGate = this.answerGate.verify(merged, unionPacket, policy, workspaceRoot);
            if (finalGate.outcome === 'block') {
                usedFallback = true;
                diagnostics.push(`Merged narrative blocked by final gate (${finalGate.diagnostics.join('; ')}); falling back to verified sections.`);
                answer = this.sectionedFallback(passed);
            } else {
                answer = finalGate.finalAnswer;
            }
        }

        // Deterministic disclosure of facets that could not be grounded -- appended
        // after gating, like the mentor block, because it is scaffolding text we
        // construct ourselves from gate diagnostics, not model output.
        if (blocked.length > 0) {
            const lines = blocked.map(b => `- ${b.question}`);
            answer += `\n\n**Not covered:** the following aspect(s) of your question could not be grounded in the indexed evidence and are omitted rather than guessed:\n${lines.join('\n')}`;
        }

        return { answer, unionPacket, finalGate, usedFallback, diagnostics };
    }

    private sectionedFallback(passed: SubTaskResult[]): string {
        const sections = passed.map(p => `### ${p.question}\n\n${p.answer}`);
        return [
            '*A unified narrative for this multi-part answer could not be verified against the evidence, so the independently verified sections are presented as-is.*',
            '',
            ...sections
        ].join('\n');
    }

    private buildUnionPacket(masterQuestion: string, masterPlan: EvidencePlan, passed: SubTaskResult[]): EvidencePacket {
        const itemsById = new Map<string, EvidenceItem>();
        const factsById = new Map<string, EvidenceItem>();
        const gaps: string[] = [];
        const packetDiagnostics: string[] = [];
        for (const sub of passed) {
            for (const item of sub.packet.items) {
                itemsById.set(String(item.id), item);
            }
            for (const fact of sub.packet.facts) {
                factsById.set(String(fact.id), fact);
            }
            gaps.push(...sub.packet.gaps);
            packetDiagnostics.push(...sub.packet.diagnostics);
        }
        return {
            query: masterQuestion,
            plan: masterPlan,
            items: Array.from(itemsById.values()),
            facts: Array.from(factsById.values()),
            coverage: [],
            gaps: Array.from(new Set(gaps)),
            diagnostics: packetDiagnostics,
            coverageScore: passed.length > 0
                ? passed.reduce((sum, s) => sum + s.packet.coverageScore, 0) / passed.length
                : 0,
            matchedEvidenceTypes: Array.from(new Set(passed.flatMap(s => s.packet.matchedEvidenceTypes)))
        };
    }
}
