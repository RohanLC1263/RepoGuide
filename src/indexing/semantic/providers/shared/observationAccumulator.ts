// Re-exports ObservationAccumulator from the TypeScript provider's resolution/
// folder. Zero TypeScript-compiler dependency (it operates purely on the
// language-neutral IdentityDescriptor/RelationshipDescriptor/RelationshipAggregate
// types) -- reused as-is by the Python provider, not duplicated. Its constructor
// now takes an optional evidenceType (default 'compiler', preserving today's
// TypeScript behavior) so non-compiler-based providers can label their evidence
// accurately instead of falsely claiming compiler verification.
export { ObservationAccumulator } from '../typescript/resolution/observationAccumulator';
