import Parser = require('node-tree-sitter');
import { IdentityDescriptor, JavaProgramHandle } from './internalModels';
import { DeclarationVisitor } from './declarationVisitor';
import { RelationshipVisitor } from './relationshipVisitor';
import { JavaNameResolver } from './resolution/nameResolver';

export class SemanticAstWalker {
    constructor(
        private declarationVisitor: DeclarationVisitor,
        private relationshipVisitor: RelationshipVisitor
    ) {}

    public walk(handle: JavaProgramHandle, nameResolver: JavaNameResolver, moduleDescriptor: IdentityDescriptor): void {
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
