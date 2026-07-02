import { suite, test } from 'mocha';
import * as assert from 'assert';
import { TypeScriptSemanticProvider } from '../../../../../indexing/semantic/providers/typescript/typeScriptSemanticProvider';
import { DefaultProgramProvider } from '../../../../../indexing/semantic/providers/typescript/programProvider';
import { EvaluationEngine } from '../../../../../indexing/semantic/evaluation/evaluationEngine';
import { ExactMatchComparisonStrategy } from '../../../../../indexing/semantic/evaluation/exactMatchComparisonStrategy';
import { GroundTruth, EvaluationCandidate } from '../../../../../indexing/semantic/evaluation/evaluationModels';
import { SemanticExtractionResult } from '../../../../../indexing/semantic/semanticProviderContract';

suite('TypeScriptSemanticProvider - Golden Fixtures', () => {
    test('Basic declarations are successfully extracted', async () => {
        const sourceCode = `
            /** My class */
            export class TestClass {
                public myMethod() {}
                private myPrivateProp = 1; // Not a declaration for method/function, but it's a property. Not in entityKind though?
            }
            
            export interface ITest {}
            const myVar = 42;
            function doStuff() {
                const innerVar = 1; // Forbidden
            }
            type MyType = string;
            enum MyEnum { A }
            namespace MyNamespace {}
        `;

        const provider = new TypeScriptSemanticProvider(new DefaultProgramProvider());
        const result = await provider.extract('test.ts', sourceCode);
        
        // Assert we have no errors
        assert.strictEqual(result.diagnostics.length, 0);

        const groundTruth: GroundTruth = {
            id: 'basic',
            version: '1',
            description: 'Tests basic TS declarations',
            metadata: { source: 'manual', creationMethod: 'test', approvalStatus: 'approved', provenance: 'test' },
            expectedEntities: [
                { canonicalId: { package: '', logicalNamespace: '', kind: 'class', qualifiedName: 'TestClass', signatureHash: '', identityOrigin: 'Synthetic', identityAuthority: 'compiler' }, name: 'TestClass', entityKind: 'class', declarationLocation: { filePath: 'test.ts', startLine: 3, endLine: 6 }, modifiers: ['export'], visibility: 'public' },
                { canonicalId: { package: '', logicalNamespace: '', kind: 'method', qualifiedName: 'myMethod', signatureHash: '', identityOrigin: 'Synthetic', identityAuthority: 'compiler' }, name: 'myMethod', entityKind: 'method', declarationLocation: { filePath: 'test.ts', startLine: 4, endLine: 4 }, modifiers: [], visibility: 'public' },
                { canonicalId: { package: '', logicalNamespace: '', kind: 'interface', qualifiedName: 'ITest', signatureHash: '', identityOrigin: 'Synthetic', identityAuthority: 'compiler' }, name: 'ITest', entityKind: 'interface', declarationLocation: { filePath: 'test.ts', startLine: 8, endLine: 8 }, modifiers: ['export'], visibility: 'public' },
                { canonicalId: { package: '', logicalNamespace: '', kind: 'variable', qualifiedName: 'myVar', signatureHash: '', identityOrigin: 'Synthetic', identityAuthority: 'compiler' }, name: 'myVar', entityKind: 'variable', declarationLocation: { filePath: 'test.ts', startLine: 9, endLine: 9 }, modifiers: [], visibility: 'public' }, // wait, myVar is variable declaration. But we only care about top level.
                { canonicalId: { package: '', logicalNamespace: '', kind: 'function', qualifiedName: 'doStuff', signatureHash: '', identityOrigin: 'Synthetic', identityAuthority: 'compiler' }, name: 'doStuff', entityKind: 'function', declarationLocation: { filePath: 'test.ts', startLine: 10, endLine: 12 }, modifiers: [], visibility: 'public' },
                { canonicalId: { package: '', logicalNamespace: '', kind: 'type_alias', qualifiedName: 'MyType', signatureHash: '', identityOrigin: 'Synthetic', identityAuthority: 'compiler' }, name: 'MyType', entityKind: 'type_alias', declarationLocation: { filePath: 'test.ts', startLine: 13, endLine: 13 }, modifiers: [], visibility: 'public' },
                { canonicalId: { package: '', logicalNamespace: '', kind: 'enum', qualifiedName: 'MyEnum', signatureHash: '', identityOrigin: 'Synthetic', identityAuthority: 'compiler' }, name: 'MyEnum', entityKind: 'enum', declarationLocation: { filePath: 'test.ts', startLine: 14, endLine: 14 }, modifiers: [], visibility: 'public' },
                { canonicalId: { package: '', logicalNamespace: '', kind: 'namespace', qualifiedName: 'MyNamespace', signatureHash: '', identityOrigin: 'Synthetic', identityAuthority: 'compiler' }, name: 'MyNamespace', entityKind: 'namespace', declarationLocation: { filePath: 'test.ts', startLine: 15, endLine: 15 }, modifiers: [], visibility: 'public' }
            ],
            expectedRelationships: [],
            expectedUnknowns: []
        };

        const engine = new EvaluationEngine();
        const evalResult = engine.evaluate({
            identifier: 'ts-provider',
            source: 'test',
            result
        }, groundTruth, new ExactMatchComparisonStrategy());

        // It shouldn't have extracted `innerVar` or `myPrivateProp` (if property is not supported)
        const innerVarExtracted = result.entities.some((e: any) => e.name === 'innerVar');
        assert.strictEqual(innerVarExtracted, false, 'Should not extract block-scoped internal variables');

        // Check if there are any false positives or false negatives
        const falsePositives = evalResult.providerQuality.falsePositives;
        const falseNegatives = evalResult.providerQuality.falseNegatives;

        assert.strictEqual(falsePositives, 0, `False positives found: \n${JSON.stringify(evalResult.findings.filter((f: any) => f.severity === 'warning'), null, 2)}`);
        assert.strictEqual(falseNegatives, 0, `False negatives found: \n${JSON.stringify(evalResult.findings.filter((f: any) => f.severity === 'critical'), null, 2)}`);
    });
});
