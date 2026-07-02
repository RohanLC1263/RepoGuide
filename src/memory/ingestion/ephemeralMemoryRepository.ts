import { CandidateMemory } from "./candidateMemory";

export interface EphemeralMemoryState {
    candidateId: string;
    observationCount: number;
    candidate: CandidateMemory;
}

export interface EphemeralMemoryRepository {
    trackObservation(candidate: CandidateMemory): Promise<EphemeralMemoryState>;
    remove(candidateId: string): Promise<void>;
}

export class InMemoryEphemeralMemoryRepository implements EphemeralMemoryRepository {
    private states: Map<string, EphemeralMemoryState> = new Map();

    public async trackObservation(candidate: CandidateMemory): Promise<EphemeralMemoryState> {
        // Simplified identity matching: using normalized content and scope
        const key = `${candidate.proposal.repositoryId}:${candidate.proposal.scope}:${candidate.normalizedContent}`;
        
        let state = this.states.get(key);
        if (!state) {
            state = {
                candidateId: candidate.candidateId,
                observationCount: 1,
                candidate
            };
        } else {
            state.observationCount += 1;
            // Update candidate to latest observation
            state.candidate = candidate;
        }
        
        this.states.set(key, state);
        return state;
    }

    public async remove(candidateId: string): Promise<void> {
        for (const [key, state] of this.states.entries()) {
            if (state.candidateId === candidateId) {
                this.states.delete(key);
                break;
            }
        }
    }
}
