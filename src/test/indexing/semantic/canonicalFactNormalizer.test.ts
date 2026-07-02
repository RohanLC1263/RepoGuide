import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CanonicalFactNormalizer } from '../../../indexing/semantic/evaluation/canonicalFactNormalizer';
import { FactRecord } from '../../../indexing/factTypes';

describe('Slice 5: CanonicalFactNormalizer', () => {
    const normalizer = new CanonicalFactNormalizer();

    const legacyEntity1: FactRecord = {
        factId: 'legacy_1',
        filePath: 'test.ts',
        unitId: 'unit_1',
        factType: 'assignment',
        valueKind: 'string',
        value: 'hello',
        symbol: 'MyVar',
        startLine: 1,
        endLine: 2,
        extractionMethod: 'ast_query',
        confidence: 'high',
        sourceText: 'const MyVar = "hello";',
        role: 'implementation'
    };

    const legacyEntity2: FactRecord = {
        factId: 'legacy_2',
        filePath: 'test.ts',
        unitId: 'unit_2',
        factType: 'calls_method',
        valueKind: 'null',
        value: null,
        canonicalSubjectId: { 
            package: 'app', logicalNamespace: 'global', kind: 'var', qualifiedName: 'MyVar', signatureHash: 'h1', identityOrigin: 'Repository', identityAuthority: 'parser'
        },
        canonicalObjectId: { 
            package: 'app', logicalNamespace: 'global', kind: 'method', qualifiedName: 'someMethod', signatureHash: 'h2', identityOrigin: 'Repository', identityAuthority: 'parser'
        },
        startLine: 5,
        endLine: 5,
        extractionMethod: 'ast_query',
        confidence: 'high',
        sourceText: 'MyVar.someMethod();',
        role: 'implementation'
    };

    const legacyUnsupported: FactRecord = {
        factId: 'legacy_3',
        filePath: 'test.ts',
        unitId: 'unit_3',
        factType: 'assignment',
        valueKind: 'ast_node', // unsupported
        value: {}, // some mock ast node
        startLine: 1,
        endLine: 1,
        extractionMethod: 'ast_query',
        confidence: 'high',
        sourceText: '...',
        role: 'implementation'
    };

    it('Normalization: identical legacy inputs normalize identically and deterministically', () => {
        const canonicals1 = normalizer.normalize([legacyEntity1, legacyEntity2]).normalizedFacts;
        const canonicals2 = normalizer.normalize([legacyEntity2, legacyEntity1]).normalizedFacts; // Shuffled
        const canonicals3 = normalizer.normalize([legacyEntity1, legacyEntity2, legacyEntity1]).normalizedFacts; // Duplicates

        assert.deepEqual(canonicals1, canonicals2);
        assert.deepEqual(canonicals1, canonicals3); // Duplicates should be filtered
    });

    it('Normalization: correctly maps entities vs relationships', () => {
        const canonicals = normalizer.normalize([legacyEntity1, legacyEntity2]).normalizedFacts;
        
        // Find them by inspecting the payload since order is sorted by hash
        const entityFact = canonicals.find(f => f.factType === 'ENTITY')!;
        const relFact = canonicals.find(f => f.factType === 'RELATIONSHIP')!;

        assert.ok(entityFact);
        assert.equal(entityFact.payload.legacyFactType, 'assignment');
        assert.equal(entityFact.payload.symbol, 'MyVar');
        assert.equal(entityFact.payload.value, 'hello');

        assert.ok(relFact);
        assert.equal(relFact.payload.legacyFactType, 'calls_method');
        assert.equal(relFact.payload.subjectId.qualifiedName, 'MyVar');
        assert.equal(relFact.payload.objectId.qualifiedName, 'someMethod');
    });

    it('Normalization: unsupported legacy constructs explicitly reported', () => {
        const result = normalizer.normalize([legacyEntity1, legacyUnsupported]);
        
        assert.equal(result.normalizedFacts.length, 1);
        assert.equal(result.normalizedFacts[0].payload.legacyFactType, 'assignment');
        assert.equal(result.normalizedFacts[0].payload.valueKind, undefined); // payload.valueKind is set

        assert.equal(result.rejectedConstructs.length, 1);
        assert.equal(result.rejectedConstructs[0].factId, 'legacy_3');
        assert.match(result.rejectedConstructs[0].reason, /ast_node/);
    });

    it('Purity: normalizer never mutates inputs', () => {
        const clone = JSON.parse(JSON.stringify(legacyEntity1));
        normalizer.normalize([legacyEntity1]);
        assert.deepEqual(legacyEntity1, clone);
    });
});
