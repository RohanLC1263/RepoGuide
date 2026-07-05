import Parser = require('node-tree-sitter');
import { rustDocFor } from '../astHelpers';

export class DocumentationExtractor {
    public extract(node: Parser.SyntaxNode): string | undefined {
        return rustDocFor(node);
    }
}
