import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { RustSemanticProvider } from '../../../../../indexing/semantic/providers/rust/rustSemanticProvider';
import { ExtractionDispatcher } from '../../../../../indexing/semantic/extractionDispatcher';
import { TypeScriptSemanticProvider } from '../../../../../indexing/semantic/providers/typescript/typeScriptSemanticProvider';

describe('RustSemanticProvider', () => {
    test('canHandle only matches .rs files', () => {
        const provider = new RustSemanticProvider();
        expect(provider.canHandle('foo.rs')).toBe(true);
        expect(provider.canHandle('foo.ts')).toBe(false);
        expect(provider.canHandle('foo.rst')).toBe(false);
    });

    describe('dispatcher registration', () => {
        test('routes .rs files to RustSemanticProvider and .ts files to TypeScriptSemanticProvider', async () => {
            const dispatcher = new ExtractionDispatcher();
            dispatcher.registerProvider(new TypeScriptSemanticProvider());
            dispatcher.registerProvider(new RustSemanticProvider());

            expect(dispatcher.canHandle('foo.rs')).toBe(true);
            expect(dispatcher.canHandle('foo.ts')).toBe(true);
            expect(dispatcher.canHandle('foo.go')).toBe(false);

            const rustResult = await dispatcher.extract('foo.rs', 'struct Foo {}');
            expect(rustResult?.providerMetadata.providerName).toBe('rust-semantic-provider');

            const tsResult = await dispatcher.extract('foo.ts', 'const x = 1;');
            expect(tsResult?.providerMetadata.providerName).toBe('typescript-semantic-provider');
        });
    });

    describe('golden fixture: real Cargo.toml-based crate on disk', () => {
        let tempDir: string;
        const provider = new RustSemanticProvider();

        beforeAll(() => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-semantic-provider-'));
            fs.writeFileSync(path.join(tempDir, 'Cargo.toml'), '[package]\nname = "petshop"\nversion = "0.1.0"\n');
            fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tempDir, 'src', 'utils.rs'), [
                'pub fn helper() -> String {',
                '    "help".to_string()',
                '}',
                ''
            ].join('\n'));
            fs.writeFileSync(path.join(tempDir, 'src', 'shapes.rs'), [
                'pub struct Shape {',
                '    pub sides: u32,',
                '}',
                ''
            ].join('\n'));
            fs.writeFileSync(path.join(tempDir, 'src', 'pet.rs'), [
                'use crate::utils;',
                'use crate::shapes::Shape;',
                'use std::collections::HashMap;',
                '',
                '/// Speak is something that can speak.',
                'pub trait Speak {',
                '    fn speak(&self) -> String;',
                '    /// greet uses speak to say hello.',
                '    fn greet(&self) -> String {',
                '        format!("Hi, {}", self.speak())',
                '    }',
                '}',
                '',
                '/// Loud is something that can speak loudly, on top of speaking normally.',
                'pub trait Loud: Speak {',
                '    fn bark(&self) -> String;',
                '}',
                '',
                '/// Container holds a single value.',
                'pub trait Container {',
                '    fn get(&self) -> i32;',
                '}',
                '',
                '/// Animal is a living thing.',
                'pub struct Animal {',
                '    pub name: String,',
                '}',
                '',
                'impl Speak for Animal {',
                '    fn speak(&self) -> String {',
                '        "...".to_string()',
                '    }',
                '}',
                '',
                '/// Dog is a domesticated animal.',
                'pub struct Dog {',
                '    pub breed: String,',
                '}',
                '',
                'impl Dog {',
                '    fn growl(&self) -> String {',
                '        "grr".to_string()',
                '    }',
                '',
                '    pub fn bark(&self) -> String {',
                '        self.growl()',
                '    }',
                '',
                '    pub fn new() -> Dog {',
                '        Dog { breed: "mutt".to_string() }',
                '    }',
                '',
                '    pub fn make_another(&self) -> Dog {',
                '        let x = utils::helper();',
                '        let _ = x;',
                '        Dog { breed: "mutt".to_string() }',
                '    }',
                '}',
                '',
                'impl Speak for Dog {',
                '    fn speak(&self) -> String {',
                '        Self::new().bark()',
                '    }',
                '}',
                '',
                'impl Clone for Dog {',
                '    fn clone(&self) -> Self {',
                '        Dog { breed: self.breed.clone() }',
                '    }',
                '}',
                '',
                '/// Wrapper holds a generic value.',
                'pub struct Wrapper<T> {',
                '    pub value: T,',
                '}',
                '',
                'impl<T> Wrapper<T> {',
                '    pub fn new(value: T) -> Wrapper<T> {',
                '        Wrapper { value }',
                '    }',
                '}',
                '',
                'impl Container for Wrapper<i32> {',
                '    fn get(&self) -> i32 {',
                '        self.value',
                '    }',
                '}',
                '',
                'fn build_collections() {',
                '    let t = (1, 2, 3);',
                '    let a = [1, 2, 3];',
                '    let _ = t;',
                '    let _ = a;',
                '}',
                ''
            ].join('\n'));
        });

        afterAll(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        function extractPet() {
            const filePath = path.join(tempDir, 'src', 'pet.rs');
            const content = fs.readFileSync(filePath, 'utf8');
            return provider.extract(filePath, content, tempDir);
        }

        test('extracts structural entities with correct kinds and doc comments, using the Cargo.toml-derived crate name as identity', async () => {
            const result = await extractPet();
            expect(result.status).toBe('SUCCESS');
            expect(result.diagnostics).toEqual([]);

            const byQualifiedName = new Map(result.entities.map(e => [e.canonicalId.qualifiedName, e]));

            const moduleEntity = result.entities.find(e => e.entityKind === 'module');
            expect(moduleEntity).toBeDefined();
            expect(moduleEntity!.canonicalId.logicalNamespace).toBe('petshop::pet');

            const dogEntity = byQualifiedName.get('Dog');
            expect(dogEntity).toBeDefined();
            expect(dogEntity!.entityKind).toBe('class');
            expect(dogEntity!.documentation).toBe('Dog is a domesticated animal.');

            const speakTrait = byQualifiedName.get('Speak');
            expect(speakTrait).toBeDefined();
            expect(speakTrait!.entityKind).toBe('interface');
            expect(speakTrait!.documentation).toBe('Speak is something that can speak.');

            const bark = byQualifiedName.get('Dog.bark');
            expect(bark).toBeDefined();
            expect(bark!.entityKind).toBe('method');

            const buildFn = byQualifiedName.get('build_collections');
            expect(buildFn).toBeDefined();
            expect(buildFn!.entityKind).toBe('function');
        });

        test('captures a trait default method (function_item with a body) but not a signature-only trait method (function_signature_item) -- a disclosed gap, not an oversight', async () => {
            const result = await extractPet();
            const byQualifiedName = new Map(result.entities.map(e => [e.canonicalId.qualifiedName, e]));

            expect(byQualifiedName.get('Speak.greet')).toBeDefined();
            expect(byQualifiedName.get('Speak.speak')).toBeUndefined();
            expect(byQualifiedName.get('Loud.bark')).toBeUndefined();
            expect(byQualifiedName.get('Container.get')).toBeUndefined();
        });

        test('resolves `impl Trait for Type` as IMPLEMENTS, including through a generic impl target, and flags a non-local trait as an unresolved KnownUnknown', async () => {
            const result = await extractPet();
            const implementsRels = result.relationships.filter(r => r.relationshipKind === 'IMPLEMENTS');

            const pairs = implementsRels.map(r => `${r.source.qualifiedName}->${r.target.qualifiedName}`).sort();
            expect(pairs).toEqual(['Animal->Speak', 'Dog->Speak', 'Wrapper->Container'].sort());

            // impl Container for Wrapper<i32> -- the generic-type-unwrap fix
            // (unwrapGenericType) is what makes "Wrapper<i32>" resolve back
            // to the plain "Wrapper" struct declared earlier in the file.
            const wrapperImplements = implementsRels.find(r => r.source.qualifiedName === 'Wrapper');
            expect(wrapperImplements!.target.qualifiedName).toBe('Container');

            const unresolvedTrait = result.knownUnknowns.find(u => u.unsupportedConstruct === 'Trait');
            expect(unresolvedTrait).toBeDefined();
            expect(unresolvedTrait!.reason).toContain('Clone');
        });

        test('classifies a supertrait bound (`trait Sub: Super`) as EXTENDS', async () => {
            const result = await extractPet();
            const extendsRels = result.relationships.filter(r => r.relationshipKind === 'EXTENDS');
            expect(extendsRels.length).toBe(1);
            expect(extendsRels[0].source.qualifiedName).toBe('Loud');
            expect(extendsRels[0].target.qualifiedName).toBe('Speak');
        });

        test('resolves a crate-relative module-only import and a crate-relative item import to their real target files, and flags the stdlib import as unresolved', async () => {
            const result = await extractPet();
            const imports = result.relationships.filter(r => r.relationshipKind === 'IMPORTS');
            expect(imports.length).toBe(2);
            expect(imports.map(i => i.target.logicalNamespace).sort()).toEqual(['petshop::shapes', 'petshop::utils'].sort());
            expect(imports[0].evidence[0].type).toBe('ast');

            const unresolvedImport = result.knownUnknowns.find(u => u.unsupportedConstruct === 'Unresolved Import');
            expect(unresolvedImport).toBeDefined();
            expect(unresolvedImport!.reason).toContain('std::collections::HashMap');
        });

        test('resolves same-file CALLS (heuristic evidence) via self.method() and Self::method() forms, including through a generic impl block', async () => {
            const result = await extractPet();
            const calls = result.relationships.filter(r => r.relationshipKind === 'CALLS');

            const pairs = calls.map(c => `${c.source.qualifiedName}->${c.target.qualifiedName}`).sort();
            expect(pairs).toEqual(['Dog.bark->Dog.growl', 'Dog.speak->Dog.new'].sort());
            for (const call of calls) {
                expect(call.evidence[0].type).toBe('heuristic');
            }
        });

        test('resolves unambiguous same-file INSTANTIATES via struct_expression -- needs no filtering, unlike Go\'s shared composite_literal', async () => {
            const result = await extractPet();
            const instantiates = result.relationships.filter(r => r.relationshipKind === 'INSTANTIATES');

            const dogInstantiates = instantiates.filter(i => i.target.qualifiedName === 'Dog');
            expect(dogInstantiates.map(i => i.source.qualifiedName).sort()).toEqual(['Dog.new', 'Dog.make_another', 'Dog.clone'].sort());

            const wrapperInstantiates = instantiates.filter(i => i.target.qualifiedName === 'Wrapper');
            expect(wrapperInstantiates.length).toBe(1);
            expect(wrapperInstantiates[0].source.qualifiedName).toBe('Wrapper.new');
        });

        test('does not treat tuple/array expressions in build_collections as INSTANTIATES -- confirmed distinct node types from struct_expression', async () => {
            const result = await extractPet();
            const instantiates = result.relationships.filter(r => r.relationshipKind === 'INSTANTIATES');
            expect(instantiates.some(i => i.source.qualifiedName === 'build_collections')).toBe(false);
            expect(instantiates.length).toBe(4);
        });

        test('emits DECLARES from the synthetic module entity to module-level declarations, and from each type/trait to its own methods', async () => {
            const result = await extractPet();
            const moduleDeclares = result.relationships.filter(r => r.relationshipKind === 'DECLARES' && r.source.qualifiedName === '');
            expect(moduleDeclares.map(r => r.target.qualifiedName).sort()).toEqual(['Speak', 'Loud', 'Container', 'Animal', 'Dog', 'Wrapper', 'build_collections'].sort());

            const dogDeclares = result.relationships.filter(r => r.relationshipKind === 'DECLARES' && r.source.qualifiedName === 'Dog');
            expect(dogDeclares.map(r => r.target.qualifiedName).sort()).toEqual(['Dog.growl', 'Dog.bark', 'Dog.new', 'Dog.make_another', 'Dog.speak', 'Dog.clone'].sort());

            const wrapperDeclares = result.relationships.filter(r => r.relationshipKind === 'DECLARES' && r.source.qualifiedName === 'Wrapper');
            expect(wrapperDeclares.map(r => r.target.qualifiedName).sort()).toEqual(['Wrapper.new', 'Wrapper.get'].sort());

            const speakDeclares = result.relationships.filter(r => r.relationshipKind === 'DECLARES' && r.source.qualifiedName === 'Speak');
            expect(speakDeclares.map(r => r.target.qualifiedName)).toEqual(['Speak.greet']);
        });
    });

    describe('struct/tuple/array expression node-type distinction', () => {
        test('a struct literal produces INSTANTIATES while sibling tuple/array literals of the same shape do not', async () => {
            const provider = new RustSemanticProvider();
            const source = [
                'pub struct Widget {}',
                '',
                'fn build() -> Widget {',
                '    let t = (1, 2, 3);',
                '    let a = [1, 2, 3];',
                '    let _ = t;',
                '    let _ = a;',
                '    Widget {}',
                '}',
                ''
            ].join('\n');

            const result = await provider.extract('/workspace/src/foo.rs', source, '/workspace');
            expect(result.status).toBe('SUCCESS');

            const instantiates = result.relationships.filter(r => r.relationshipKind === 'INSTANTIATES');
            expect(instantiates.length).toBe(1);
            expect(instantiates[0].target.qualifiedName).toBe('Widget');
        });
    });
});
