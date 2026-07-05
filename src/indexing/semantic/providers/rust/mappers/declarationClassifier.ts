import Parser = require('node-tree-sitter');
import { findEnclosingImplOrTrait, isInsideFunctionBody } from '../astHelpers';

/**
 * Like Go, Rust has no nested-declaration concept for types (struct/enum/
 * trait items are always module-level, never nested inside another type's
 * own declaration) -- but function_item is used for both a real method
 * (inside an impl/trait block) and a plain module-level function,
 * distinguished only by whether it has an enclosing impl_item/trait_item,
 * not by self_parameter (an associated function like `fn new(...)` has no
 * self but is still "method"-shaped -- declared inside an impl block,
 * matching Java's static-method precedent).
 */
export class DeclarationClassifier {
    public classify(node: Parser.SyntaxNode): 'class' | 'interface' | 'enum' | 'function' | 'method' | null {
        if (isInsideFunctionBody(node)) {
            return null; // local closures/vars inside a body are pruned entirely
        }
        if (node.type === 'struct_item') return 'class';
        if (node.type === 'enum_item') return 'enum';
        if (node.type === 'trait_item') return 'interface';
        if (node.type === 'function_item') {
            return findEnclosingImplOrTrait(node) ? 'method' : 'function';
        }
        return null;
    }
}
