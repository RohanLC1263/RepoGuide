import * as assert from 'assert';
import { CanonicalIdentityFactory } from '../../../../../../indexing/semantic/providers/typescript/resolution/canonicalIdentityFactory';
import { IdentityDescriptor } from '../../../../../../indexing/semantic/providers/typescript/internalModels';

describe('CanonicalIdentityFactory', () => {
    it('should create an immutable CanonicalSymbolIdentity strictly from primitive IdentityDescriptor', () => {
        const descriptor: IdentityDescriptor = {
            package: 'test-pkg',
            logicalNamespace: 'src/components',
            qualifiedName: 'Button',
            symbolKind: 'class',
            signatureHash: 'v1|abcdef123456',
            identityOrigin: 'Repository',
            identityAuthority: 'compiler'
        };

        const identity = CanonicalIdentityFactory.create(descriptor);

        assert.strictEqual(identity.package, 'test-pkg');
        assert.strictEqual(identity.logicalNamespace, 'src/components');
        assert.strictEqual(identity.kind, 'class');
        assert.strictEqual(identity.qualifiedName, 'Button');
        assert.strictEqual(identity.signatureHash, 'v1|abcdef123456');
        assert.strictEqual(identity.identityOrigin, 'Repository');
        assert.strictEqual(identity.identityAuthority, 'compiler');
    });
});
