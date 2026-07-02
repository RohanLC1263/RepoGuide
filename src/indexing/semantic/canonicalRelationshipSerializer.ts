import * as crypto from 'crypto';
import { CanonicalSymbolIdentity } from '../canonicalSymbolIdentity';

export class CanonicalRelationshipSerializer {
    /**
     * Produces a deterministic string representation of a CanonicalSymbolIdentity.
     * Ensures strict ordering of properties independent of object key insertion order.
     */
    public static serializeIdentity(identity: any): string {
        // Explicitly order properties to guarantee determinism
        const kind = identity.kind || identity.symbolKind || '';
        const parts = [
            `package:${identity.package || ''}`,
            `logicalNamespace:${identity.logicalNamespace || ''}`,
            `kind:${kind}`,
            `qualifiedName:${identity.qualifiedName || ''}`,
            `signatureHash:${identity.signatureHash || ''}`,
            `identityOrigin:${identity.identityOrigin || ''}`,
            `identityAuthority:${identity.identityAuthority || ''}`
        ];
        return parts.join('|');
    }

    /**
     * Produces a canonical hash for an identity object.
     */
    public static hashIdentity(identity: any): string {
        return crypto.createHash('sha256')
            .update(this.serializeIdentity(identity))
            .digest('hex');
    }

    /**
     * Produces a canonical hash for a relationship edge.
     */
    public static hashRelationship(relationshipKind: string, source: any, target: any): string {
        const sourceHash = typeof source === 'string' ? source : this.hashIdentity(source);
        const targetHash = typeof target === 'string' ? target : this.hashIdentity(target);
        
        return crypto.createHash('sha256')
            .update(relationshipKind)
            .update(sourceHash)
            .update(targetHash)
            .digest('hex');
    }
}
