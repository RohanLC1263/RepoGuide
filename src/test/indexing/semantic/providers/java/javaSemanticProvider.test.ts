import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { JavaSemanticProvider } from '../../../../../indexing/semantic/providers/java/javaSemanticProvider';
import { ExtractionDispatcher } from '../../../../../indexing/semantic/extractionDispatcher';
import { TypeScriptSemanticProvider } from '../../../../../indexing/semantic/providers/typescript/typeScriptSemanticProvider';

describe('JavaSemanticProvider', () => {
    test('canHandle only matches .java files', () => {
        const provider = new JavaSemanticProvider();
        expect(provider.canHandle('Foo.java')).toBe(true);
        expect(provider.canHandle('Foo.ts')).toBe(false);
        expect(provider.canHandle('Foo.class')).toBe(false);
    });

    describe('dispatcher registration', () => {
        test('routes .java files to JavaSemanticProvider and .ts files to TypeScriptSemanticProvider', async () => {
            const dispatcher = new ExtractionDispatcher();
            dispatcher.registerProvider(new TypeScriptSemanticProvider());
            dispatcher.registerProvider(new JavaSemanticProvider());

            expect(dispatcher.canHandle('Foo.java')).toBe(true);
            expect(dispatcher.canHandle('Foo.ts')).toBe(true);
            expect(dispatcher.canHandle('Foo.rs')).toBe(false);

            const javaResult = await dispatcher.extract('Foo.java', 'class Foo {}');
            expect(javaResult?.providerMetadata.providerName).toBe('java-semantic-provider');

            const tsResult = await dispatcher.extract('Foo.ts', 'const x = 1;');
            expect(tsResult?.providerMetadata.providerName).toBe('typescript-semantic-provider');
        });
    });

    describe('golden fixture: real multi-file package on disk', () => {
        let tempDir: string;
        const provider = new JavaSemanticProvider();

        beforeAll(() => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-semantic-provider-'));
            fs.mkdirSync(path.join(tempDir, 'com', 'example', 'base'), { recursive: true });
            fs.mkdirSync(path.join(tempDir, 'com', 'example', 'demo'), { recursive: true });
            fs.writeFileSync(path.join(tempDir, 'com', 'example', 'base', 'Animal.java'), [
                'package com.example.base;',
                '',
                'public class Animal {',
                '    public void speak() {}',
                '}',
                ''
            ].join('\n'));
            fs.writeFileSync(path.join(tempDir, 'com', 'example', 'demo', 'Dog.java'), [
                'package com.example.demo;',
                '',
                'import com.example.base.Animal;',
                '',
                '/**',
                ' * A good boy.',
                ' */',
                'public class Dog extends Animal implements Runnable {',
                '    private String name;',
                '',
                '    public void bark() {',
                '        wag();',
                '    }',
                '',
                '    public void wag() {',
                '        System.out.println("wag");',
                '    }',
                '',
                '    @Override',
                '    public void run() {',
                '        Dog d = new Dog();',
                '    }',
                '',
                '    public void process(int x) {}',
                '    public void process(String x) {}',
                '}',
                ''
            ].join('\n'));
        });

        afterAll(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        function extractDog() {
            const filePath = path.join(tempDir, 'com', 'example', 'demo', 'Dog.java');
            const content = fs.readFileSync(filePath, 'utf8');
            return provider.extract(filePath, content, tempDir);
        }

        test('extracts structural entities with correct kinds, nesting, and javadoc', async () => {
            const result = await extractDog();
            expect(result.status).toBe('SUCCESS');
            expect(result.diagnostics).toEqual([]);

            const byQualifiedName = new Map(result.entities.map(e => [e.canonicalId.qualifiedName, e]));

            const moduleEntity = result.entities.find(e => e.entityKind === 'module');
            expect(moduleEntity).toBeDefined();
            expect(moduleEntity!.canonicalId.logicalNamespace).toBe('com.example.demo');

            const dogEntity = byQualifiedName.get('Dog');
            expect(dogEntity).toBeDefined();
            expect(dogEntity!.entityKind).toBe('class');
            expect(dogEntity!.documentation).toBe('A good boy.');

            const nameField = byQualifiedName.get('Dog.name');
            expect(nameField).toBeDefined();
            expect(nameField!.entityKind).toBe('variable');
            expect(nameField!.visibility).toBe('private');

            const bark = byQualifiedName.get('Dog.bark');
            expect(bark).toBeDefined();
            expect(bark!.entityKind).toBe('method');
        });

        test('resolves an IMPORTS edge to the real target file on disk', async () => {
            const result = await extractDog();
            const imports = result.relationships.filter(r => r.relationshipKind === 'IMPORTS');
            expect(imports.length).toBe(1);
            expect(imports[0].source.logicalNamespace).toBe('com.example.demo');
            expect(imports[0].target.logicalNamespace).toBe('com.example.base');
            expect(imports[0].evidence[0].type).toBe('ast');
        });

        test('flags the cross-file EXTENDS and IMPLEMENTS targets as KnownUnknowns rather than guessing', async () => {
            const result = await extractDog();
            expect(result.relationships.filter(r => r.relationshipKind === 'EXTENDS').length).toBe(0);
            expect(result.relationships.filter(r => r.relationshipKind === 'IMPLEMENTS').length).toBe(0);

            const unresolvedBase = result.knownUnknowns.find(u => u.unsupportedConstruct === 'Base class');
            expect(unresolvedBase).toBeDefined();
            expect(unresolvedBase!.reason).toContain('Animal');

            const unresolvedInterface = result.knownUnknowns.find(u => u.unsupportedConstruct === 'Implemented interface');
            expect(unresolvedInterface).toBeDefined();
            expect(unresolvedInterface!.reason).toContain('Runnable');
        });

        test('resolves same-class CALLS (heuristic evidence) and unambiguous same-file INSTANTIATES (ast evidence)', async () => {
            const result = await extractDog();

            const calls = result.relationships.filter(r => r.relationshipKind === 'CALLS');
            expect(calls.length).toBe(1);
            expect(calls[0].source.qualifiedName).toBe('Dog.bark');
            expect(calls[0].target.qualifiedName).toBe('Dog.wag');
            expect(calls[0].evidence[0].type).toBe('heuristic');

            const instantiates = result.relationships.filter(r => r.relationshipKind === 'INSTANTIATES');
            expect(instantiates.length).toBe(1);
            expect(instantiates[0].source.qualifiedName).toBe('Dog.run');
            expect(instantiates[0].target.qualifiedName).toBe('Dog');
            expect(instantiates[0].evidence[0].type).toBe('ast');
        });

        test('gives overloaded methods distinct CanonicalSymbolIdentity values (same qualifiedName, different signatureHash)', async () => {
            const result = await extractDog();
            const overloads = result.entities.filter(e => e.canonicalId.qualifiedName === 'Dog.process');
            expect(overloads.length).toBe(2);
            expect(overloads[0].canonicalId.signatureHash).not.toBe(overloads[1].canonicalId.signatureHash);
        });

        test('emits DECLARES from the synthetic module entity to each top-level member', async () => {
            const result = await extractDog();
            const moduleDeclares = result.relationships.filter(r => r.relationshipKind === 'DECLARES' && r.source.qualifiedName === '');
            expect(moduleDeclares.map(r => r.target.qualifiedName)).toEqual(['Dog']);
        });
    });

    describe('anonymous and local class pruning', () => {
        test('does not extract anonymous class members or local classes as named declarations', async () => {
            const provider = new JavaSemanticProvider();
            const source = [
                'package com.example.demo;',
                '',
                'public class Holder {',
                '    Runnable r = new Runnable() {',
                '        @Override',
                '        public void run() {',
                '            int localInsideAnon = 1;',
                '        }',
                '    };',
                '',
                '    void useLocalClass() {',
                '        class LocalHelper {',
                '            void innerMethod() {}',
                '        }',
                '        LocalHelper h = new LocalHelper();',
                '    }',
                '}',
                ''
            ].join('\n');

            const result = await provider.extract('/workspace/com/example/demo/Holder.java', source, '/workspace');
            expect(result.status).toBe('SUCCESS');

            const names = result.entities.map(e => e.canonicalId.qualifiedName);
            expect(names).not.toContain('run');
            expect(names).not.toContain('LocalHelper');
            expect(names).not.toContain('LocalHelper.innerMethod');
            expect(names).not.toContain('Holder.LocalHelper');

            const holder = result.entities.find(e => e.canonicalId.qualifiedName === 'Holder');
            expect(holder).toBeDefined();
        });
    });

    describe('this(...) constructor delegation', () => {
        test('recognizes this(...) delegation but does not resolve it when the constructor name is ambiguous (2+ constructors -- the only real case this(...) appears in)', async () => {
            const provider = new JavaSemanticProvider();
            const source = [
                'package com.example.demo;',
                '',
                'public class Point {',
                '    private final int x;',
                '    private final int y;',
                '',
                '    public Point(int x, int y) {',
                '        this.x = x;',
                '        this.y = y;',
                '    }',
                '',
                '    public Point(int x) {',
                '        this(x, 0);',
                '    }',
                '}',
                ''
            ].join('\n');

            const result = await provider.extract('/workspace/com/example/demo/Point.java', source, '/workspace');
            expect(result.status).toBe('SUCCESS');
            expect(result.diagnostics).toEqual([]);

            // Constructor delegation via this(...) only ever occurs in a class
            // with 2+ constructors -- which means the target name ("Point") is
            // always ambiguous under a no-overload-resolution design. This
            // isn't a bug: it's the honest, tested consequence of not guessing
            // which overload this(...) meant. No CALLS edge and no KnownUnknown
            // noise either (matches the same "unresolved bare calls aren't
            // flagged" tier as regular method calls).
            expect(result.relationships.filter(r => r.relationshipKind === 'CALLS')).toEqual([]);
        });
    });
});
