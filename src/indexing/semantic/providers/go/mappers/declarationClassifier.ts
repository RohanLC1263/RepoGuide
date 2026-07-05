import Parser = require('node-tree-sitter');
import { isInsideFunctionBody } from '../astHelpers';

/**
 * Unlike Java/C#/Python, Go has no nested-declaration concept at all --
 * every type/function/method/var/const is a direct package-level
 * declaration (methods aren't nested inside their struct's declaration;
 * there's no "is this a real member vs. a local" ambiguity to resolve
 * beyond "is this inside a function/method body"). So this classifier is
 * simpler than every previous language's: it only needs to prune
 * function-body locals, not reason about containment.
 */
export class DeclarationClassifier {
    public classify(node: Parser.SyntaxNode): 'function' | 'method' | null {
        if (isInsideFunctionBody(node)) {
            return null; // local funcs/closures/vars inside a body are pruned entirely
        }
        if (node.type === 'function_declaration') return 'function';
        if (node.type === 'method_declaration') return 'method';
        return null;
    }
}
