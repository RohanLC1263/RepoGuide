// Re-exports the language-neutral boundary types from the TypeScript provider's
// internalModels.ts. These 4 interfaces (IdentityDescriptor, RelationshipDescriptor,
// RelationshipIdentity, RelationshipAggregate) never reference `ts.*` -- they're the
// "frozen boundary" every provider (TS, Python, future languages) builds toward and
// the shared assemblers (canonicalIdentityFactory, observationAccumulator,
// repositoryRelationshipAssembler) consume. Re-exported rather than physically
// relocated out of typescript/internalModels.ts to avoid touching that file's
// existing consumers/tests; this gives new providers a clean, language-neutral
// import path without any risk to the TypeScript provider.
export type {
    IdentityDescriptor,
    RelationshipDescriptor,
    RelationshipIdentity,
    RelationshipAggregate
} from '../typescript/internalModels';
