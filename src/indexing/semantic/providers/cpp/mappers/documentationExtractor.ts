import Parser = require('node-tree-sitter');
import { cppDocFor } from '../astHelpers';

export class DocumentationExtractor {
    public extract(node: Parser.SyntaxNode): string | undefined {
        return cppDocFor(node);
    }
}
