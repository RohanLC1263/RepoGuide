import test from 'node:test';
import * as assert from 'node:assert/strict';
import { SymbolIndex } from '../../indexing/symbolIndex';
import { CanonicalSymbolIdentity } from '../../indexing/canonicalSymbolIdentity';
import { SymbolEntry } from '../../store/storeTypes';

test('Checkpoint 2 Migration (SymbolIndex)', async (t) => {
    let index: SymbolIndex;

    t.beforeEach(() => {
        index = new SymbolIndex();
    });

    await t.test('should support legacy string lookups', () => {
        const legacyEntry: SymbolEntry = {
            name: 'LegacyClass',
            filePath: 'src/legacy.ts',
            startLine: 1,
            endLine: 10,
            kind: 'class'
        };
        
        index.addSymbols([legacyEntry]);
        
        const results = index.lookup('LegacyClass');
        assert.equal(results.length, 1);
        assert.equal(results[0].name, 'LegacyClass');
    });

    await t.test('should support canonical symbol lookups', () => {
        const canonicalId: CanonicalSymbolIdentity = {
            package: '@org/pkg',
            logicalNamespace: 'src/core',
            kind: 'class',
            qualifiedName: 'CoreClass',
            signatureHash: 'hash'
        , identityOrigin: 'Synthetic', identityAuthority: 'compiler'};

        const migratedEntry: SymbolEntry = {
            name: 'CoreClass',
            filePath: 'src/core.ts',
            startLine: 1,
            endLine: 10,
            kind: 'class',
            canonicalId: canonicalId
        };
        
        index.addSymbols([migratedEntry]);
        
        // Canonical lookup
        const canonicalResults = index.lookup(canonicalId);
        assert.equal(canonicalResults.length, 1);
        assert.equal(canonicalResults[0].name, 'CoreClass');
        
        // Legacy lookup still works for the migrated symbol
        const legacyResults = index.lookup('CoreClass');
        assert.equal(legacyResults.length, 1);
        assert.ok(legacyResults[0].canonicalId !== undefined);
    });

    await t.test('lookupExact should work transparently', () => {
        const canonicalId: CanonicalSymbolIdentity = {
            package: '@org/pkg',
            logicalNamespace: 'src/core',
            kind: 'class',
            qualifiedName: 'ExactClass',
            signatureHash: 'hash'
        , identityOrigin: 'Synthetic', identityAuthority: 'compiler'};

        const entry: SymbolEntry = {
            name: 'ExactClass',
            filePath: 'src/exact.ts',
            startLine: 1,
            endLine: 10,
            kind: 'class',
            canonicalId: canonicalId
        };

        index.addSymbols([entry]);

        // String lookupExact
        const stringResults = index.lookupExact('ExactClass');
        assert.equal(stringResults.length, 1);
        assert.equal(stringResults[0].confidence, 1.0);

        // Canonical lookupExact
        const canResults = index.lookupExact(canonicalId);
        assert.equal(canResults.length, 1);
        assert.equal(canResults[0].confidence, 1.0);
    });
});
