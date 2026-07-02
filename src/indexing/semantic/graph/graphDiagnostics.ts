import { CanonicalFact } from '../canonicalFact';

export interface GraphIntegrityViolation {
    readonly type: 'MissingEndpoint' | 'Other';
    readonly edgeId?: string;
    readonly missingCanonicalIdentity?: string;
    readonly description: string;
}

export interface GraphDiagnostics {
    /** CanonicalFacts that cannot be represented structurally (e.g., UNKNOWN) */
    readonly unknownFacts: CanonicalFact[];
    
    /** Relationship facts referencing missing entities */
    readonly missingEndpoints: GraphIntegrityViolation[];
    
    /** Graph consistency failures */
    readonly integrityViolations: GraphIntegrityViolation[];
    
    /** Facts intentionally excluded during graph construction */
    readonly rejectedFacts: CanonicalFact[];
    
    /** Non-fatal implementation warnings */
    readonly buildWarnings: string[];
}
