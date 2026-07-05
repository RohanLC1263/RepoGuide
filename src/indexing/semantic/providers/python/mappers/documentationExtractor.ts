import Parser = require('node-tree-sitter');

export class DocumentationExtractor {
    /**
     * Python's docstring convention: the first statement in a class/function
     * body, if it's a bare string-literal expression statement. Same pattern
     * already proven in src/comprehension/staticAnalyzer.ts's extractDocstring.
     */
    public extract(node: Parser.SyntaxNode): string | undefined {
        const block = node.childForFieldName('body');
        if (!block || block.namedChildCount === 0) {
            return undefined;
        }
        const first = block.namedChild(0);
        if (!first || first.type !== 'expression_statement') {
            return undefined;
        }
        const expr = first.namedChild(0);
        if (!expr || expr.type !== 'string') {
            return undefined;
        }
        const stringContent = expr.namedChildren.find(c => c.type === 'string_content');
        return stringContent ? stringContent.text.trim() : undefined;
    }
}
