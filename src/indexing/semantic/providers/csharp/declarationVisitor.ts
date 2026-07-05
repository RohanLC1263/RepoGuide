import Parser = require('node-tree-sitter');
import { KnownUnknown, ProviderDiagnostic } from '../../semanticProviderContract';
import { DeclarationExtractionResult, CSharpProgramHandle } from './internalModels';
import { DeclarationClassifier } from './mappers/declarationClassifier';
import { LocationMapper } from './mappers/locationMapper';
import { ModifierMapper } from './mappers/modifierMapper';
import { DocumentationExtractor } from './mappers/documentationExtractor';
import { IdentityDescriptorBuilder } from './resolution/identityDescriptorBuilder';
import { CanonicalIdentityFactory } from '../shared/canonicalIdentityFactory';
import { isInsideMethodBody } from './astHelpers';

export class DeclarationVisitor {
    private results: DeclarationExtractionResult[] = [];
    private diagnostics: ProviderDiagnostic[] = [];
    private knownUnknowns: KnownUnknown[] = [];

    private classifier = new DeclarationClassifier();
    private locationMapper = new LocationMapper();
    private modifierMapper = new ModifierMapper();
    private docExtractor = new DocumentationExtractor();

    public processNode(node: Parser.SyntaxNode, handle: CSharpProgramHandle): void {
        try {
            if (node.type === 'field_declaration') {
                this.processFieldDeclaration(node, handle);
                return;
            }
            if (node.type === 'property_declaration') {
                this.processPropertyDeclaration(node, handle);
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
                code: 'CS-EXT-001',
                severity: 'error',
                message: `Internal error during AST traversal: ${err.message}`,
                location: { filePath: handle.filePath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
            });
        }
    }

    private processFieldDeclaration(node: Parser.SyntaxNode, handle: CSharpProgramHandle): void {
        if (isInsideMethodBody(node)) {
            return;
        }
        const variableDeclaration = node.namedChildren.find(c => c.type === 'variable_declaration');
        if (!variableDeclaration) {
            return;
        }
        for (const declarator of variableDeclaration.namedChildren) {
            if (declarator.type !== 'variable_declarator') {
                continue;
            }
            const nameNode = declarator.namedChildren[0];
            if (!nameNode || nameNode.type !== 'identifier') {
                continue;
            }
            this.emit(declarator, 'variable', nameNode.text, handle, node);
        }
    }

    private processPropertyDeclaration(node: Parser.SyntaxNode, handle: CSharpProgramHandle): void {
        if (isInsideMethodBody(node)) {
            return;
        }
        const name = node.childForFieldName('name')?.text;
        if (!name) {
            return;
        }
        this.emit(node, 'variable', name, handle);
    }

    /** `modifierSourceNode` lets a variable_declarator (which has no modifiers of its own) borrow its enclosing field_declaration's modifiers/attributes. */
    private emit(node: Parser.SyntaxNode, entityKind: DeclarationExtractionResult['entityKind'], name: string, handle: CSharpProgramHandle, modifierSourceNode?: Parser.SyntaxNode): void {
        const modifierNode = modifierSourceNode ?? node;
        const loc = this.locationMapper.map(node);
        const mods = this.modifierMapper.map(modifierNode);
        const doc = entityKind === 'class' || entityKind === 'interface' || entityKind === 'enum' || entityKind === 'method' ? this.docExtractor.extract(modifierNode) : undefined;

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
