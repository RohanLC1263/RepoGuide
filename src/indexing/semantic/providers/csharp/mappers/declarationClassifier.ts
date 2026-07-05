import Parser = require('node-tree-sitter');
import { isInsideMethodBody, isMemberTypeDeclaration } from '../astHelpers';

export class DeclarationClassifier {
    public classify(node: Parser.SyntaxNode): 'class' | 'interface' | 'enum' | 'method' | 'variable' | null {
        if (isInsideMethodBody(node)) {
            return null; // method-body locals (variables, local functions, local types) are pruned entirely
        }

        if (node.type === 'class_declaration' || node.type === 'struct_declaration' || node.type === 'interface_declaration' || node.type === 'record_declaration' || node.type === 'enum_declaration') {
            // A class/struct/interface/record/enum is extractable when it's
            // either a real member of an enclosing type (isMemberTypeDeclaration,
            // which also covers a type nested in a block-scoped namespace's own
            // declaration_list) or a top-level sibling of a file-scoped namespace
            // declaration directly under compilation_unit. Anything else is an
            // unrecognized nesting shape -- don't guess.
            if (!isMemberTypeDeclaration(node) && node.parent?.type !== 'compilation_unit') {
                return null;
            }
            if (node.type === 'interface_declaration') return 'interface';
            if (node.type === 'enum_declaration') return 'enum';
            // struct/record/class all map to 'class' -- no schema distinction needed,
            // matching how Go's type_declaration already maps struct-shaped types to 'class'.
            return 'class';
        }

        if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
            return 'method';
        }

        // property_declaration and field_declaration aren't classified here --
        // property_declaration maps 1:1 to a 'variable' entity but field_declaration
        // can have multiple variable_declarator children (`int a, b;`), so both
        // are handled by the visitor directly, matching Java's field_declaration handling.
        return null;
    }
}
