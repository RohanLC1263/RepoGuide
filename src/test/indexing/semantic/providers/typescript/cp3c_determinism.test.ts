import * as assert from 'assert';
import { TypeScriptSemanticProvider } from '../../../../../indexing/semantic/providers/typescript/typeScriptSemanticProvider';
import { DefaultProgramProvider } from '../../../../../indexing/semantic/providers/typescript/programProvider';
import { ProgramHandle } from '../../../../../indexing/semantic/providers/typescript/internalModels';
import { SymbolResolver } from '../../../../../indexing/semantic/providers/typescript/resolution/symbolResolver';
import { IdentityDescriptorBuilder } from '../../../../../indexing/semantic/providers/typescript/resolution/identityDescriptorBuilder';
import { CanonicalIdentityFactory } from '../../../../../indexing/semantic/providers/typescript/resolution/canonicalIdentityFactory';
import * as ts from 'typescript';

describe('CP3C Determinism Tests', () => {
    const sourceCode = `
        export class TestClass {
            public methodA(): void {}
        }
        export const myVar = 42;
        export function myFunc() {}
        export interface ITest { field: string; }
        export type MyAlias = string;
        export enum MyEnum { A, B }
    `;

    it('Cache Permutation: Warm vs Cold cache execution should yield identical CanonicalSymbolIdentity', async () => {
        const provider1 = new TypeScriptSemanticProvider();
        const resultCold = await provider1.extract('test.ts', sourceCode);
        
        const programProvider = new DefaultProgramProvider();
        let handle: ProgramHandle | undefined;
        
        const warmProvider = new TypeScriptSemanticProvider({
            getProgramHandle: (fp: string, content: string) => {
                if (!handle) {
                    handle = programProvider.getProgramHandle(fp, content);
                }
                return handle;
            }
        });

        await warmProvider.extract('test.ts', sourceCode);
        const resultWarm = await warmProvider.extract('test.ts', sourceCode);

        assert.strictEqual(resultCold.entities.length, resultWarm.entities.length);
        
        for (let i = 0; i < resultCold.entities.length; i++) {
            const coldId = resultCold.entities[i].canonicalId;
            const warmId = resultWarm.entities[i].canonicalId;
            assert.deepStrictEqual(coldId, warmId);
        }
    });

    it('Traversal Permutation: Randomized AST node visitation should yield identical CanonicalSymbolIdentity', () => {
        const programProvider = new DefaultProgramProvider();
        const handle1 = programProvider.getProgramHandle('test.ts', sourceCode);
        const handle2 = programProvider.getProgramHandle('test.ts', sourceCode);

        const decls1: ts.Declaration[] = [];
        ts.forEachChild(handle1.sourceFile, n => {
            if (ts.isClassDeclaration(n) || ts.isVariableStatement(n) || ts.isFunctionDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n)) {
                if (ts.isVariableStatement(n)) {
                    decls1.push(n.declarationList.declarations[0]);
                } else {
                    decls1.push(n as ts.Declaration);
                }
            }
        });

        const decls2: ts.Declaration[] = [];
        ts.forEachChild(handle2.sourceFile, n => {
            if (ts.isClassDeclaration(n) || ts.isVariableStatement(n) || ts.isFunctionDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n)) {
                if (ts.isVariableStatement(n)) {
                    decls2.push(n.declarationList.declarations[0]);
                } else {
                    decls2.push(n as ts.Declaration);
                }
            }
        });

        // 1. Resolve sequentially
        const sequentialIds = decls1.map(d => {
            const resolved = SymbolResolver.resolve(d, handle1);
            const desc = IdentityDescriptorBuilder.build(resolved, handle1);
            return CanonicalIdentityFactory.create(desc);
        });

        // 2. Resolve scrambled
        const shuffledIndices = [5, 2, 0, 4, 1, 3];
        const scrambledIdsArray: any[] = [];
        
        for (const idx of shuffledIndices) {
            const d = decls2[idx];
            const resolved = SymbolResolver.resolve(d, handle2);
            const desc = IdentityDescriptorBuilder.build(resolved, handle2);
            scrambledIdsArray[idx] = CanonicalIdentityFactory.create(desc); // store in original index
        }

        assert.strictEqual(sequentialIds.length, scrambledIdsArray.length);
        for (let i = 0; i < sequentialIds.length; i++) {
            assert.deepStrictEqual(sequentialIds[i], scrambledIdsArray[i]);
        }
    });

    it('Cache Invalidation: Repeated extraction after cache clearing should yield identical output', async () => {
        const programProvider = new DefaultProgramProvider();
        let handle: ProgramHandle | undefined;
        
        const provider = new TypeScriptSemanticProvider({
            getProgramHandle: (fp: string, content: string) => {
                if (!handle) {
                    handle = programProvider.getProgramHandle(fp, content);
                } else if (handle.resolutionCache) {
                    handle.resolutionCache.clear(); // Simulate invalidation
                }
                return handle;
            }
        });

        const resultA = await provider.extract('test.ts', sourceCode);
        const resultB = await provider.extract('test.ts', sourceCode);

        assert.deepStrictEqual(resultA.entities, resultB.entities);
    });
});
