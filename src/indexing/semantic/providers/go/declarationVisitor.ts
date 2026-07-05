import Parser = require('node-tree-sitter');
import { KnownUnknown, ProviderDiagnostic } from '../../semanticProviderContract';
import { DeclarationExtractionResult, GoProgramHandle } from './internalModels';
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

    public processNode(node: Parser.SyntaxNode, handle: GoProgramHandle): void {
        try {
            if (node.type === 'type_declaration') {
                this.processTypeDeclaration(node, handle);
                return;
            }
            if (node.type === 'var_declaration' || node.type === 'const_declaration') {
                this.processVarOrConstDeclaration(node, handle);
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
            this.emit(node, entityKind, name, handle, true);
        } catch (err: any) {
            this.diagnostics.push({
                code: 'GO-EXT-001',
                severity: 'error',
                message: `Internal error during AST traversal: ${err.message}`,
                location: { filePath: handle.filePath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
            });
        }
    }

    private processTypeDeclaration(node: Parser.SyntaxNode, handle: GoProgramHandle): void {
        if (isInsideFunctionBody(node)) {
            return;
        }
        for (const spec of node.namedChildren) {
            if (spec.type !== 'type_spec') {
                continue; // type_alias ("type Foo = Bar") isn't a structural declaration worth extracting
            }
            const name = spec.childForFieldName('name')?.text;
            const typeNode = spec.childForFieldName('type');
            if (!name || !typeNode) {
                continue;
            }
            // Only struct/interface type_specs are "classes"/"interfaces" --
            // a defined type over a primitive/slice/map/func ("type ID int")
            // isn't structurally interesting, matching the existing legacy
            // pipeline's isLikelyClassNode precedent (staticAnalyzer.ts).
            if (typeNode.type === 'struct_type') {
                this.emit(spec, 'class', name, handle, true, node);
            } else if (typeNode.type === 'interface_type') {
                this.emit(spec, 'interface', name, handle, true, node);
            }
        }
    }

    private processVarOrConstDeclaration(node: Parser.SyntaxNode, handle: GoProgramHandle): void {
        if (isInsideFunctionBody(node)) {
            return;
        }
        for (const spec of node.namedChildren) {
            if (spec.type !== 'var_spec' && spec.type !== 'const_spec') {
                continue;
            }
            const name = spec.childForFieldName('name')?.text;
            if (!name) {
                continue;
            }
            this.emit(spec, 'variable', name, handle, false, node);
        }
    }

    /** `docSourceNode` lets a type_spec/var_spec/const_spec (which has no doc comment of its own) borrow its enclosing declaration's doc comment. */
    private emit(node: Parser.SyntaxNode, entityKind: DeclarationExtractionResult['entityKind'], name: string, handle: GoProgramHandle, canHaveDoc: boolean, docSourceNode?: Parser.SyntaxNode): void {
        const loc = this.locationMapper.map(node);
        const mods = this.modifierMapper.map(name);
        const doc = canHaveDoc ? this.docExtractor.extract(docSourceNode ?? node) : undefined;

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
