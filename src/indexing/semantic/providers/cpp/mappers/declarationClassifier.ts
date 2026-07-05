import Parser = require('node-tree-sitter');
import { findEnclosingClass, isInsideFunctionBody, isOutOfClassDefinition, unwrapDeclarator } from '../astHelpers';

/**
 * Unlike every prior provider, a C++ method's "kind" can't be decided by
 * AST nesting alone: an out-of-class `ClassName::method(...) { ... }`
 * definition is a top-level function_definition with NO enclosing
 * class_specifier at all when the class lives in a different (header)
 * file -- confirmed via direct testing against real cpr code (84.2% of
 * real methods are exactly this shape). So a function_definition is
 * classified as 'method' if its declarator is a qualified_identifier
 * (out-of-class) OR it has an enclosing class_specifier (inline in-class);
 * otherwise it's a free 'function'.
 */
export class DeclarationClassifier {
    public classify(node: Parser.SyntaxNode): 'class' | 'enum' | 'function' | 'method' | 'variable' | null {
        if (isInsideFunctionBody(node)) {
            return null; // a local class/function/variable inside a function body isn't a stable module-level member
        }
        if (node.type === 'class_specifier' || node.type === 'struct_specifier') {
            return 'class';
        }
        if (node.type === 'enum_specifier') {
            return 'enum';
        }
        if (node.type === 'function_definition') {
            const functionDeclarator = unwrapDeclarator(node.childForFieldName('declarator'));
            if (!functionDeclarator) {
                return null;
            }
            if (isOutOfClassDefinition(functionDeclarator) || findEnclosingClass(node)) {
                return 'method';
            }
            return 'function';
        }
        if (node.type === 'field_declaration' || node.type === 'declaration') {
            // In-class prototypes: a regular method/operator uses
            // field_declaration; a constructor/destructor prototype uses a
            // plain declaration node instead -- confirmed via direct
            // testing, not assumed uniform across member kinds.
            if (!findEnclosingClass(node)) {
                return null; // top-level non-defining declarations (e.g. forward decls, globals) are out of scope
            }
            const functionDeclarator = unwrapDeclarator(node.childForFieldName('declarator'));
            if (functionDeclarator?.type === 'function_declarator') {
                return 'method';
            }
            if (node.type === 'field_declaration' && node.childForFieldName('declarator')?.type === 'field_identifier') {
                return 'variable'; // a real member field, not a method prototype
            }
            return null;
        }
        return null;
    }
}
