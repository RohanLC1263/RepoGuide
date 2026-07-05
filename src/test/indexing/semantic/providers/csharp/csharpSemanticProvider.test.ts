import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { CSharpSemanticProvider } from '../../../../../indexing/semantic/providers/csharp/csharpSemanticProvider';
import { ExtractionDispatcher } from '../../../../../indexing/semantic/extractionDispatcher';
import { TypeScriptSemanticProvider } from '../../../../../indexing/semantic/providers/typescript/typeScriptSemanticProvider';

describe('CSharpSemanticProvider', () => {
    test('canHandle only matches .cs files', () => {
        const provider = new CSharpSemanticProvider();
        expect(provider.canHandle('Foo.cs')).toBe(true);
        expect(provider.canHandle('Foo.java')).toBe(false);
        expect(provider.canHandle('Foo.csx')).toBe(false);
    });

    describe('dispatcher registration', () => {
        test('routes .cs files to CSharpSemanticProvider and .ts files to TypeScriptSemanticProvider', async () => {
            const dispatcher = new ExtractionDispatcher();
            dispatcher.registerProvider(new TypeScriptSemanticProvider());
            dispatcher.registerProvider(new CSharpSemanticProvider());

            expect(dispatcher.canHandle('Foo.cs')).toBe(true);
            expect(dispatcher.canHandle('Foo.ts')).toBe(true);
            expect(dispatcher.canHandle('Foo.rs')).toBe(false);

            const csResult = await dispatcher.extract('Foo.cs', 'class Foo {}');
            expect(csResult?.providerMetadata.providerName).toBe('csharp-semantic-provider');

            const tsResult = await dispatcher.extract('Foo.ts', 'const x = 1;');
            expect(tsResult?.providerMetadata.providerName).toBe('typescript-semantic-provider');
        });
    });

    describe('golden fixture: real multi-file namespace on disk', () => {
        let tempDir: string;
        const provider = new CSharpSemanticProvider();

        beforeAll(() => {
            fs.mkdirSync(tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csharp-semantic-provider-')), { recursive: true });
            fs.mkdirSync(path.join(tempDir, 'RestLike', 'Utils'), { recursive: true });
            fs.writeFileSync(path.join(tempDir, 'RestLike', 'Utils', 'Helper.cs'), [
                'namespace RestLike.Utils;',
                '',
                'public class Helper {}',
                ''
            ].join('\n'));
            fs.writeFileSync(path.join(tempDir, 'RestLike', 'Program.cs'), [
                'namespace RestLike;',
                '',
                'using RestLike.Utils;', // real-world usings target a namespace (directory), not a specific type
                '',
                'public interface IGreeter {',
                '    void Greet();',
                '}',
                '',
                'public class Animal {',
                '    public void Speak() {}',
                '}',
                '',
                '/// <summary>',
                '/// A good boy.',
                '/// </summary>',
                'public class Dog : Animal, IGreeter, IDisposable {',
                '    private string _name;',
                '',
                '    public void Bark() {',
                '        Wag();',
                '    }',
                '',
                '    public void Wag() {}',
                '',
                '    public void Greet() {}',
                '',
                '    public void Dispose() {}',
                '',
                '    public void MakeInstance() {',
                '        var d = new Dog();',
                '    }',
                '',
                '    public void Process(int x) {}',
                '    public void Process(string x) {}',
                '}',
                ''
            ].join('\n'));
        });

        afterAll(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        function extractProgram() {
            const filePath = path.join(tempDir, 'RestLike', 'Program.cs');
            const content = fs.readFileSync(filePath, 'utf8');
            return provider.extract(filePath, content, tempDir);
        }

        test('extracts structural entities with correct kinds, nesting, and XML doc', async () => {
            const result = await extractProgram();
            expect(result.status).toBe('SUCCESS');
            expect(result.diagnostics).toEqual([]);

            const byQualifiedName = new Map(result.entities.map(e => [e.canonicalId.qualifiedName, e]));

            const moduleEntity = result.entities.find(e => e.entityKind === 'module');
            expect(moduleEntity).toBeDefined();
            expect(moduleEntity!.canonicalId.logicalNamespace).toBe('RestLike');

            const dogEntity = byQualifiedName.get('Dog');
            expect(dogEntity).toBeDefined();
            expect(dogEntity!.entityKind).toBe('class');
            expect(dogEntity!.documentation).toBe('A good boy.');

            const nameField = byQualifiedName.get('Dog._name');
            expect(nameField).toBeDefined();
            expect(nameField!.entityKind).toBe('variable');
            expect(nameField!.visibility).toBe('private');

            const bark = byQualifiedName.get('Dog.Bark');
            expect(bark).toBeDefined();
            expect(bark!.entityKind).toBe('method');

            const greeterEntity = byQualifiedName.get('IGreeter');
            expect(greeterEntity).toBeDefined();
            expect(greeterEntity!.entityKind).toBe('interface');
        });

        test('resolves a namespace-shaped using directive (the real-world common case) to the real target directory on disk', async () => {
            const result = await extractProgram();
            const imports = result.relationships.filter(r => r.relationshipKind === 'IMPORTS');
            expect(imports.length).toBe(1);
            expect(imports[0].source.logicalNamespace).toBe('RestLike');
            expect(imports[0].target.logicalNamespace).toBe('RestLike.Utils');
            expect(imports[0].evidence[0].type).toBe('ast');
        });

        test('classifies same-file base-list entries as EXTENDS (class) vs IMPLEMENTS (interface), and flags the unresolved BCL interface generically', async () => {
            const result = await extractProgram();

            const extendsRels = result.relationships.filter(r => r.relationshipKind === 'EXTENDS');
            expect(extendsRels.length).toBe(1);
            expect(extendsRels[0].source.qualifiedName).toBe('Dog');
            expect(extendsRels[0].target.qualifiedName).toBe('Animal');

            const implementsRels = result.relationships.filter(r => r.relationshipKind === 'IMPLEMENTS');
            expect(implementsRels.length).toBe(1);
            expect(implementsRels[0].source.qualifiedName).toBe('Dog');
            expect(implementsRels[0].target.qualifiedName).toBe('IGreeter');

            // IDisposable isn't declared in this file -- C#'s base_list syntax
            // gives no way to tell it apart from a base class without
            // resolving it, so it becomes one honestly generic KnownUnknown
            // rather than a guessed EXTENDS or IMPLEMENTS edge.
            const unresolvedBase = result.knownUnknowns.find(u => u.unsupportedConstruct === 'Base type or interface');
            expect(unresolvedBase).toBeDefined();
            expect(unresolvedBase!.reason).toContain('IDisposable');
        });

        test('resolves same-type CALLS (heuristic evidence) and unambiguous same-file INSTANTIATES (ast evidence)', async () => {
            const result = await extractProgram();

            const calls = result.relationships.filter(r => r.relationshipKind === 'CALLS');
            expect(calls.length).toBe(1);
            expect(calls[0].source.qualifiedName).toBe('Dog.Bark');
            expect(calls[0].target.qualifiedName).toBe('Dog.Wag');
            expect(calls[0].evidence[0].type).toBe('heuristic');

            const instantiates = result.relationships.filter(r => r.relationshipKind === 'INSTANTIATES');
            expect(instantiates.length).toBe(1);
            expect(instantiates[0].source.qualifiedName).toBe('Dog.MakeInstance');
            expect(instantiates[0].target.qualifiedName).toBe('Dog');
            expect(instantiates[0].evidence[0].type).toBe('ast');
        });

        test('gives overloaded methods distinct CanonicalSymbolIdentity values (same qualifiedName, different signatureHash)', async () => {
            const result = await extractProgram();
            const overloads = result.entities.filter(e => e.canonicalId.qualifiedName === 'Dog.Process');
            expect(overloads.length).toBe(2);
            expect(overloads[0].canonicalId.signatureHash).not.toBe(overloads[1].canonicalId.signatureHash);
        });

        test('emits DECLARES from the synthetic module entity to each top-level member', async () => {
            const result = await extractProgram();
            const moduleDeclares = result.relationships.filter(r => r.relationshipKind === 'DECLARES' && r.source.qualifiedName === '');
            expect(moduleDeclares.map(r => r.target.qualifiedName).sort()).toEqual(['Animal', 'Dog', 'IGreeter'].sort());
        });
    });

    describe('local functions and method-body locals', () => {
        test('does not extract local functions or local variables as named declarations', async () => {
            const provider = new CSharpSemanticProvider();
            const source = [
                'namespace RestLike;',
                '',
                'public class Holder {',
                '    public void UseLocalFunction() {',
                '        int Local(int x) => x + 1;',
                '        var y = Local(1);',
                '    }',
                '}',
                ''
            ].join('\n');

            const result = await provider.extract('/workspace/RestLike/Holder.cs', source, '/workspace');
            expect(result.status).toBe('SUCCESS');

            const names = result.entities.map(e => e.canonicalId.qualifiedName);
            expect(names).not.toContain('Local');
            expect(names).not.toContain('Holder.Local');
            expect(names).not.toContain('y');

            const holder = result.entities.find(e => e.canonicalId.qualifiedName === 'Holder');
            expect(holder).toBeDefined();
        });
    });

    describe('this(...) constructor delegation', () => {
        test('recognizes this(...) delegation but does not resolve it when the constructor name is ambiguous (2+ constructors -- the only real case this(...) appears in)', async () => {
            const provider = new CSharpSemanticProvider();
            const source = [
                'namespace RestLike;',
                '',
                'public class Point {',
                '    private readonly int _x;',
                '    private readonly int _y;',
                '',
                '    public Point(int x, int y) {',
                '        _x = x;',
                '        _y = y;',
                '    }',
                '',
                '    public Point(int x) : this(x, 0) {',
                '    }',
                '}',
                ''
            ].join('\n');

            const result = await provider.extract('/workspace/RestLike/Point.cs', source, '/workspace');
            expect(result.status).toBe('SUCCESS');
            expect(result.diagnostics).toEqual([]);
            expect(result.relationships.filter(r => r.relationshipKind === 'CALLS')).toEqual([]);
        });
    });
});
