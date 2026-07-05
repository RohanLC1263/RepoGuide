import Parser = require('node-tree-sitter');
import { effectiveParent } from '../astHelpers';

export class DeclarationClassifier {
    public classify(node: Parser.SyntaxNode): 'class' | 'function' | 'method' | 'variable' | null {
        if (node.type === 'class_definition') return 'class';
        if (node.type === 'function_definition' || node.type === 'async_function_definition') {
            return this.isInsideClassBody(node) ? 'method' : 'function';
        }
        // Only a plain `name = value` assignment counts as a "variable" entity --
        // attribute assignment (self.x = ...), tuple/pattern unpacking, and
        // subscript assignment (d[k] = v) are not declarations of a new named
        // symbol in the sense the other entity kinds are. Local variables inside
        // a function body are additionally pruned before classification ever
        // runs (see declarationVisitor.ts's isInsideFunctionBody).
        if (node.type === 'assignment' && node.namedChildren[0]?.type === 'identifier') {
            return 'variable';
        }
        return null;
    }

    private isInsideClassBody(node: Parser.SyntaxNode): boolean {
        // A function_definition's effective parent is a `block`, whose parent is
        // the class_definition when it's a method (as opposed to a module-level
        // function, whose block's parent is the `module` root). Unwraps
        // decorated_definition so a decorated method is still recognized as one.
        const block = effectiveParent(node);
        return block?.type === 'block' && block.parent?.type === 'class_definition';
    }
}
