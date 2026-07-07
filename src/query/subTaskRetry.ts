import { EvidencePacket } from './evidencePacket';
import { AnswerGate, AnswerGatePolicy, GateResult } from './answerGate';
import { buildEvidenceMessages } from '../prompts/evidencePrompt';
import { ChatFn } from './subAnswerMerger';

export interface RetryOutcome {
    answer: string;
    gate: GateResult;
    recovered: boolean;
}

/**
 * One retry for a gate-blocked sub-task answer, designed from the measured
 * mechanism (subTaskFlakinessProbe.ts), not assumption: retrieval on the
 * sub-task path is bit-stable (identical packet and prompt hashes across 6/6
 * runs) and generation is near-deterministic on an identical prompt -- so a
 * blind re-retrieve or re-sample reproduces the SAME blocked answer. The only
 * retry that can work is one that CHANGES the prompt: same packet, plus the
 * gate's concrete rejection reasons and an instruction to answer without the
 * failing pattern (or to say plainly that the evidence doesn't determine the
 * answer). The retry output faces the same full AnswerGate pass -- a retry
 * never lowers the bar, it only gets one chance to clear it.
 */
export async function retrySynthesisWithGateFeedback(
    packet: EvidencePacket,
    blockedGate: GateResult,
    policy: AnswerGatePolicy,
    chat: ChatFn,
    answerGate: AnswerGate = new AnswerGate(),
    workspaceRoot?: string
): Promise<RetryOutcome> {
    const messages = buildEvidenceMessages(packet, []);
    messages.push({
        role: 'user',
        content: [
            'Your previous answer to this question was rejected by automatic verification for the following reason(s):',
            ...blockedGate.diagnostics.map(d => `- ${d}`),
            '',
            'Answer the question again using ONLY the Evidence Packet above.',
            'Do NOT include any code block, quoted string, number, or file path that does not appear verbatim in the evidence.',
            'If the evidence genuinely does not determine part of the answer, say so plainly instead of illustrating with invented code.'
        ].join('\n')
    });

    const answer = await chat(messages);
    const gate = answerGate.verify(answer, packet, policy, workspaceRoot);
    return { answer, gate, recovered: gate.outcome !== 'block' };
}
