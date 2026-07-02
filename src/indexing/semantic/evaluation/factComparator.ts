import { CanonicalFact } from '../canonicalFact';
import { FactEvaluationResult, IdentityDriftRecord } from './factEvaluationModels';
import { RejectedConstruct } from './canonicalFactNormalizer';

export class FactComparator {
    /**
     * Performs a pure, deterministic comparison of two sets of CanonicalFacts.
     * Generates a FactEvaluationResult with Missing, Unexpected, Matching, and IdentityDrift counts.
     */
    public compare(legacyFacts: CanonicalFact[], semanticFacts: CanonicalFact[], rejectedConstructs: RejectedConstruct[] = []): FactEvaluationResult {
        // Map inputs for deterministic O(1) lookups
        const legacyMap = new Map<string, CanonicalFact>();
        for (const f of legacyFacts) legacyMap.set(f.factId, f);
        
        const semanticMap = new Map<string, CanonicalFact>();
        for (const f of semanticFacts) semanticMap.set(f.factId, f);

        const matching: CanonicalFact[] = [];
        const missing: CanonicalFact[] = [];
        const unexpected: CanonicalFact[] = [];
        const identityDrift: IdentityDriftRecord[] = [];

        // Identify matching and missing/drifted
        for (const legacy of legacyMap.values()) {
            if (semanticMap.has(legacy.factId)) {
                matching.push(legacy);
                // Remove from semanticMap so we can find purely unexpected ones later
                semanticMap.delete(legacy.factId);
            } else {
                missing.push(legacy);
            }
        }

        for (const semantic of semanticMap.values()) {
            unexpected.push(semantic);
        }

        // REQUIRED REMEDIATION: Deterministic Identity Drift
        // Sort arrays before greedy pairing so Map iteration order cannot affect matching
        missing.sort((a, b) => a.factId.localeCompare(b.factId));
        unexpected.sort((a, b) => a.factId.localeCompare(b.factId));

        // Pass 2: Detect Identity Drift (when applicable)
        // A simple heuristic: if a missing fact shares the same `symbol` or `subjectId`+`objectId`
        // as an unexpected fact, it's likely the same semantic intent but with a drifted payload.
        // We will move these from Missing/Unexpected to IdentityDrift.
        const remainingMissing: CanonicalFact[] = [];
        
        for (const mFact of missing) {
            let matchedDrift: CanonicalFact | undefined;
            
            for (let i = 0; i < unexpected.length; i++) {
                const uFact = unexpected[i];
                if (this.isLikelyIdentityDrift(mFact, uFact)) {
                    matchedDrift = uFact;
                    unexpected.splice(i, 1);
                    break;
                }
            }

            if (matchedDrift) {
                identityDrift.push({
                    original: mFact,
                    drifted: matchedDrift,
                    driftReason: 'Payload hash mismatch but core identity indicators align'
                });
            } else {
                remainingMissing.push(mFact);
            }
        }

        return {
            matching: this.sortFacts(matching),
            missing: this.sortFacts(remainingMissing),
            unexpected: this.sortFacts(unexpected),
            identityDrift: identityDrift.sort((a, b) => a.original.factId.localeCompare(b.original.factId)),
            rejectedConstructs
        };
    }

    private isLikelyIdentityDrift(legacy: CanonicalFact, semantic: CanonicalFact): boolean {
        // Must be same graph type to be a drift
        if (legacy.factType !== semantic.factType) return false;

        const lp = legacy.payload;
        const sp = semantic.payload;

        // Both must have a symbol and they must match
        if (lp.symbol && sp.symbol && lp.symbol === sp.symbol) {
            return true;
        }

        // Or both must have a subjectId and they must match (and objectId if relationship)
        if (legacy.factType === 'RELATIONSHIP') {
            if (lp.subjectId && sp.subjectId && lp.objectId && sp.objectId) {
                if (lp.subjectId === sp.subjectId && lp.objectId === sp.objectId) {
                    return true;
                }
            }
        }

        return false;
    }

    private sortFacts(facts: CanonicalFact[]): CanonicalFact[] {
        return facts.sort((a, b) => a.factId.localeCompare(b.factId));
    }
}
