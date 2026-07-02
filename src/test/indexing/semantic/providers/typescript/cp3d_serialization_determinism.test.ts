import * as assert from 'assert';
import { CanonicalRelationshipSerializer } from '../../../../../indexing/semantic/canonicalRelationshipSerializer';
import { CanonicalSymbolIdentity } from '../../../../../indexing/canonicalSymbolIdentity';

describe('CP3D Serialization Determinism', () => {
    it('produces identical serialized strings regardless of property insertion order', () => {
        // Construct object 1
        const identity1: any = {};
        identity1.package = 'pkg';
        identity1.logicalNamespace = 'ns';
        identity1.kind = 'class';
        identity1.qualifiedName = 'MyClass';
        identity1.signatureHash = 'hash123';
        identity1.identityOrigin = 'Repository';
        identity1.identityAuthority = 'compiler';

        // Construct object 2 with properties inserted in reverse order
        const identity2: any = {};
        identity2.identityAuthority = 'compiler';
        identity2.identityOrigin = 'Repository';
        identity2.signatureHash = 'hash123';
        identity2.qualifiedName = 'MyClass';
        identity2.kind = 'class';
        identity2.logicalNamespace = 'ns';
        identity2.package = 'pkg';

        const str1 = CanonicalRelationshipSerializer.serializeIdentity(identity1);
        const str2 = CanonicalRelationshipSerializer.serializeIdentity(identity2);
        
        assert.strictEqual(str1, str2, 'Serialized strings must match exactly');
        
        const hash1 = CanonicalRelationshipSerializer.hashIdentity(identity1);
        const hash2 = CanonicalRelationshipSerializer.hashIdentity(identity2);
        
        assert.strictEqual(hash1, hash2, 'Hashes must match exactly');
    });

    it('handles missing properties gracefully without losing determinism', () => {
        const identity1: any = { qualifiedName: 'A' };
        const identity2: any = { qualifiedName: 'A' };
        
        const str1 = CanonicalRelationshipSerializer.serializeIdentity(identity1);
        const str2 = CanonicalRelationshipSerializer.serializeIdentity(identity2);
        
        assert.strictEqual(str1, str2);
        assert.ok(str1.includes('qualifiedName:A'));
        assert.ok(str1.includes('package:')); // empty
    });
});
