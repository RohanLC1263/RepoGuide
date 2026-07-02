import test from 'node:test';
import * as assert from 'node:assert/strict';
import { CanonicalSymbolIdentity } from './canonicalSymbolIdentity';
import { computeSignatureHash, formatUrn, parseUrn } from './canonicalSymbolIdentityUtils';

test('CanonicalSymbolIdentity', async (t) => {
    await t.test('should format and parse URNs correctly', () => {
        const id: CanonicalSymbolIdentity = {
            package: '@org/my-pkg',
            logicalNamespace: 'src/auth',
            kind: 'method',
            qualifiedName: 'UserService.login',
            signatureHash: 'abcdef12'
        , identityOrigin: 'Synthetic', identityAuthority: 'compiler'};

        const urn = formatUrn(id);
        assert.equal(urn, 'rg://@org/my-pkg/src/auth#method:UserService.login@abcdef12');

        const parsed = parseUrn(urn);
        assert.deepEqual(parsed, id);
    });

    await t.test('should throw on invalid URN', () => {
        assert.throws(() => parseUrn('invalid-urn'));
    });

    await t.test('should differentiate overloads using signature hashing', () => {
        const hash1 = computeSignatureHash(['rg://std/core#class:String@none'], 'rg://std/core#class:Void@none');
        const hash2 = computeSignatureHash(['rg://std/core#class:Number@none'], 'rg://std/core#class:Void@none');

        assert.notEqual(hash1, hash2);
    });

    await t.test('should be deterministic for signature hashing', () => {
        const hash1 = computeSignatureHash(['rg://std/core#class:String@none'], 'rg://std/core#class:Void@none');
        const hash2 = computeSignatureHash(['rg://std/core#class:String@none'], 'rg://std/core#class:Void@none');

        assert.equal(hash1, hash2);
    });
});
