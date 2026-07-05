import Parser = require('node-tree-sitter');

export class LocationMapper {
    public map(node: Parser.SyntaxNode): { startLine: number; endLine: number } {
        // tree-sitter's startPosition/endPosition rows are 0-based; the rest of
        // RepoGuide's location fields (see DeclarationLocation) are 1-based.
        return {
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1
        };
    }
}
