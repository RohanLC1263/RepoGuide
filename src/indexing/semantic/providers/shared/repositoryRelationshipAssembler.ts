// Re-exports RepositoryRelationshipAssembler from the TypeScript provider's own
// folder. Zero TypeScript-compiler dependency (confirmed by direct read: only
// calls CanonicalIdentityFactory.create and CanonicalRelationshipSerializer.hashRelationship,
// both pure-data operations) -- reused as-is by the Python provider, not duplicated.
export { RepositoryRelationshipAssembler } from '../typescript/repositoryRelationshipAssembler';
