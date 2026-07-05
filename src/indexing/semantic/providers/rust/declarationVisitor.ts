import Parser = require('node-tree-sitter');
import { KnownUnknown, ProviderDiagnostic } from '../../semanticProviderContract';
import { DeclarationExtractionResult, RustProgramHandle } from './internalModels';
import { DeclarationClassifier } from './mappers/declarationClassifier';
import { LocationMapper } from './mappers/locationMapper';
import { ModifierMapper } from './mappers/modifierMapper';
import { DocumentationExtractor } from './mappers/documentationExtractor';
import { IdentityDescriptorBuilder } from './resolution/identityDescriptorBuilder';
import { CanonicalIdentityFactory } from '../shared/canonicalIdentityFactory';
import { isInsideFunctionBody } from './astHelpers';

export class DeclarationVisitor {
    private results: DeclarationExtractionResult[] = [];
    private diagnostics: ProviderDiagnostic[] = [];
    private knownUnknowns: KnownUnknown[] = [];

    private classifier = new DeclarationClassifier();
    private locationMapper = new LocationMapper();
    private modifierMapper = new ModifierMapper();
    private docExtractor = new DocumentationExtractor();

    public processNode(node: Parser.SyntaxNode, handle: RustProgramHandle): void {
        try {
            if (node.type === 'const_item' || node.type === 'static_item') {
                this.processConstOrStatic(node, handle);
                return;
            }

            const entityKind = this.classifier.classify(node);
            if (!entityKind) {
                return;
            }
            const name = node.childForFieldName('name')?.text;
            if (!name) {
                return;
            }
            this.emit(node, entityKind, name, handle);
        } catch (err: any) {
            this.diagnostics.push({
                code: 'RUST-EXT-001',
                severity: 'error',
                message: `Internal error during AST traversal: ${err.message}`,
                location: { filePath: handle.filePath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
            });
        }
    }

    private processConstOrStatic(node: Parser.SyntaxNode, handle: RustProgramHandle): void {
        if (isInsideFunctionBody(node)) {
            return; // a local `let`/const inside a function body isn't a stable module-level member
        }
        const name = node.childForFieldName('name')?.text;
        if (!name) {
            return;
        }
        this.emit(node, 'variable', name, handle);
    }

    private emit(node: Parser.SyntaxNode, entityKind: DeclarationExtractionResult['entityKind'], name: string, handle: RustProgramHandle): void {
        const loc = this.locationMapper.map(node);
        const mods = this.modifierMapper.map(node);
        const doc = this.docExtractor.extract(node);

        const descriptor = IdentityDescriptorBuilder.build(node, name, entityKind, handle);
        const canonicalIdentity = CanonicalIdentityFactory.create(descriptor);

        this.results.push({
            node,
            entityKind,
            name,
            filePath: handle.filePath,
            startLine: loc.startLine,
            endLine: loc.endLine,
            modifiers: mods.modifiers,
            visibility: mods.visibility,
            documentation: doc,
            canonicalIdentity
        });
    }

    public getResults() {
        return {
            results: this.results,
            diagnostics: this.diagnostics,
            knownUnknowns: this.knownUnknowns
        };
    }
}
