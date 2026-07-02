import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SignatureGenerator } from './signatureGenerator';
import { EntitySignature } from './types';

describe('SignatureGenerator', () => {
    it('should generate a deterministic signature for an entity', () => {
        const sig: EntitySignature = {
            filePath: 'src/store/logicalUnitStore.ts',
            symbol: 'LogicalUnitStore',
            type: 'class'
        };
        const result = SignatureGenerator.generate(sig);
        assert.equal(result, 'src/store/logicalunitstore.ts::LogicalUnitStore::class');
    });

    it('should handle windows paths and normalize to lowercase forward slashes', () => {
        const sig: EntitySignature = {
            filePath: 'src\\STORE\\LogicalUnitStore.ts',
            symbol: 'LogicalUnitStore',
            type: 'class'
        };
        const result = SignatureGenerator.generate(sig);
        assert.equal(result, 'src/store/logicalunitstore.ts::LogicalUnitStore::class');
    });

    it('should fallback to block if symbol is undefined', () => {
        const sig: EntitySignature = {
            filePath: 'src/store/logicalUnitStore.ts',
            type: 'import_block'
        };
        const result = SignatureGenerator.generate(sig);
        assert.equal(result, 'src/store/logicalunitstore.ts::block::import_block');
    });
});
