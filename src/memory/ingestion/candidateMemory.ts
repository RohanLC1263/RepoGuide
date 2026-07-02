import { MemoryProposal } from "./memoryProposal";

export interface CandidateMemory {
    candidateId: string;
    proposal: MemoryProposal;
    normalizedContent: string;
    timestamp: string;
}

export function createCandidate(proposal: MemoryProposal): CandidateMemory {
    return {
        candidateId: `cand-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        proposal,
        normalizedContent: proposal.content.trim(),
        timestamp: new Date().toISOString()
    };
}
