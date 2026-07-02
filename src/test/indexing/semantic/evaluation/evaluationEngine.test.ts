import { suite, test } from 'mocha';
import * as assert from 'assert';
import { EvaluationEngine } from '../../../../indexing/semantic/evaluation/evaluationEngine';
import { ExactMatchComparisonStrategy } from '../../../../indexing/semantic/evaluation/exactMatchComparisonStrategy';
import { GroundTruth, EvaluationCandidate } from '../../../../indexing/semantic/evaluation/evaluationModels';

suite('EvaluationEngine & ExactMatchComparisonStrategy', () => {
    
    test('Correctly calculates precision and recall for exact matches', () => {
        const engine = new EvaluationEngine();
        const strategy = new ExactMatchComparisonStrategy();
        
        const truth: GroundTruth = {
            id: 'fixture-1',
            version: '1',
            description: 'test',
            metadata: {
                source: 'manual',
                creationMethod: 'hand_coded',
                approvalStatus: 'approved',
                provenance: 'test'
            },
            expectedEntities: [
                {
                    canonicalId: { package: 'pkg', logicalNamespace: 'ns', kind: 'class', qualifiedName: 'entity1', signatureHash: 'hash1' , identityOrigin: 'Synthetic', identityAuthority: 'compiler'},
                    name: 'entity1',
                    entityKind: 'class',
                    declarationLocation: { filePath: 'test.ts', startLine: 1, endLine: 2 },
                    modifiers: [],
                    visibility: 'public'

                }
            ],
            expectedRelationships: [],
            expectedUnknowns: []
        };
        
        const candidate: EvaluationCandidate = {
            identifier: 'candidate-1',
            source: 'test',
            result: {
                status: 'SUCCESS',
                providerMetadata: { providerName: 'test', providerVersion: '1', extractionMethod: 'compiler', extractionTimestampMs: 0 },
                diagnostics: [],
                entities: [
                    {
                    canonicalId: { package: 'pkg', logicalNamespace: 'ns', kind: 'class', qualifiedName: 'entity1', signatureHash: 'hash1' , identityOrigin: 'Synthetic', identityAuthority: 'compiler'},
                    name: 'entity1',
                    entityKind: 'class',
                    declarationLocation: { filePath: 'test.ts', startLine: 1, endLine: 2 },
                    modifiers: [],
                    visibility: 'public'
                    },
                    {
                    canonicalId: { package: 'pkg', logicalNamespace: 'ns', kind: 'class', qualifiedName: 'entity2', signatureHash: 'hash2' , identityOrigin: 'Synthetic', identityAuthority: 'compiler'},
                    name: 'entity2',
                    entityKind: 'class',
                    declarationLocation: { filePath: 'test.ts', startLine: 3, endLine: 4 },
                    modifiers: [],
                    visibility: 'public'
                    }
                ],
                relationships: [],
                knownUnknowns: [],
                metrics: { durationMs: 0, filesProcessed: 0, entitiesExtracted: 0, relationshipsExtracted: 0, unknownsFound: 0 }
            }
        };

        const result = engine.evaluate(candidate, truth, strategy);
        
        // 1 True Positive, 1 False Positive, 0 False Negatives
        // Precision = TP / (TP + FP) = 1 / 2 = 0.5
        // Recall = TP / (TP + FN) = 1 / 1 = 1.0
        assert.strictEqual(result.providerQuality.precision, 0.5);
        assert.strictEqual(result.providerQuality.recall, 1.0);
        assert.strictEqual(result.providerQuality.falsePositives, 1);
        assert.strictEqual(result.providerQuality.falseNegatives, 0);
        
        // Check findings
        assert.strictEqual(result.findings.length, 1);
        assert.strictEqual(result.findings[0].category, 'Extraction Error');
        assert.ok(result.findings[0].recommendation.includes('entity2'));
    });
});
