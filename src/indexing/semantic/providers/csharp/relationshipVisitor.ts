import Parser = require('node-tree-sitter');
import { KnownUnknown, ProviderDiagnostic } from '../../semanticProviderContract';
import { IdentityDescriptor, CSharpProgramHandle } from './internalModels';
import { CSharpNameResolver } from './resolution/nameResolver';
import { CSharpRelationshipDescriptor, CSharpRelationshipResolver } from './resolution/relationshipResolver';

const TYPE_DECLARATION_KINDS = new Set(['class_declaration', 'struct_declaration', 'interface_declaration', 'record_declaration', 'enum_declaration']);

export class RelationshipVisitor {
    private descriptors: CSharpRelationshipDescriptor[] = [];
    private diagnostics: ProviderDiagnostic[] = [];
    private knownUnknowns: KnownUnknown[] = [];

    public processNode(node: Parser.SyntaxNode, handle: CSharpProgramHandle, nameResolver: CSharpNameResolver, moduleDescriptor: IdentityDescriptor): void {
        try {
            const results = CSharpRelationshipResolver.resolve(node, handle, nameResolver, moduleDescriptor);
            if (TYPE_DECLARATION_KINDS.has(node.type)) {
                results.push(...CSharpRelationshipResolver.resolveBaseList(node, handle, nameResolver));
            }
            if (node.type === 'constructor_declaration') {
                results.push(...CSharpRelationshipResolver.resolveConstructorInitializer(node, handle, nameResolver));
            }
            for (const result of results) {
                if (result.type === 'descriptor') {
                    this.descriptors.push(result.descriptor);
                } else {
                    this.knownUnknowns.push(result.unknown);
                }
            }
        } catch (err: any) {
            this.diagnostics.push({
                code: 'CS-EXT-002',
                severity: 'error',
                message: `Internal error during relationship extraction: ${err.message}`,
                location: { filePath: handle.filePath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
            });
        }
    }

    public getResults() {
        return {
            descriptors: this.descriptors,
            diagnostics: this.diagnostics,
            knownUnknowns: this.knownUnknowns
        };
    }
}
