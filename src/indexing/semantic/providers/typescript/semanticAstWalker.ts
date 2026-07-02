import * as ts from 'typescript';
import { ProgramHandle } from './internalModels';
import { DeclarationVisitor } from './declarationVisitor';
import { RelationshipVisitor } from './relationshipVisitor';

export class SemanticAstWalker {
    constructor(
        private declarationVisitor: DeclarationVisitor,
        private relationshipVisitor: RelationshipVisitor
    ) {}

    public walk(handle: ProgramHandle): void {
        const sourceFile = handle.sourceFile;
        const visitNode = (node: ts.Node) => {
            this.declarationVisitor.processNode(node, handle);
            this.relationshipVisitor.processNode(node, handle);
            ts.forEachChild(node, visitNode);
        };
        ts.forEachChild(sourceFile, visitNode);
    }
}
