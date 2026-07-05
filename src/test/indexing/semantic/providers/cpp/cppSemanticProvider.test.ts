import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { CppSemanticProvider } from '../../../../../indexing/semantic/providers/cpp/cppSemanticProvider';
import { ExtractionDispatcher } from '../../../../../indexing/semantic/extractionDispatcher';
import { TypeScriptSemanticProvider } from '../../../../../indexing/semantic/providers/typescript/typeScriptSemanticProvider';

describe('CppSemanticProvider', () => {
    test('canHandle matches header and source extensions, not unrelated ones', () => {
        const provider = new CppSemanticProvider();
        expect(provider.canHandle('foo.h')).toBe(true);
        expect(provider.canHandle('foo.hpp')).toBe(true);
        expect(provider.canHandle('foo.cpp')).toBe(true);
        expect(provider.canHandle('foo.cc')).toBe(true);
        expect(provider.canHandle('foo.ts')).toBe(false);
        expect(provider.canHandle('foo.hs')).toBe(false);
    });

    describe('dispatcher registration', () => {
        test('routes .cpp/.h files to CppSemanticProvider and .ts files to TypeScriptSemanticProvider', async () => {
            const dispatcher = new ExtractionDispatcher();
            dispatcher.registerProvider(new TypeScriptSemanticProvider());
            dispatcher.registerProvider(new CppSemanticProvider());

            expect(dispatcher.canHandle('foo.cpp')).toBe(true);
            expect(dispatcher.canHandle('foo.h')).toBe(true);
            expect(dispatcher.canHandle('foo.ts')).toBe(true);
            expect(dispatcher.canHandle('foo.rs')).toBe(false);

            const cppResult = await dispatcher.extract('foo.cpp', 'class Foo {};');
            expect(cppResult?.providerMetadata.providerName).toBe('cpp-semantic-provider');

            const tsResult = await dispatcher.extract('foo.ts', 'const x = 1;');
            expect(tsResult?.providerMetadata.providerName).toBe('typescript-semantic-provider');
        });
    });

    describe('golden fixture: real header/.cpp split on disk', () => {
        let tempDir: string;
        const provider = new CppSemanticProvider();

        beforeAll(() => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-semantic-provider-'));
            fs.mkdirSync(path.join(tempDir, 'include'), { recursive: true });
            fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });

            fs.writeFileSync(path.join(tempDir, 'include', 'utils.h'), [
                '#pragma once',
                '#include <string>',
                '',
                'std::string Helper();',
                ''
            ].join('\n'));
            fs.writeFileSync(path.join(tempDir, 'src', 'utils.cpp'), [
                '#include "utils.h"',
                '',
                'std::string Helper() {',
                '    return "help";',
                '}',
                ''
            ].join('\n'));

            fs.writeFileSync(path.join(tempDir, 'include', 'animal.h'), [
                '#pragma once',
                '#include <string>',
                '',
                'namespace zoo {',
                '',
                'template <typename T>',
                'class Container {',
                'public:',
                '    T Get() const;',
                '};',
                '',
                '/// Box holds an int.',
                'class Box : public Container<int> {',
                '};',
                '',
                '/// Speaker can speak.',
                'class Speaker {',
                'public:',
                '    virtual ~Speaker() = default;',
                '    virtual std::string Speak() const = 0;',
                '};',
                '',
                '/// Loud can bark loudly.',
                'class Loud {',
                'public:',
                '    virtual ~Loud() = default;',
                '    virtual std::string Bark() const = 0;',
                '};',
                '',
                '/// Animal is a living thing.',
                'class Animal {',
                'public:',
                '    Animal() = default;',
                '    std::string GetName() const;',
                'private:',
                '    std::string name_;',
                '};',
                '',
                '/// Dog is a domesticated animal.',
                'class Dog : public Animal, public Speaker, public Loud {',
                'public:',
                '    Dog();',
                '    std::string Speak() const override;',
                '    std::string Bark() const override;',
                '    Dog* MakeAnother() const;',
                'private:',
                '    std::string growl() const;',
                '    std::string breed_;',
                '};',
                '',
                '}',
                ''
            ].join('\n'));

            fs.writeFileSync(path.join(tempDir, 'src', 'animal.cpp'), [
                '#include "animal.h"',
                '#include "utils.h"',
                '',
                'namespace zoo {',
                '',
                'std::string Animal::GetName() const {',
                '    return name_;',
                '}',
                '',
                'Dog::Dog() : breed_("mutt") {}',
                '',
                'std::string Dog::growl() const {',
                '    return "grr";',
                '}',
                '',
                'std::string Dog::Speak() const {',
                '    return "...";',
                '}',
                '',
                'std::string Dog::Bark() const {',
                '    return this->growl();',
                '}',
                '',
                'Dog* Dog::MakeAnother() const {',
                '    std::string helped = Helper();',
                '    return new Dog();',
                '}',
                '',
                '}',
                ''
            ].join('\n'));
        });

        afterAll(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        function extractAnimalCpp() {
            const filePath = path.join(tempDir, 'src', 'animal.cpp');
            const content = fs.readFileSync(filePath, 'utf8');
            return provider.extract(filePath, content, tempDir);
        }

        function extractAnimalHeader() {
            const filePath = path.join(tempDir, 'include', 'animal.h');
            const content = fs.readFileSync(filePath, 'utf8');
            return provider.extract(filePath, content, tempDir);
        }

        test('extracts structural entities with correct kinds and doc comments from the header', async () => {
            const result = await extractAnimalHeader();
            expect(result.status).toBe('SUCCESS');
            expect(result.diagnostics).toEqual([]);

            const byQualifiedName = new Map(result.entities.map(e => [e.canonicalId.qualifiedName, e]));

            const dogEntity = byQualifiedName.get('Dog');
            expect(dogEntity).toBeDefined();
            expect(dogEntity!.entityKind).toBe('class');
            expect(dogEntity!.documentation).toBe('Dog is a domesticated animal.');

            const speakProto = byQualifiedName.get('Dog.Speak');
            expect(speakProto).toBeDefined();
            expect(speakProto!.entityKind).toBe('method');

            const breedField = byQualifiedName.get('Dog.breed_');
            expect(breedField).toBeDefined();
            expect(breedField!.entityKind).toBe('variable');
        });

        test('THE key finding: resolves an out-of-class ClassName::method .cpp definition back to its header-declared class via the paired-header lookup (cross-file DECLARES)', async () => {
            const result = await extractAnimalCpp();
            expect(result.status).toBe('SUCCESS');
            expect(result.diagnostics).toEqual([]);

            const declares = result.relationships.filter(r => r.relationshipKind === 'DECLARES' && r.source.qualifiedName !== '');
            const pairs = declares.map(r => `${r.source.qualifiedName}->${r.target.qualifiedName}`).sort();
            expect(pairs).toEqual([
                'Animal->Animal.GetName',
                'Dog->Dog.Dog',
                'Dog->Dog.growl',
                'Dog->Dog.Speak',
                'Dog->Dog.Bark',
                'Dog->Dog.MakeAnother'
            ].sort());

            // The qualifiedName must NOT be double-qualified (a real bug found
            // and fixed during this pass: functionDeclaratorName was
            // returning "Cookie::GetDomain" instead of "GetDomain" for a
            // qualified_identifier declarator).
            const getName = declares.find(r => r.target.qualifiedName === 'Animal.GetName');
            expect(getName!.target.qualifiedName).not.toContain('::');
        });

        test('resolves multiple inheritance (Dog : Animal, Speaker, Loud) as three EXTENDS edges, and a generic base (Box : Container<int>) via the generic-unwrap fix', async () => {
            const result = await extractAnimalHeader();
            const extendsRels = result.relationships.filter(r => r.relationshipKind === 'EXTENDS');
            const dogExtends = extendsRels.filter(r => r.source.qualifiedName === 'Dog');
            expect(dogExtends.map(r => r.target.qualifiedName).sort()).toEqual(['Animal', 'Speaker', 'Loud'].sort());

            const boxExtends = extendsRels.find(r => r.source.qualifiedName === 'Box');
            expect(boxExtends).toBeDefined();
            expect(boxExtends!.target.qualifiedName).toBe('Container');
        });

        test('never emits an IMPLEMENTS relationship, even for the pure-virtual abstract bases Speaker/Loud -- explicit non-goal for C++', async () => {
            const result = await extractAnimalHeader();
            expect(result.relationships.filter(r => r.relationshipKind === ('IMPLEMENTS' as any))).toEqual([]);
        });

        test('resolves same-file CALLS (heuristic evidence) via this->method(), including a method only known through the paired header', async () => {
            const result = await extractAnimalCpp();
            const calls = result.relationships.filter(r => r.relationshipKind === 'CALLS');
            const barkCall = calls.find(c => c.source.qualifiedName === 'Dog.Bark');
            expect(barkCall).toBeDefined();
            expect(barkCall!.target.qualifiedName).toBe('Dog.growl');
            expect(barkCall!.evidence[0].type).toBe('heuristic');

            // Helper() is a free function declared/defined in a DIFFERENT
            // header/.cpp pair (utils.h/utils.cpp), not animal.cpp's own
            // paired header -- cross-file free-function resolution is not
            // attempted (only cross-file MEMBER method resolution via
            // header-pairing is), so this call stays silently unresolved.
            expect(calls.some(c => c.target.qualifiedName === 'Helper')).toBe(false);
        });

        test('resolves unambiguous INSTANTIATES via `new Dog()`, and filters array-new/primitive-new', async () => {
            const result = await extractAnimalCpp();
            const instantiates = result.relationships.filter(r => r.relationshipKind === 'INSTANTIATES');
            expect(instantiates.length).toBe(1);
            expect(instantiates[0].source.qualifiedName).toBe('Dog.MakeAnother');
            expect(instantiates[0].target.qualifiedName).toBe('Dog');
        });

        test('resolves the .cpp file\'s own #include set (paired header + a second header) as IMPORTS, and flags <string> as out of scope silently (not a KnownUnknown)', async () => {
            const result = await extractAnimalCpp();
            const imports = result.relationships.filter(r => r.relationshipKind === 'IMPORTS');
            expect(imports.length).toBe(2);
            expect(imports.map(i => i.target.logicalNamespace).sort()).toEqual(['animal', 'utils'].sort());

            const unresolvedAngleBrackets = result.knownUnknowns.filter(u => u.unsupportedConstruct === 'Unresolved Include');
            expect(unresolvedAngleBrackets).toEqual([]); // <string> is silently out of scope, matching every provider's "don't flag stdlib" tier
        });
    });

    describe('array-new / primitive-new filtering', () => {
        test('does not treat `new int[10]` or `new int(5)` as INSTANTIATES, unlike `new Widget()`', async () => {
            const provider = new CppSemanticProvider();
            const source = [
                'class Widget {};',
                '',
                'void Build() {',
                '    int* arr = new int[10];',
                '    int* scalar = new int(5);',
                '    Widget* w = new Widget();',
                '}',
                ''
            ].join('\n');

            const result = await provider.extract('/workspace/src/foo.cpp', source, '/workspace');
            expect(result.status).toBe('SUCCESS');

            const instantiates = result.relationships.filter(r => r.relationshipKind === 'INSTANTIATES');
            expect(instantiates.length).toBe(1);
            expect(instantiates[0].target.qualifiedName).toBe('Widget');
        });
    });
});
