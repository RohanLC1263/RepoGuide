import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { PythonSemanticProvider } from '../../../../../indexing/semantic/providers/python/pythonSemanticProvider';
import { ExtractionDispatcher } from '../../../../../indexing/semantic/extractionDispatcher';
import { TypeScriptSemanticProvider } from '../../../../../indexing/semantic/providers/typescript/typeScriptSemanticProvider';
import { RepositoryRelationship } from '../../../../../indexing/semantic/semanticProviderContract';

describe('PythonSemanticProvider', () => {
    test('canHandle only matches .py files', () => {
        const provider = new PythonSemanticProvider();
        expect(provider.canHandle('foo.py')).toBe(true);
        expect(provider.canHandle('foo.ts')).toBe(false);
        expect(provider.canHandle('foo.pyi')).toBe(false);
    });

    describe('dispatcher registration', () => {
        test('routes .py files to PythonSemanticProvider and .ts files to TypeScriptSemanticProvider', async () => {
            const dispatcher = new ExtractionDispatcher();
            dispatcher.registerProvider(new TypeScriptSemanticProvider());
            dispatcher.registerProvider(new PythonSemanticProvider());

            expect(dispatcher.canHandle('module.py')).toBe(true);
            expect(dispatcher.canHandle('module.ts')).toBe(true);
            expect(dispatcher.canHandle('module.rs')).toBe(false);

            const pyResult = await dispatcher.extract('module.py', 'x = 1');
            expect(pyResult?.providerMetadata.providerName).toBe('python-semantic-provider');

            const tsResult = await dispatcher.extract('module.ts', 'const x = 1;');
            expect(tsResult?.providerMetadata.providerName).toBe('typescript-semantic-provider');
        });
    });

    describe('golden fixture: real multi-file package on disk', () => {
        let tempDir: string;
        const provider = new PythonSemanticProvider();

        beforeAll(() => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'py-semantic-provider-'));
            fs.mkdirSync(path.join(tempDir, 'pkg'));
            fs.writeFileSync(path.join(tempDir, 'pkg', '__init__.py'), '');
            fs.writeFileSync(path.join(tempDir, 'pkg', 'base.py'), [
                'class Animal:',
                '    def speak(self):',
                '        pass',
                ''
            ].join('\n'));
            fs.writeFileSync(path.join(tempDir, 'pkg', 'main.py'), [
                'from .base import Animal',
                '',
                '',
                'class Dog(Animal):',
                '    """A good boy."""',
                '',
                '    def bark(self):',
                '        return self.wag()',
                '',
                '    def wag(self):',
                '        return True',
                '',
                '',
                'def create_dog():',
                '    return Dog()',
                ''
            ].join('\n'));
        });

        afterAll(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        function extractMain() {
            const filePath = path.join(tempDir, 'pkg', 'main.py');
            const content = fs.readFileSync(filePath, 'utf8');
            return provider.extract(filePath, content, tempDir);
        }

        test('extracts structural entities with correct kinds, nesting, and docstring', async () => {
            const result = await extractMain();
            expect(result.status).toBe('SUCCESS');
            expect(result.diagnostics).toEqual([]);

            const byQualifiedName = new Map(result.entities.map(e => [e.canonicalId.qualifiedName, e]));

            const moduleEntity = result.entities.find(e => e.entityKind === 'module');
            expect(moduleEntity).toBeDefined();
            expect(moduleEntity!.canonicalId.logicalNamespace).toBe('pkg.main');

            const dogEntity = byQualifiedName.get('Dog');
            expect(dogEntity).toBeDefined();
            expect(dogEntity!.entityKind).toBe('class');
            expect(dogEntity!.documentation).toBe('A good boy.');

            const barkEntity = byQualifiedName.get('Dog.bark');
            expect(barkEntity).toBeDefined();
            expect(barkEntity!.entityKind).toBe('method');

            const wagEntity = byQualifiedName.get('Dog.wag');
            expect(wagEntity).toBeDefined();
            expect(wagEntity!.entityKind).toBe('method');

            const createDogEntity = byQualifiedName.get('create_dog');
            expect(createDogEntity).toBeDefined();
            expect(createDogEntity!.entityKind).toBe('function');
        });

        test('resolves a relative IMPORTS edge to the real target file on disk', async () => {
            const result = await extractMain();
            const imports = result.relationships.filter(r => r.relationshipKind === 'IMPORTS');
            expect(imports.length).toBe(1);
            expect(imports[0].source.logicalNamespace).toBe('pkg.main');
            expect(imports[0].target.logicalNamespace).toBe('pkg.base');
            expect(imports[0].evidence[0].type).toBe('ast');
        });

        test('flags the cross-file EXTENDS base class as a KnownUnknown rather than guessing', async () => {
            const result = await extractMain();
            const extendsRels = result.relationships.filter((r: RepositoryRelationship) => r.relationshipKind === 'EXTENDS');
            expect(extendsRels.length).toBe(0);

            const unresolvedBase = result.knownUnknowns.find(u => u.unsupportedConstruct === 'Base class');
            expect(unresolvedBase).toBeDefined();
            expect(unresolvedBase!.reason).toContain('Animal');
        });

        test('resolves same-class CALLS and same-file INSTANTIATES with heuristic evidence', async () => {
            const result = await extractMain();

            const calls = result.relationships.filter(r => r.relationshipKind === 'CALLS');
            expect(calls.length).toBe(1);
            expect(calls[0].source.qualifiedName).toBe('Dog.bark');
            expect(calls[0].target.qualifiedName).toBe('Dog.wag');
            expect(calls[0].evidence[0].type).toBe('heuristic');

            const instantiates = result.relationships.filter(r => r.relationshipKind === 'INSTANTIATES');
            expect(instantiates.length).toBe(1);
            expect(instantiates[0].source.qualifiedName).toBe('create_dog');
            expect(instantiates[0].target.qualifiedName).toBe('Dog');
        });

        test('emits a DECLARES edge from the synthetic module entity to each top-level definition', async () => {
            const result = await extractMain();
            const declares = result.relationships.filter(r => r.relationshipKind === 'DECLARES');

            const declaresQualifiedNames = declares.map(r => r.target.qualifiedName).sort();
            expect(declaresQualifiedNames).toEqual(['Dog', 'Dog.bark', 'Dog.wag', 'create_dog'].sort());

            const moduleDeclares = declares.filter(r => r.source.qualifiedName === '');
            expect(moduleDeclares.map(r => r.target.qualifiedName).sort()).toEqual(['Dog', 'create_dog'].sort());
        });
    });

    describe('async / decorated definitions', () => {
        test('treats an async def as a function and captures decorator-derived modifiers', async () => {
            const provider = new PythonSemanticProvider();
            const source = [
                'import functools',
                '',
                '',
                'class Service:',
                '    @staticmethod',
                '    async def fetch(url: str) -> str:',
                '        return url',
                ''
            ].join('\n');

            const result = await provider.extract('/workspace/service.py', source, '/workspace');
            expect(result.status).toBe('SUCCESS');

            const fetchEntity = result.entities.find(e => e.canonicalId.qualifiedName === 'Service.fetch');
            expect(fetchEntity).toBeDefined();
            expect(fetchEntity!.entityKind).toBe('method');
            expect(fetchEntity!.modifiers).toContain('async');
        });
    });
});
