import Parser = require('node-tree-sitter');
import { KnownUnknown, ProviderDiagnostic } from '../../semanticProviderContract';
import { IdentityDescriptor, JavaProgramHandle } from './internalModels';
import { JavaNameResolver } from './resolution/nameResolver';
import { JavaRelationshipDescriptor, JavaRelationshipResolver } from './resolution/relationshipResolver';

export class RelationshipVisitor {
    private descriptors: JavaRelationshipDescriptor[] = [];
    private diagnostics: ProviderDiagnostic[] = [];
    private knownUnknowns: KnownUnknown[] = [];

    public processNode(node: Parser.SyntaxNode, handle: JavaProgramHandle, nameResolver: JavaNameResolver, moduleDescriptor: IdentityDescriptor): void {
        try {
            const results = JavaRelationshipResolver.resolve(node, handle, nameResolver, moduleDescriptor);
            if (node.type === 'class_declaration') {
                results.push(...JavaRelationshipResolver.resolveExtends(node, handle, nameResolver));
            }
            if (node.type === 'class_declaration' || node.type === 'interface_declaration' || node.type === 'enum_declaration') {
                results.push(...JavaRelationshipResolver.resolveImplements(node, handle, nameResolver));
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
                code: 'JAVA-EXT-002',
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
