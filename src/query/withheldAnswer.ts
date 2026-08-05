import { EvidencePacket } from './evidencePacket';
import { GateResult, THIN_GROUNDING_MIN_SOURCES } from './answerGate';

/**
 * Renders the message shown when the gate withholds an answer.
 *
 * THE DEFECT THIS FIXES. The system had no concept of "insufficient evidence" as an answer
 * state -- only `block` ("a claim failed verification") and `pass`. Which of those an
 * UNGROUNDED question landed in depended on whether the model happened to emit a VERIFIABLE
 * ARTIFACT: fabricate a code fence and a checker catches it, producing a bald refusal
 * (reproduced 5/5 on the community_engine.py dead-code question); hedge in prose instead and
 * there is no number, quote, fence or path to check, so the same unanswerable question passes
 * with a vague answer. Identical underlying condition, opposite user experience, decided by an
 * accident of phrasing.
 *
 * Four near-duplicate messages also existed across the block sites in queryDispatcher, each
 * concatenating `gateResult.diagnostics.join(', ')` -- internal checker jargon -- directly into
 * user-facing text.
 *
 * THE SEPARATION. Reason for withholding is now distinct from presentation, because two
 * genuinely different things were collapsed into one message:
 *
 *   insufficient_evidence -- retrieval found little or nothing. The honest answer is "I don't
 *     have enough evidence", and nothing was necessarily wrong with the model's output. This is
 *     the SAME condition check 6d flags with a caveat when the answer is delivered, so both
 *     paths are worded consistently: a user asking an unanswerable question gets the same
 *     framing whether the model hedged or fabricated.
 *
 *   verification_failed -- retrieval found ample evidence and the answer contradicted it. That
 *     is a real catch and deserves to say so plainly, with the specific reason.
 *
 * The threshold is imported from answerGate rather than redeclared so the withheld message and
 * check 6d can never disagree about what counts as thin.
 */

export type WithholdingKind = 'insufficient_evidence' | 'verification_failed';

/**
 * Which situation a blocked answer represents. Keyed on grounding VOLUME, not on
 * `coverageScore` -- that score is 0 whenever a plan enumerates no required evidence (measured:
 * 9 of 12 answers in a real CraftConnect batch scored 0, several of them correct), so it cannot
 * distinguish these two cases.
 */
export function classifyWithholding(packet: EvidencePacket): WithholdingKind {
    const groundingVolume = packet.facts.length + packet.items.length;
    return groundingVolume < THIN_GROUNDING_MIN_SOURCES ? 'insufficient_evidence' : 'verification_failed';
}

/** First diagnostic, trimmed to one clause, for the verification-failed message. */
function primaryReason(gate: Pick<GateResult, 'diagnostics' | 'unsupported_claims'>): string | null {
    const source = gate.unsupported_claims.length > 0 ? gate.unsupported_claims : gate.diagnostics;
    const first = source.find(d => typeof d === 'string' && d.trim().length > 0);
    if (!first) {
        return null;
    }
    const trimmed = first.trim();
    return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}

/**
 * The user-facing text for a withheld answer.
 *
 * `subject` names what was being answered ("the answer", "this explanation") so the existing
 * call sites keep their wording nuance without each re-inventing the whole sentence.
 *
 * Deliberately does NOT dump `diagnostics.join(', ')`. For the insufficient-evidence case the
 * diagnostics describe checker internals that are not the user's problem and read as noise; for
 * the verification case a single specific reason is more useful than the whole list.
 */
export function renderWithheldAnswer(
    packet: EvidencePacket,
    gate: Pick<GateResult, 'diagnostics' | 'unsupported_claims'>,
    subject: string = 'the answer'
): string {
    const kind = classifyWithholding(packet);
    const sources = packet.facts.length + packet.items.length;

    if (kind === 'insufficient_evidence') {
        const count = sources === 0
            ? 'no supporting evidence'
            : `only ${sources} source${sources === 1 ? '' : 's'}`;
        return `I don't have enough evidence in this repository to answer that. Retrieval found ${count}, `
            + `so any answer would be guesswork rather than something grounded in your code. `
            + `If you expected this to be covered, the code may not be indexed yet, or it may live under a path that is excluded.`;
    }

    const reason = primaryReason(gate);
    return `I found relevant code but could not verify ${subject} against it, so I have withheld it rather than present something unreliable.`
        + (reason ? ` Specifically: ${reason}` : '');
}
