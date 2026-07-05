import Parser = require('node-tree-sitter');
import { isInsideAnonymousClassBody, isInsideMethodBody, isMemberTypeDeclaration } from '../astHelpers';

export class DeclarationClassifier {
    public classify(node: Parser.SyntaxNode): 'class' | 'interface' | 'enum' | 'method' | 'variable' | null {
        if (isInsideAnonymousClassBody(node) || isInsideMethodBody(node)) {
            return null; // anonymous-class members and method-body locals (including local classes, via isInsideMethodBody) are pruned entirely
        }

        if (node.type === 'class_declaration' || node.type === 'interface_declaration' || node.type === 'enum_declaration') {
            if (!isMemberTypeDeclaration(node) && node.parent?.type !== 'program') {
                return null; // unrecognized nesting shape -- don't guess
            }
            if (node.type === 'class_declaration') return 'class';
            if (node.type === 'interface_declaration') return 'interface';
            return 'enum';
        }

        if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
            return 'method';
        }

        // A field_declaration node itself isn't the entity -- each of its
        // variable_declarator children is (Java allows `int a, b;`), so
        // field_declaration is handled by the visitor iterating declarators,
        // not classified here.
        return null;
    }
}
