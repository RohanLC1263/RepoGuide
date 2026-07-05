import Parser = require('node-tree-sitter');
import { KnownUnknown, ProviderDiagnostic } from '../../semanticProviderContract';
import { IdentityDescriptor, GoProgramHandle } from './internalModels';
import { GoNameResolver } from './resolution/nameResolver';
import { GoRelationshipDescriptor, GoRelationshipResolver } from './resolution/relationshipResolver';

export class RelationshipVisitor {
    private descriptors: GoRelationshipDescriptor[] = [];
    private diagnostics: ProviderDiagnostic[] = [];
    private knownUnknowns: KnownUnknown[] = [];

    public processNode(node: Parser.SyntaxNode, handle: GoProgramHandle, nameResolver: GoNameResolver, moduleDescriptor: IdentityDescriptor): void {
        try {
            const results = GoRelationshipResolver.resolve(node, handle, nameResolver, moduleDescriptor);
            if (node.type === 'type_declaration') {
                for (const spec of node.namedChildren) {
                    if (spec.type === 'type_spec') {
                        results.push(...GoRelationshipResolver.resolveEmbedding(spec, handle, nameResolver, moduleDescriptor));
                    }
                }
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
                code: 'GO-EXT-002',
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
