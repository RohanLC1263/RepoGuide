import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { GoSemanticProvider } from '../../../../../indexing/semantic/providers/go/goSemanticProvider';
import { ExtractionDispatcher } from '../../../../../indexing/semantic/extractionDispatcher';
import { TypeScriptSemanticProvider } from '../../../../../indexing/semantic/providers/typescript/typeScriptSemanticProvider';

describe('GoSemanticProvider', () => {
    test('canHandle only matches .go files', () => {
        const provider = new GoSemanticProvider();
        expect(provider.canHandle('foo.go')).toBe(true);
        expect(provider.canHandle('foo.ts')).toBe(false);
        expect(provider.canHandle('foo.gob')).toBe(false);
    });

    describe('dispatcher registration', () => {
        test('routes .go files to GoSemanticProvider and .ts files to TypeScriptSemanticProvider', async () => {
            const dispatcher = new ExtractionDispatcher();
            dispatcher.registerProvider(new TypeScriptSemanticProvider());
            dispatcher.registerProvider(new GoSemanticProvider());

            expect(dispatcher.canHandle('foo.go')).toBe(true);
            expect(dispatcher.canHandle('foo.ts')).toBe(true);
            expect(dispatcher.canHandle('foo.rs')).toBe(false);

            const goResult = await dispatcher.extract('foo.go', 'package foo');
            expect(goResult?.providerMetadata.providerName).toBe('go-semantic-provider');

            const tsResult = await dispatcher.extract('foo.ts', 'const x = 1;');
            expect(tsResult?.providerMetadata.providerName).toBe('typescript-semantic-provider');
        });
    });

    describe('golden fixture: real go.mod-based module on disk', () => {
        let tempDir: string;
        const provider = new GoSemanticProvider();

        beforeAll(() => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-semantic-provider-'));
            fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module example.com/petshop\n\ngo 1.21\n');
            fs.mkdirSync(path.join(tempDir, 'utils'), { recursive: true });
            fs.writeFileSync(path.join(tempDir, 'utils', 'helper.go'), [
                'package utils',
                '',
                'func Helper() string {',
                '\treturn "help"',
                '}',
                ''
            ].join('\n'));
            fs.mkdirSync(path.join(tempDir, 'pet'), { recursive: true });
            fs.writeFileSync(path.join(tempDir, 'pet', 'dog.go'), [
                'package pet',
                '',
                'import (',
                '\t"io"',
                '\t"example.com/petshop/utils"',
                ')',
                '',
                '// Animal is a living thing.',
                'type Animal struct {',
                '\tName string',
                '}',
                '',
                '// Speak makes the animal speak.',
                'func (a *Animal) Speak() string {',
                '\treturn "..."',
                '}',
                '',
                '// Dog is a domesticated animal.',
                'type Dog struct {',
                '\tAnimal',
                '\tio.Reader',
                '\tBreed string',
                '}',
                '',
                'func (d *Dog) Bark() string {',
                '\treturn d.growl()',
                '}',
                '',
                'func (d *Dog) growl() string {',
                '\treturn "grr"',
                '}',
                '',
                'func (d *Dog) SpeakViaEmbedding() string {',
                '\treturn d.Speak()',
                '}',
                '',
                'func NewDog() *Dog {',
                '\treturn &Dog{}',
                '}',
                '',
                'func (d *Dog) MakeAnother() *Dog {',
                '\tx := utils.Helper()',
                '\t_ = x',
                '\treturn &Dog{}',
                '}',
                ''
            ].join('\n'));
        });

        afterAll(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        function extractDog() {
            const filePath = path.join(tempDir, 'pet', 'dog.go');
            const content = fs.readFileSync(filePath, 'utf8');
            return provider.extract(filePath, content, tempDir);
        }

        test('extracts structural entities with correct kinds and doc comments, using the go.mod-derived import path as identity', async () => {
            const result = await extractDog();
            expect(result.status).toBe('SUCCESS');
            expect(result.diagnostics).toEqual([]);

            const byQualifiedName = new Map(result.entities.map(e => [e.canonicalId.qualifiedName, e]));

            const moduleEntity = result.entities.find(e => e.entityKind === 'module');
            expect(moduleEntity).toBeDefined();
            expect(moduleEntity!.canonicalId.logicalNamespace).toBe('example.com/petshop/pet');

            const dogEntity = byQualifiedName.get('Dog');
            expect(dogEntity).toBeDefined();
            expect(dogEntity!.entityKind).toBe('class');
            expect(dogEntity!.documentation).toBe('Dog is a domesticated animal.');

            const bark = byQualifiedName.get('Dog.Bark');
            expect(bark).toBeDefined();
            expect(bark!.entityKind).toBe('method');

            const newDog = byQualifiedName.get('NewDog');
            expect(newDog).toBeDefined();
            expect(newDog!.entityKind).toBe('function');
        });

        test('resolves an import to the real target package directory via the go.mod module path, and flags the stdlib import as unresolved', async () => {
            const result = await extractDog();
            const imports = result.relationships.filter(r => r.relationshipKind === 'IMPORTS');
            expect(imports.length).toBe(1);
            expect(imports[0].source.logicalNamespace).toBe('example.com/petshop/pet');
            expect(imports[0].target.logicalNamespace).toBe('example.com/petshop/utils');
            expect(imports[0].evidence[0].type).toBe('ast');

            const unresolvedImport = result.knownUnknowns.find(u => u.unsupportedConstruct === 'Unresolved Import');
            expect(unresolvedImport).toBeDefined();
            expect(unresolvedImport!.reason).toContain('io');
        });

        test('classifies same-file struct embedding as EXTENDS, and flags the cross-package embedded interface as an unresolved KnownUnknown', async () => {
            const result = await extractDog();

            const extendsRels = result.relationships.filter(r => r.relationshipKind === 'EXTENDS');
            expect(extendsRels.length).toBe(1);
            expect(extendsRels[0].source.qualifiedName).toBe('Dog');
            expect(extendsRels[0].target.qualifiedName).toBe('Animal');

            const unresolvedEmbed = result.knownUnknowns.find(u => u.unsupportedConstruct === 'Embedded type');
            expect(unresolvedEmbed).toBeDefined();
            expect(unresolvedEmbed!.reason).toContain('io.Reader');
        });

        test('never emits an IMPLEMENTS relationship -- explicit non-goal for Go', async () => {
            const result = await extractDog();
            expect(result.relationships.filter(r => r.relationshipKind === ('IMPLEMENTS' as any))).toEqual([]);
        });

        test('resolves same-struct CALLS (heuristic evidence) via receiver-variable matching, but does not resolve a call to a promoted (embedded) method', async () => {
            const result = await extractDog();

            const calls = result.relationships.filter(r => r.relationshipKind === 'CALLS');
            expect(calls.length).toBe(1);
            expect(calls[0].source.qualifiedName).toBe('Dog.Bark');
            expect(calls[0].target.qualifiedName).toBe('Dog.growl');
            expect(calls[0].evidence[0].type).toBe('heuristic');

            // d.Speak() in SpeakViaEmbedding calls a method promoted from the
            // embedded Animal, not declared directly on Dog -- this provider
            // does not follow embedding-based method promotion, so it stays
            // silently unresolved (not a KnownUnknown, matching the
            // "unresolved lowercase calls aren't noise" tier), not a wrong guess.
            const speakCalls = calls.filter(c => c.target.qualifiedName === 'Animal.Speak');
            expect(speakCalls).toEqual([]);
        });

        test('resolves unambiguous same-file INSTANTIATES via composite_literal, filtered to named types only', async () => {
            const result = await extractDog();
            const instantiates = result.relationships.filter(r => r.relationshipKind === 'INSTANTIATES');
            expect(instantiates.length).toBe(2);
            for (const inst of instantiates) {
                expect(inst.target.qualifiedName).toBe('Dog');
                expect(inst.evidence[0].type).toBe('ast');
            }
            expect(instantiates.map(i => i.source.qualifiedName).sort()).toEqual(['Dog.MakeAnother', 'NewDog'].sort());
        });

        test('emits DECLARES from the synthetic module entity to package-level declarations, and from Dog to its own methods', async () => {
            const result = await extractDog();
            const moduleDeclares = result.relationships.filter(r => r.relationshipKind === 'DECLARES' && r.source.qualifiedName === '');
            expect(moduleDeclares.map(r => r.target.qualifiedName).sort()).toEqual(['Animal', 'Dog', 'NewDog'].sort());

            const dogDeclares = result.relationships.filter(r => r.relationshipKind === 'DECLARES' && r.source.qualifiedName === 'Dog');
            expect(dogDeclares.map(r => r.target.qualifiedName).sort()).toEqual(['Dog.Bark', 'Dog.MakeAnother', 'Dog.SpeakViaEmbedding', 'Dog.growl'].sort());
        });
    });

    describe('composite_literal type filtering', () => {
        test('does not treat slice/map/array literals as INSTANTIATES (unlike struct-shaped composite_literal, they share the same node type)', async () => {
            const provider = new GoSemanticProvider();
            const source = [
                'package foo',
                '',
                'type Widget struct{}',
                '',
                'func Build() {',
                '\ts := []int{1, 2, 3}',
                '\tm := map[string]int{"a": 1}',
                '\tw := Widget{}',
                '\t_ = s',
                '\t_ = m',
                '\t_ = w',
                '}',
                ''
            ].join('\n');

            const result = await provider.extract('/workspace/foo.go', source, '/workspace');
            expect(result.status).toBe('SUCCESS');

            const instantiates = result.relationships.filter(r => r.relationshipKind === 'INSTANTIATES');
            expect(instantiates.length).toBe(1);
            expect(instantiates[0].target.qualifiedName).toBe('Widget');
        });
    });
});
