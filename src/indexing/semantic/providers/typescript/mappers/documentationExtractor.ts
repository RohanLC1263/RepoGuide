import * as ts from 'typescript';

export class DocumentationExtractor {
    public extract(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
        const jsDoc = ts.getJSDocTags(node);
        // Sometimes getJSDocTags returns tags, but not the full comment.
        // A better approach is to check if the node has JSDoc comments attached in the AST.
        const jsDocComments = (node as any).jsDoc;
        if (jsDocComments && jsDocComments.length > 0) {
            const commentNode = jsDocComments[0];
            const text = sourceFile.text.substring(commentNode.pos, commentNode.end).trim();
            return text;
        }
        return undefined;
    }
}
