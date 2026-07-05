import Parser = require('node-tree-sitter');
import { KnownUnknown, ProviderDiagnostic } from '../../semanticProviderContract';
import { DeclarationExtractionResult, PythonProgramHandle } from './internalModels';
import { DeclarationClassifier } from './mappers/declarationClassifier';
import { LocationMapper } from './mappers/locationMapper';
import { ModifierMapper } from './mappers/modifierMapper';
import { DocumentationExtractor } from './mappers/documentationExtractor';
import { IdentityDescriptorBuilder } from './resolution/identityDescriptorBuilder';
import { CanonicalIdentityFactory } from '../shared/canonicalIdentityFactory';

export class DeclarationVisitor {
    private results: DeclarationExtractionResult[] = [];
    private diagnostics: ProviderDiagnostic[] = [];
    private knownUnknowns: KnownUnknown[] = [];

    private classifier = new DeclarationClassifier();
    private locationMapper = new LocationMapper();
    private modifierMapper = new ModifierMapper();
    private docExtractor = new DocumentationExtractor();

    public processNode(node: Parser.SyntaxNode, handle: PythonProgramHandle): void {
        try {
            if (this.isInsideFunctionBody(node)) {
                return; // prune local variables/nested defs' own locals
            }

            const entityKind = this.classifier.classify(node);
            if (!entityKind) {
                return;
            }

            const name = this.extractName(node, entityKind);
            if (!name) {
                return;
            }

            const loc = this.locationMapper.map(node);
            const mods = this.modifierMapper.map(node, name);
            const doc = entityKind === 'class' || entityKind === 'function' || entityKind === 'method' ? this.docExtractor.extract(node) : undefined;

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
        } catch (err: any) {
            this.diagnostics.push({
                code: 'PY-EXT-001',
                severity: 'error',
                message: `Internal error during AST traversal: ${err.message}`,
                location: { filePath: handle.filePath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
            });
        }
    }

    private extractName(node: Parser.SyntaxNode, entityKind: 'class' | 'function' | 'method' | 'variable'): string | null {
        if (entityKind === 'variable') {
            return node.namedChildren[0]?.text ?? null;
        }
        return node.childForFieldName('name')?.text ?? null;
    }

    private isInsideFunctionBody(node: Parser.SyntaxNode): boolean {
        let current = node.parent;
        while (current) {
            if (current.type === 'function_definition') {
                return true;
            }
            current = current.parent;
        }
        return false;
    }

    public getResults() {
        return {
            results: this.results,
            diagnostics: this.diagnostics,
            knownUnknowns: this.knownUnknowns
        };
    }
}
