import Parser = require('node-tree-sitter');
import { IdentityDescriptor, GoProgramHandle } from './internalModels';
import { DeclarationVisitor } from './declarationVisitor';
import { RelationshipVisitor } from './relationshipVisitor';
import { GoNameResolver } from './resolution/nameResolver';

export class SemanticAstWalker {
    constructor(
        private declarationVisitor: DeclarationVisitor,
        private relationshipVisitor: RelationshipVisitor
    ) {}

    public walk(handle: GoProgramHandle, nameResolver: GoNameResolver, moduleDescriptor: IdentityDescriptor): void {
        const visitNode = (node: Parser.SyntaxNode) => {
            this.declarationVisitor.processNode(node, handle);
            this.relationshipVisitor.processNode(node, handle, nameResolver, moduleDescriptor);
            for (const child of node.namedChildren) {
                visitNode(child);
            }
        };
        for (const child of handle.tree.rootNode.namedChildren) {
            visitNode(child);
        }
    }
}
