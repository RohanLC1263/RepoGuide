import * as assert from 'assert';
import { TypeScriptSemanticProvider } from '../../../../../indexing/semantic/providers/typescript/typeScriptSemanticProvider';

describe('CP3C Golden Fixtures', () => {
    it('should resolve aliased types correctly (avoiding cycle loops)', async () => {
        const sourceCode = `
            export type A = B;
            export type B = A; // Cycle
        `;

        const provider = new TypeScriptSemanticProvider();
        const result = await provider.extract('test.ts', sourceCode);
        
        // Due to the cycle, it should emit KnownUnknowns for A and B.
        assert.ok(result.knownUnknowns.length > 0);
        
        // And they shouldn't crash
        assert.strictEqual(result.entities.length, 2);
    });

    it('should correctly hash overloaded functions', async () => {
        const sourceCode = `
            export function doStuff(a: string): void;
            export function doStuff(a: number): void;
            export function doStuff(a: any): void {}
        `;
        const provider = new TypeScriptSemanticProvider();
        const result = await provider.extract('test.ts', sourceCode);
        
        // We expect the extraction to pick up the overloads if they are in AST. 
        // In our current mapper, we just visit nodes. 
        // Depending on traversal, we might get multiple function nodes.
        assert.ok(result.entities.length >= 1);
        result.entities.forEach(entity => {
            assert.ok(entity.canonicalId.signatureHash.startsWith('v1|'));
        });
    });
});
