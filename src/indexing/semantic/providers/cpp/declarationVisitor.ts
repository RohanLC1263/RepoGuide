import Parser = require('node-tree-sitter');
import { KnownUnknown, ProviderDiagnostic } from '../../semanticProviderContract';
import { DeclarationExtractionResult, CppProgramHandle } from './internalModels';
import { DeclarationClassifier } from './mappers/declarationClassifier';
import { LocationMapper } from './mappers/locationMapper';
import { ModifierMapper } from './mappers/modifierMapper';
import { DocumentationExtractor } from './mappers/documentationExtractor';
import { IdentityDescriptorBuilder } from './resolution/identityDescriptorBuilder';
import { CanonicalIdentityFactory } from '../shared/canonicalIdentityFactory';
import { functionDeclaratorName, unwrapDeclarator } from './astHelpers';

export class DeclarationVisitor {
    private results: DeclarationExtractionResult[] = [];
    private diagnostics: ProviderDiagnostic[] = [];
    private knownUnknowns: KnownUnknown[] = [];

    private classifier = new DeclarationClassifier();
    private locationMapper = new LocationMapper();
    private modifierMapper = new ModifierMapper();
    private docExtractor = new DocumentationExtractor();

    public processNode(node: Parser.SyntaxNode, handle: CppProgramHandle): void {
        try {
            const entityKind = this.classifier.classify(node);
            if (!entityKind) {
                return;
            }
            const name = this.nameOf(node);
            if (!name) {
                return;
            }
            this.emit(node, entityKind, name, handle);
        } catch (err: any) {
            this.diagnostics.push({
                code: 'CPP-EXT-001',
                severity: 'error',
                message: `Internal error during AST traversal: ${err.message}`,
                location: { filePath: handle.filePath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
            });
        }
    }

    private nameOf(node: Parser.SyntaxNode): string | null {
        if (node.type === 'class_specifier' || node.type === 'struct_specifier' || node.type === 'enum_specifier') {
            return node.childForFieldName('name')?.text ?? null;
        }
        if (node.type === 'function_definition') {
            const functionDeclarator = unwrapDeclarator(node.childForFieldName('declarator'));
            return functionDeclarator ? functionDeclaratorName(functionDeclarator) : null;
        }
        if (node.type === 'field_declaration' || node.type === 'declaration') {
            const functionDeclarator = unwrapDeclarator(node.childForFieldName('declarator'));
            if (functionDeclarator?.type === 'function_declarator') {
                return functionDeclaratorName(functionDeclarator);
            }
            if (node.type === 'field_declaration' && node.childForFieldName('declarator')?.type === 'field_identifier') {
                return node.childForFieldName('declarator')!.text;
            }
        }
        return null;
    }

    private emit(node: Parser.SyntaxNode, entityKind: DeclarationExtractionResult['entityKind'], name: string, handle: CppProgramHandle): void {
        const loc = this.locationMapper.map(node);
        const mods = this.modifierMapper.map(node);
        const doc = this.docExtractor.extract(node);

        const descriptor = IdentityDescriptorBuilder.build(node, name, entityKind as any, handle);
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
