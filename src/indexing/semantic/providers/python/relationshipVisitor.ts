import Parser = require('node-tree-sitter');
import { KnownUnknown, ProviderDiagnostic } from '../../semanticProviderContract';
import { IdentityDescriptor, PythonProgramHandle } from './internalModels';
import { PythonNameResolver } from './resolution/nameResolver';
import { PythonRelationshipDescriptor, PythonRelationshipResolver } from './resolution/relationshipResolver';

export class RelationshipVisitor {
    private descriptors: PythonRelationshipDescriptor[] = [];
    private diagnostics: ProviderDiagnostic[] = [];
    private knownUnknowns: KnownUnknown[] = [];

    public processNode(node: Parser.SyntaxNode, handle: PythonProgramHandle, nameResolver: PythonNameResolver, moduleDescriptor: IdentityDescriptor): void {
        try {
            const results = PythonRelationshipResolver.resolve(node, handle, nameResolver, moduleDescriptor);
            if (node.type === 'class_definition') {
                results.push(...PythonRelationshipResolver.resolveExtends(node, handle, nameResolver));
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
                code: 'PY-EXT-004',
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
