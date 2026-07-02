import * as assert from 'assert';
import { TypeScriptSemanticProvider } from '../../../../../indexing/semantic/providers/typescript/typeScriptSemanticProvider';
import { DefaultProgramProvider } from '../../../../../indexing/semantic/providers/typescript/programProvider';

describe('CP3D Golden Fixtures', () => {
    let provider: TypeScriptSemanticProvider;

    beforeEach(() => {
        provider = new TypeScriptSemanticProvider(new DefaultProgramProvider());
    });

    it('extracts CALLS relationship', async () => {
        const content = `
            function target() {}
            function source() {
                target();
            }
        `;
        const result = await provider.extract('test.ts', content);
        
        assert.strictEqual(result.status, 'SUCCESS');
        
        const calls = result.relationships.filter((r: any) => r.relationshipKind === 'CALLS');
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].source.qualifiedName, 'source');
        assert.strictEqual(calls[0].target.qualifiedName, 'target');
        assert.strictEqual(calls[0].category, 'semantic');
        assert.strictEqual(calls[0].evidence.length, 1);
        assert.ok(calls[0].evidence[0].location && calls[0].evidence[0].location.startLine > 0);
    });

    it('extracts IMPORTS relationship', async () => {
        const content = `
            import { something } from './module';
            something();
        `;
        const result = await provider.extract('test.ts', content);
        
        assert.strictEqual(result.status, 'SUCCESS');
        
        const imports = result.relationships.filter((r: any) => r.relationshipKind === 'IMPORTS');
        assert.strictEqual(imports.length, 0); 
        
        const unknowns = result.knownUnknowns;
        assert.ok(unknowns.length > 0);
        assert.ok(unknowns.some((u: any) => u.unsupportedConstruct === 'Unresolved Import'));
    });

    it('extracts import = require() relationship', async () => {
        const content = `
            import something = require('./module');
            something();
        `;
        const result = await provider.extract('test.ts', content);
        
        assert.strictEqual(result.status, 'SUCCESS');
        
        const imports = result.relationships.filter((r: any) => r.relationshipKind === 'IMPORTS');
        assert.strictEqual(imports.length, 0); 
        
        const unknowns = result.knownUnknowns;
        assert.ok(unknowns.length > 0);
        assert.ok(unknowns.some((u: any) => u.unsupportedConstruct === 'Unresolved Import'));
    });

    it('extracts EXTENDS and IMPLEMENTS relationship', async () => {
        const content = `
            interface Base {}
            class Derived extends Base implements Base {}
        `;
        const result = await provider.extract('test.ts', content);
        
        assert.strictEqual(result.status, 'SUCCESS');
        
        const extendsRels = result.relationships.filter((r: any) => r.relationshipKind === 'EXTENDS');
        assert.strictEqual(extendsRels.length, 1);
        assert.strictEqual(extendsRels[0].source.qualifiedName, 'Derived');
        assert.strictEqual(extendsRels[0].target.qualifiedName, 'Base');

        const implementsRels = result.relationships.filter((r: any) => r.relationshipKind === 'IMPLEMENTS');
        assert.strictEqual(implementsRels.length, 1);
        assert.strictEqual(implementsRels[0].source.qualifiedName, 'Derived');
        assert.strictEqual(implementsRels[0].target.qualifiedName, 'Base');
    });

    it('extracts DECLARES relationship', async () => {
        const content = `
            class Container {
                member() {}
            }
        `;
        const result = await provider.extract('test.ts', content);
        
        assert.strictEqual(result.status, 'SUCCESS');
        
        const declares = result.relationships.filter((r: any) => r.relationshipKind === 'DECLARES');
        assert.strictEqual(declares.length, 1);
        assert.strictEqual(declares[0].source.qualifiedName, 'Container');
        assert.strictEqual(declares[0].target.qualifiedName, 'member');
        assert.strictEqual(declares[0].category, 'structural');
    });

    it('extracts INSTANTIATES relationship', async () => {
        const content = `
            class Target {}
            function source() {
                new Target();
            }
        `;
        const result = await provider.extract('test.ts', content);
        
        assert.strictEqual(result.status, 'SUCCESS');
        
        const instantiates = result.relationships.filter((r: any) => r.relationshipKind === 'INSTANTIATES');
        assert.strictEqual(instantiates.length, 1);
        assert.strictEqual(instantiates[0].source.qualifiedName, 'source');
        assert.strictEqual(instantiates[0].target.qualifiedName, 'Target');
    });

    it('dynamic dispatch drops to KnownUnknown and NEVER emits fake identity', async () => {
        const content = `
            function source(a: any) {
                a.dynamicMethod();
            }
        `;
        const result = await provider.extract('test.ts', content);
        
        assert.strictEqual(result.status, 'SUCCESS');
        
        const calls = result.relationships.filter((r: any) => r.relationshipKind === 'CALLS');
        assert.strictEqual(calls.length, 0); 

        const unknowns = result.knownUnknowns;
        assert.ok(unknowns.length > 0);
        assert.ok(unknowns.some((u: any) => u.unsupportedConstruct === 'Dynamic Dispatch'));
    });
});
