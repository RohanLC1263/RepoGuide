import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CanonicalFactAdapter } from '../../../indexing/semantic/canonicalFactAdapter';
import { CanonicalFactFactory } from '../../../indexing/semantic/canonicalFact';
import { SemanticExtractionResult } from '../../../indexing/semantic/semanticProviderContract';

describe('Slice 1: CanonicalFact Integration & Determinism', () => {
    const mockIdentity1 = {
        kind: 'class',
        package: 'test-pkg',
        qualifiedName: 'MyClass',
        logicalNamespace: 'src.test',
        signatureHash: 'hash1',
        identityOrigin: 'source',
        identityAuthority: 'compiler'
    };

    const mockIdentity2 = {
        kind: 'function',
        package: 'test-pkg',
        qualifiedName: 'myFunc',
        logicalNamespace: 'src.test',
        signatureHash: 'hash2',
        identityOrigin: 'source',
        identityAuthority: 'compiler'
    };

    const createMockResult = (): SemanticExtractionResult => ({
        status: 'SUCCESS',
        providerMetadata: {
            providerName: 'typescript-semantic-provider',
            providerVersion: '1.0.0',
            extractionMethod: 'compiler',
            extractionTimestampMs: 123456789
        },
        entities: [
            {
                canonicalId: mockIdentity1 as any,
                name: 'MyClass',
                entityKind: 'class',
                declarationLocation: { filePath: 'test.ts', startLine: 10, endLine: 20 },
                modifiers: ['export'],
                visibility: 'public'
            },
            {
                canonicalId: mockIdentity2 as any,
                name: 'myFunc',
                entityKind: 'function',
                declarationLocation: { filePath: 'test.ts', startLine: 25, endLine: 30 },
                modifiers: [],
                visibility: 'private'
            }
        ],
        relationships: [
            {
                id: 'rel1',
                category: 'structural',
                relationshipKind: 'CALLS',
                source: mockIdentity2 as any,
                target: mockIdentity1 as any,
                evidence: [
                    {
                        id: 'ev1',
                        type: 'compiler',
                        location: { filePath: 'test.ts', startLine: 26, endLine: 26 }
                    }
                ]
            }
        ],
        knownUnknowns: [],
        diagnostics: [],
        metrics: {
            durationMs: 10,
            filesProcessed: 1,
            entitiesExtracted: 2,
            relationshipsExtracted: 1,
            unknownsFound: 0
        }
    });

    it('Identity Determinism: Equivalent SemanticExtractionResult instances always produce identical CanonicalFact IDs', () => {
        const resultA = CanonicalFactAdapter.translate(createMockResult());
        const resultB = CanonicalFactAdapter.translate(createMockResult());
        
        assert.equal(resultA.facts.length, 3); // 2 entities + 1 relationship
        
        const factIdsA = resultA.facts.map((f: any) => f.factId);
        const factIdsB = resultB.facts.map((f: any) => f.factId);
        
        assert.deepEqual(factIdsA, factIdsB);
    });

    it('Observation Determinism: Equivalent observations always produce identical Observation IDs', () => {
        const resultA = CanonicalFactAdapter.translate(createMockResult());
        const resultB = CanonicalFactAdapter.translate(createMockResult());
        
        assert.equal(resultA.observations.length, 3);
        
        const obsIdsA = resultA.observations.map((o: any) => o.observationId);
        const obsIdsB = resultB.observations.map((o: any) => o.observationId);
        
        assert.deepEqual(obsIdsA, obsIdsB);
    });

    it('Adapter Determinism: Changing ordering of arrays must not change CanonicalFact output', () => {
        const mock1 = createMockResult();
        const mock2 = createMockResult();
        
        // Reverse arrays in mock2
        mock2.entities = [...mock1.entities].reverse();
        
        const resultA = CanonicalFactAdapter.translate(mock1);
        const resultB = CanonicalFactAdapter.translate(mock2);
        
        const factIdsA = resultA.facts.map((f: any) => f.factId);
        const factIdsB = resultB.facts.map((f: any) => f.factId);
        assert.deepEqual(factIdsA, factIdsB);
        
        const obsIdsA = resultA.observations.map((o: any) => o.observationId);
        const obsIdsB = resultB.observations.map((o: any) => o.observationId);
        assert.deepEqual(obsIdsA, obsIdsB);
    });

    it('Immutability: CanonicalFact contains no mutable provenance or EvidenceReference collections', () => {
        const result = CanonicalFactAdapter.translate(createMockResult());
        
        for (const fact of result.facts) {
            const keys = Object.keys(fact);
            assert.equal(keys.includes('evidence'), false);
            assert.equal(keys.includes('provenance'), false);
            assert.equal(keys.includes('observations'), false);
        }
    });

    it('Deep Immutability: Attempt runtime mutation of nested payload objects', () => {
        const result = CanonicalFactAdapter.translate(createMockResult());
        const fact = result.facts[0];
        
        assert.throws(() => {
            (fact.payload as any).newProp = 'mutated';
        }, /Cannot add property newProp, object is not extensible/);

        assert.throws(() => {
            (fact.payload.canonicalId as any).kind = 'mutated';
        }, /Cannot assign to read only property 'kind' of object/);
    });

    it('Reference Isolation: Adapter creates entirely new object graphs', () => {
        const mockResult = createMockResult();
        const result = CanonicalFactAdapter.translate(mockResult);
        
        // Mutate original mock
        mockResult.entities[0].name = 'MutatedClass';
        (mockResult.entities[0].canonicalId as any).kind = 'mutated';
        
        // Verify facts remain unchanged
        const fact = result.facts.find(f => f.payload.name === 'MyClass');
        assert.ok(fact);
        assert.equal(fact.payload.canonicalId.kind, 'class');
    });

    it('Nested Compiler Leakage: Attach mock compiler objects inside nested CanonicalSymbolIdentity structures', () => {
        const mockWithExtra = createMockResult();
        // Attach compiler node to canonicalId
        (mockWithExtra.entities[0].canonicalId as any)._compilerNode = { kind: 'ts.Node', getText: () => 'class MyClass' };
        
        const result = CanonicalFactAdapter.translate(mockWithExtra);
        
        for (const fact of result.facts) {
            const payloadStr = JSON.stringify(fact.payload);
            assert.equal(payloadStr.includes('_compilerNode'), false);
            assert.equal(payloadStr.includes('ts.Node'), false);
            // Verify explicitly it's undefined on the object
            assert.equal((fact.payload.canonicalId as any)?._compilerNode, undefined);
        }
    });

    it('Serialization Edge Cases: Verify deterministic handling of null and undefined', () => {
        const payload1 = { a: null, b: 2 };
        const payload2 = { a: undefined, b: 2 };
        
        const hash1 = CanonicalFactFactory.hashFact('ENTITY', payload1);
        const hash2 = CanonicalFactFactory.hashFact('ENTITY', payload2);
        
        assert.notEqual(hash1, hash2, 'null and undefined must produce different hashes');
    });

    it('Unsupported Payload Types: Attempt serialization of Date, Map, Set, Function', () => {
        assert.throws(() => {
            CanonicalFactFactory.hashFact('ENTITY', { d: new Date() });
        }, /Unsupported complex object in payload: Date/);

        assert.throws(() => {
            CanonicalFactFactory.hashFact('ENTITY', { m: new Map() });
        }, /Unsupported complex object in payload: Map/);

        assert.throws(() => {
            CanonicalFactFactory.hashFact('ENTITY', { s: new Set() });
        }, /Unsupported complex object in payload: Set/);

        assert.throws(() => {
            CanonicalFactFactory.hashFact('ENTITY', { f: () => {} });
        }, /Unsupported payload type: function/);
    });
    
    it('CanonicalFactFactory properly normalizes object keys in payload hashing', () => {
        const payload1 = { a: 1, b: 2 };
        const payload2 = { b: 2, a: 1 };
        
        const hash1 = CanonicalFactFactory.hashFact('ENTITY', payload1);
        const hash2 = CanonicalFactFactory.hashFact('ENTITY', payload2);
        
        assert.equal(hash1, hash2);
    });
});
