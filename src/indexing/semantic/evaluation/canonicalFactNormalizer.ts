import { FactRecord } from '../../factTypes';
import { CanonicalFact, CanonicalFactFactory, FactType } from '../canonicalFact';

export interface RejectedConstruct {
    factId: string;
    reason: string;
}

export interface NormalizationResult {
    normalizedFacts: CanonicalFact[];
    rejectedConstructs: RejectedConstruct[];
}

export class CanonicalFactNormalizer {
    /**
     * Normalizes legacy FactRecords into immutable CanonicalFacts.
     * Unsupported legacy constructs are explicitly reported to ensure
     * deterministic evaluation without reliance on graph storage.
     */
    public normalize(legacyFacts: FactRecord[]): NormalizationResult {
        const canonicalFacts: CanonicalFact[] = [];
        const rejectedConstructs: RejectedConstruct[] = [];
        
        // Deduplicate output to prevent identical normalized facts from artificially inflating counts
        const uniqueFacts = new Map<string, CanonicalFact>();

        for (const legacy of legacyFacts) {
            // Unsupported construct handling
            if (legacy.valueKind === 'ast_node') {
                rejectedConstructs.push({
                    factId: legacy.factId,
                    reason: "Unsupported legacy construct: valueKind 'ast_node' cannot be safely serialized"
                });
                continue;
            }

            const payload: Record<string, any> = {
                legacyFactType: legacy.factType,
                valueKind: legacy.valueKind
            };

            if (legacy.symbol !== undefined) payload.symbol = legacy.symbol;
            if (legacy.value !== undefined) payload.value = legacy.value;
            
            // Reconstruct relationships vs entities
            let factType: FactType = 'ENTITY';
            
            if (legacy.canonicalSubjectId) {
                payload.subjectId = legacy.canonicalSubjectId;
            }
            if (legacy.canonicalObjectId) {
                payload.objectId = legacy.canonicalObjectId;
                if (legacy.canonicalSubjectId) {
                    factType = 'RELATIONSHIP';
                }
            }

            const fact = CanonicalFactFactory.createFact(factType, payload);
            if (!uniqueFacts.has(fact.factId)) {
                uniqueFacts.set(fact.factId, fact);
            }
        }

        // Deterministic sorting based on factId string locale compare
        const sorted = Array.from(uniqueFacts.values()).sort((a, b) => a.factId.localeCompare(b.factId));
        return {
            normalizedFacts: sorted,
            rejectedConstructs
        };
    }
}
