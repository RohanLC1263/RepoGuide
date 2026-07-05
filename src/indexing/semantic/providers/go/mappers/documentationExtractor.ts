import Parser = require('node-tree-sitter');
import { goDocFor } from '../astHelpers';

export class DocumentationExtractor {
    public extract(node: Parser.SyntaxNode): string | undefined {
        return goDocFor(node);
    }
}
