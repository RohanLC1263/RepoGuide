import * as assert from 'assert';
import * as ts from 'typescript';
import { IdentityDescriptorBuilder } from '../../../../../../indexing/semantic/providers/typescript/resolution/identityDescriptorBuilder';
import { ResolvedSymbol, ProgramHandle } from '../../../../../../indexing/semantic/providers/typescript/internalModels';
import { DefaultProgramProvider } from '../../../../../../indexing/semantic/providers/typescript/programProvider';

describe('IdentityDescriptorBuilder', () => {
    it('should build a normalized descriptor without exposing TS compiler objects', () => {
        const sourceCode = `export class MyClass {}`;
        const provider = new DefaultProgramProvider();
        const handle = provider.getProgramHandle('test.ts', sourceCode);
        
        // Find the node for MyClass
        let myClassNode: ts.ClassDeclaration | undefined;
        ts.forEachChild(handle.sourceFile, node => {
            if (ts.isClassDeclaration(node) && node.name?.text === 'MyClass') {
                myClassNode = node;
            }
        });
        
        assert.ok(myClassNode);
        assert.ok(handle.typeChecker);
        
        const symbol = handle.typeChecker.getSymbolAtLocation(myClassNode.name!);
        assert.ok(symbol);
        
        const resolved: ResolvedSymbol = {
            symbol: symbol,
            origin: 'Repository'
        };
        
        const descriptor = IdentityDescriptorBuilder.build(resolved, handle);
        
        // Assert language-neutral properties
        assert.strictEqual(descriptor.symbolKind, 'class');
        assert.strictEqual(descriptor.qualifiedName, 'MyClass');
        assert.strictEqual(descriptor.identityOrigin, 'Repository');
        assert.strictEqual(descriptor.identityAuthority, 'compiler');
        assert.strictEqual(descriptor.logicalNamespace, 'test.ts');
        assert.strictEqual(descriptor.package, 'workspace');
        assert.ok(descriptor.signatureHash.startsWith('v1|'));
    });
});
