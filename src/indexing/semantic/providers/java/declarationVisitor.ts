import Parser = require('node-tree-sitter');
import { KnownUnknown, ProviderDiagnostic } from '../../semanticProviderContract';
import { DeclarationExtractionResult, JavaProgramHandle } from './internalModels';
import { DeclarationClassifier } from './mappers/declarationClassifier';
import { LocationMapper } from './mappers/locationMapper';
import { ModifierMapper } from './mappers/modifierMapper';
import { DocumentationExtractor } from './mappers/documentationExtractor';
import { IdentityDescriptorBuilder } from './resolution/identityDescriptorBuilder';
import { CanonicalIdentityFactory } from '../shared/canonicalIdentityFactory';
import { isInsideAnonymousClassBody, isInsideMethodBody } from './astHelpers';

export class DeclarationVisitor {
    private results: DeclarationExtractionResult[] = [];
    private diagnostics: ProviderDiagnostic[] = [];
    private knownUnknowns: KnownUnknown[] = [];

    private classifier = new DeclarationClassifier();
    private locationMapper = new LocationMapper();
    private modifierMapper = new ModifierMapper();
    private docExtractor = new DocumentationExtractor();

    public processNode(node: Parser.SyntaxNode, handle: JavaProgramHandle): void {
        try {
            if (node.type === 'field_declaration') {
                this.processFieldDeclaration(node, handle);
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
                code: 'JAVA-EXT-001',
                severity: 'error',
                message: `Internal error during AST traversal: ${err.message}`,
                location: { filePath: handle.filePath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
            });
        }
    }

    private processFieldDeclaration(node: Parser.SyntaxNode, handle: JavaProgramHandle): void {
        if (isInsideAnonymousClassBody(node) || isInsideMethodBody(node)) {
            return;
        }
        for (const declarator of node.namedChildren) {
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

    /** `modifierSourceNode` lets a variable_declarator (which has no modifiers of its own) borrow its enclosing field_declaration's modifiers/docs. */
    private emit(node: Parser.SyntaxNode, entityKind: DeclarationExtractionResult['entityKind'], name: string, handle: JavaProgramHandle, modifierSourceNode?: Parser.SyntaxNode): void {
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
