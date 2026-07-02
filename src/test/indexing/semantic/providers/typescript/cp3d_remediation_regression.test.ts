import * as assert from 'assert';
import { CanonicalRelationshipSerializer } from '../../../../../indexing/semantic/canonicalRelationshipSerializer';

describe('CP3D Remediation Regression Tests', () => {
    const A = { package: 'pkg', logicalNamespace: 'ns', kind: 'class', qualifiedName: 'A', signatureHash: 'hashA', identityOrigin: 'Repository', identityAuthority: 'compiler' };
    const B = { package: 'pkg', logicalNamespace: 'ns', kind: 'class', qualifiedName: 'B', signatureHash: 'hashB', identityOrigin: 'Repository', identityAuthority: 'compiler' };

    it('proves CALLS(A,B) != CALLS(B,A)', () => {
        const ab = CanonicalRelationshipSerializer.hashRelationship('CALLS', A, B);
        const ba = CanonicalRelationshipSerializer.hashRelationship('CALLS', B, A);
        assert.notStrictEqual(ab, ba);
    });

    it('proves CALLS(A,B) != IMPORTS(A,B)', () => {
        const calls = CanonicalRelationshipSerializer.hashRelationship('CALLS', A, B);
        const imports = CanonicalRelationshipSerializer.hashRelationship('IMPORTS', A, B);
        assert.notStrictEqual(calls, imports);
    });

    it('proves IMPORTS(A,B) remains stable across repeated extraction', () => {
        const extraction1 = CanonicalRelationshipSerializer.hashRelationship('IMPORTS', A, B);
        const extraction2 = CanonicalRelationshipSerializer.hashRelationship('IMPORTS', A, B);
        const extraction3 = CanonicalRelationshipSerializer.hashRelationship('IMPORTS', A, B);
        
        assert.strictEqual(extraction1, extraction2);
        assert.strictEqual(extraction2, extraction3);
    });

    it('proves identical logical relationships always produce identical IDs', () => {
        const A_clone = { ...A };
        const B_clone = { ...B };
        
        const rel1 = CanonicalRelationshipSerializer.hashRelationship('EXTENDS', A, B);
        const rel2 = CanonicalRelationshipSerializer.hashRelationship('EXTENDS', A_clone, B_clone);
        
        assert.strictEqual(rel1, rel2);
    });
});
