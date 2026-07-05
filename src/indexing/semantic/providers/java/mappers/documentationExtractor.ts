import Parser = require('node-tree-sitter');
import { javadocFor } from '../astHelpers';

export class DocumentationExtractor {
    public extract(node: Parser.SyntaxNode): string | undefined {
        return javadocFor(node);
    }
}
