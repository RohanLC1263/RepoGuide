import { CanonicalSymbolIdentity } from '../../../../canonicalSymbolIdentity';
import { IdentityDescriptor } from '../internalModels';

export class CanonicalIdentityFactory {
    /**
     * Constructs an immutable CanonicalSymbolIdentity strictly from a language-neutral IdentityDescriptor.
     * MUST NEVER accept or depend on TypeScript compiler APIs (ts.Symbol, ts.Node, ts.TypeChecker).
     */
    public static create(descriptor: IdentityDescriptor): CanonicalSymbolIdentity {
        return {
            package: descriptor.package,
            logicalNamespace: descriptor.logicalNamespace,
            kind: descriptor.symbolKind,
            qualifiedName: descriptor.qualifiedName,
            signatureHash: descriptor.signatureHash,
            identityOrigin: descriptor.identityOrigin,
            identityAuthority: descriptor.identityAuthority
        };
    }
}
