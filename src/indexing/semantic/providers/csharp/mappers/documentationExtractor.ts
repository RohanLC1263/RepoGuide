import Parser = require('node-tree-sitter');
import { xmlDocFor } from '../astHelpers';

export class DocumentationExtractor {
    public extract(node: Parser.SyntaxNode): string | undefined {
        return xmlDocFor(node);
    }
}
