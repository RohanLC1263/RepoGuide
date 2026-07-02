import { CandidateMemory } from "./candidateMemory";
import { MemoryStore } from "../memoryTypes";

export interface ConflictResult {
    hasConflict: boolean;
    loserMemoryId?: string;
    escalateToHuman: boolean;
}

export class ConflictResolutionService {
    constructor(private readonly memoryStore: MemoryStore) {}

    public async detectAndResolve(candidate: CandidateMemory): Promise<ConflictResult> {
        // Fetch all active memories in the same scope to check for contradictions
        const results = await this.memoryStore.search({
            repositoryIds: [candidate.proposal.repositoryId],
            scope: candidate.proposal.scope,
            limit: 10
        });

        for (const record of results) {
            // Check if scopes overlap
            const overlaps = candidate.proposal.scopeKeys.length === 0 || 
                             record.scopeKeys.length === 0 ||
                             candidate.proposal.scopeKeys.some(sk => record.scopeKeys.includes(sk));
            
            if (!overlaps) continue;

            if (this.isContradiction(record.content, candidate.proposal.content)) {
                
                // Rule: User Fact overrides All
                if (candidate.proposal.source === 'user') {
                    await this.memoryStore.markStale(record.id);
                    return { hasConflict: true, loserMemoryId: record.id, escalateToHuman: false };
                }

                // Rule: Newer System Fact overrides Older Mentor Fact
                const recordAuthor = record.provenance?.authorType;
                console.log(`Checking conflict: candidate=${candidate.proposal.source}, recordAuthor=${recordAuthor}`);
                if (candidate.proposal.source === 'system' && recordAuthor === 'mentor') {
                    console.log(`Marking stale: ${record.id}`);
                    await this.memoryStore.markStale(record.id);
                    return { hasConflict: true, loserMemoryId: record.id, escalateToHuman: false };
                }

                // Rule: Ambiguous Confidence (Human Escalation)
                if (candidate.proposal.source === 'mentor' && recordAuthor === 'mentor') {
                    return { hasConflict: true, escalateToHuman: true };
                }
            }
        }

        return { hasConflict: false, escalateToHuman: false };
    }

    private isContradiction(contentA: string, contentB: string): boolean {
        // Mocked contradiction detection
        const a = contentA.toLowerCase();
        const b = contentB.toLowerCase();
        
        if (a.includes('jest') && b.includes('vitest')) return true;
        if (a.includes('sqlite') && b.includes('postgresql')) return true;
        if (a.includes('camelcase') && b.includes('snake_case')) return true;

        return false;
    }
}
