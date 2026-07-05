import Parser = require('node-tree-sitter');
import { KnownUnknown, ProviderDiagnostic } from '../../semanticProviderContract';
import { IdentityDescriptor, CppProgramHandle } from './internalModels';
import { CppNameResolver } from './resolution/nameResolver';
import { CppRelationshipDescriptor, CppRelationshipResolver } from './resolution/relationshipResolver';

export class RelationshipVisitor {
    private descriptors: CppRelationshipDescriptor[] = [];
    private diagnostics: ProviderDiagnostic[] = [];
    private knownUnknowns: KnownUnknown[] = [];

    public processNode(node: Parser.SyntaxNode, handle: CppProgramHandle, nameResolver: CppNameResolver, moduleDescriptor: IdentityDescriptor): void {
        try {
            const results = CppRelationshipResolver.resolve(node, handle, nameResolver, moduleDescriptor);
            if (node.type === 'class_specifier' || node.type === 'struct_specifier') {
                results.push(...CppRelationshipResolver.resolveBaseClasses(node, handle, nameResolver, moduleDescriptor));
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
                code: 'CPP-EXT-002',
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
