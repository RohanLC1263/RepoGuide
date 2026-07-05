import Parser = require('node-tree-sitter');

export class LocationMapper {
    public map(node: Parser.SyntaxNode): { startLine: number; endLine: number } {
        return {
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1
        };
    }
}
