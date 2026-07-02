import { CanonicalFact } from '../canonicalFact';
import { RejectedConstruct } from './canonicalFactNormalizer';

export type DifferenceCategory = 'Matching' | 'Missing' | 'Unexpected' | 'IdentityDrift';

export interface IdentityDriftRecord {
    original: CanonicalFact;
    drifted: CanonicalFact;
    driftReason?: string;
}

export interface FactEvaluationResult {
    matching: CanonicalFact[];
    missing: CanonicalFact[];       // Present in legacy, missing in semantic
    unexpected: CanonicalFact[];    // Missing in legacy, present in semantic
    identityDrift: IdentityDriftRecord[];
    rejectedConstructs: RejectedConstruct[];
}
