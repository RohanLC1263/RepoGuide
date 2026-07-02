import { MemoryRecord } from '../memoryTypes';

export class MemoryReranker {
    private sourceBonuses: Record<string, number> = {
        'user': 0.03,
        'mentor': 0.02,
        'adr': 0.01,
        'system': 0.00,
        'git': -0.01
    };

    public rerankAndFilter(records: MemoryRecord[], requestedLimit: number): MemoryRecord[] {
        // 1. Calculate scores
        const scoredRecords = records.map(record => {
            const distance = record.distance ?? 0.0;
            const vectorRelevance = Math.max(0, 1.0 - distance); 
            
            const authorType = record.provenance.authorType.toLowerCase();
            const sourceBonus = this.sourceBonuses[authorType] || 0.0;
            
            // Recency Bonus
            const timestamp = record.provenance.timestamp ? new Date(record.provenance.timestamp).getTime() : Date.now();
            const ageInDays = Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60 * 24));
            const recencyBonus = Math.max(0, Math.min(0.03, 0.03 * Math.exp(-ageInDays / 30)));
            
            // Confidence Modifier
            const confidence = record.confidence ?? 0.9; // Default to 0.9 if not present
            const confidenceModifier = Math.max(-0.02, Math.min(0.02, (confidence - 0.5) * 0.04));

            const rawScore = vectorRelevance + sourceBonus + recencyBonus + confidenceModifier;

            return { record, rawScore, authorType, details: { vectorRelevance, sourceBonus, recencyBonus, confidenceModifier } };
        });

        // 2. Sort by raw score descending (to determine who gets the penalty based on rank)
        scoredRecords.sort((a, b) => b.rawScore - a.rawScore);

        // 3. Apply soft diversity penalties
        const typeCounts: Record<string, number> = {};
        const finalScoredRecords = scoredRecords.map(item => {
            const type = item.authorType;
            typeCounts[type] = (typeCounts[type] || 0) + 1;
            
            const penalty = Math.max(0, (typeCounts[type] - 2) * 0.02);
            const finalScore = item.rawScore - penalty;
            
            (item.record as any)._v2ScoreDetails = {
                ...item.details,
                diversityPenalty: penalty,
                finalScore
            };

            return { record: item.record, finalScore, authorType: item.authorType };
        });

        // 4. Sort by final score and apply requestedLimit
        finalScoredRecords.sort((a, b) => b.finalScore - a.finalScore);

        const finalRecords: MemoryRecord[] = [];
        for (const item of finalScoredRecords) {
            if (finalRecords.length >= requestedLimit) {
                break;
            }
            finalRecords.push(item.record);
        }

        return finalRecords;
    }
}
