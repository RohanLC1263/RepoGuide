// Re-exports the compiler-agnostic CanonicalIdentityFactory from the TypeScript
// provider's resolution/ folder. It has zero TypeScript-compiler dependency (confirmed
// by direct read: pure IdentityDescriptor -> CanonicalSymbolIdentity field mapping) --
// reused as-is by the Python provider, not duplicated. See shared/internalModels.ts
// for why this is a re-export rather than a physical relocation.
export { CanonicalIdentityFactory } from '../typescript/resolution/canonicalIdentityFactory';
