import Parser = require('node-tree-sitter');
import { KnownUnknown, ProviderDiagnostic } from '../../semanticProviderContract';
import { IdentityDescriptor, RustProgramHandle } from './internalModels';
import { RustNameResolver } from './resolution/nameResolver';
import { RustRelationshipDescriptor, RustRelationshipResolver } from './resolution/relationshipResolver';

export class RelationshipVisitor {
    private descriptors: RustRelationshipDescriptor[] = [];
    private diagnostics: ProviderDiagnostic[] = [];
    private knownUnknowns: KnownUnknown[] = [];

    public processNode(node: Parser.SyntaxNode, handle: RustProgramHandle, nameResolver: RustNameResolver, moduleDescriptor: IdentityDescriptor): void {
        try {
            const results = RustRelationshipResolver.resolve(node, handle, nameResolver, moduleDescriptor);
            if (node.type === 'impl_item' && node.childForFieldName('trait')) {
                results.push(...RustRelationshipResolver.resolveImplements(node, handle, nameResolver, moduleDescriptor));
            }
            if (node.type === 'trait_item') {
                results.push(...RustRelationshipResolver.resolveSupertraits(node, handle, nameResolver));
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
                code: 'RUST-EXT-002',
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
