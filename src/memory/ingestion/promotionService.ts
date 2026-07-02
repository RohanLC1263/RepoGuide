import { CandidateMemory } from "./candidateMemory";
import { EphemeralMemoryRepository } from "./ephemeralMemoryRepository";

export interface PromotionResult {
    promote: boolean;
}

export class PromotionService {
    private readonly N_THRESHOLD = 3;

    constructor(private readonly ephemeralRepo: EphemeralMemoryRepository) {}

    public async evaluate(candidate: CandidateMemory): Promise<PromotionResult> {
        // 1. Immediate User Promotion
        if (candidate.proposal.source === 'user') {
            return { promote: true };
        }

        // 2. System-Derived Auto-Promotion
        if (candidate.proposal.source === 'system') {
            return { promote: true };
        }

        // 3. Mentor Ephemeral Hold & N-Observation Threshold
        if (candidate.proposal.source === 'mentor') {
            const state = await this.ephemeralRepo.trackObservation(candidate);
            if (state.observationCount >= this.N_THRESHOLD) {
                // Target met, cleanup ephemeral state
                await this.ephemeralRepo.remove(state.candidateId);
                return { promote: true };
            }
            return { promote: false };
        }

        return { promote: false };
    }
}
