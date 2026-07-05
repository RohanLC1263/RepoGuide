import Parser = require('node-tree-sitter');

const NAMED_TYPE_DECLARATIONS = new Set(['class_declaration', 'interface_declaration', 'struct_declaration', 'record_declaration', 'enum_declaration']);
const MEMBER_CONTAINER_TYPES = new Set(['declaration_list', 'enum_member_declaration_list']);

/**
 * True if `node` is a class/struct/interface/record/enum declared directly
 * as a member of an enclosing type (declaration_list) -- a stable,
 * addressable nested type, distinguished later only by a 'static'/'partial'
 * modifier flag, not by inclusion.
 */
export function isMemberTypeDeclaration(node: Parser.SyntaxNode): boolean {
    return NAMED_TYPE_DECLARATIONS.has(node.type) && !!node.parent && MEMBER_CONTAINER_TYPES.has(node.parent.type);
}

/**
 * True if `node` is nested inside a method/constructor/local-function body.
 * Unlike Java, C# has no anonymous-class-body construct to separately
 * detect (object initializers like `new { X = 1 }` carry no nested method
 * declarations), so this single check covers all "not a stable, addressable
 * member" pruning: local variables, local functions, and any local type
 * declaration.
 */
export function isInsideMethodBody(node: Parser.SyntaxNode): boolean {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
        if (current.type === 'method_declaration' || current.type === 'constructor_declaration' || current.type === 'local_function_statement') {
            return true;
        }
        current = current.parent;
    }
    return false;
}

/**
 * C#'s modifiers are separate sibling `modifier` nodes (e.g. `public`,
 * `partial`, `static`), unlike Java's single wrapping `modifiers` node --
 * collected by filtering namedChildren directly.
 */
export function keywordModifiers(node: Parser.SyntaxNode): string[] {
    return node.namedChildren.filter(c => c.type === 'modifier').map(c => c.text);
}

/** Attribute names (e.g. "Obsolete", "MethodImpl") attached to `node`, without the brackets -- C#'s counterpart to Java's annotations. */
export function attributeNames(node: Parser.SyntaxNode): string[] {
    const names: string[] = [];
    for (const child of node.namedChildren) {
        if (child.type !== 'attribute_list') {
            continue;
        }
        for (const attr of child.namedChildren) {
            if (attr.type === 'attribute') {
                const name = attr.childForFieldName('name');
                if (name) {
                    names.push(name.text);
                }
            }
        }
    }
    return names;
}

/**
 * method_declaration's return-type node -- neither a `returns` nor `type`
 * field resolves reliably for this node type (confirmed via direct
 * testing), so this finds it positionally: the first namedChild that
 * isn't an attribute_list/modifier (those always precede the return type,
 * which itself always precedes the `name` identifier).
 */
export function methodReturnTypeNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    return node.namedChildren.find(c => c.type !== 'attribute_list' && c.type !== 'modifier' && c.type !== 'type_parameter_list') ?? null;
}

/** Nearest enclosing named type declaration (class/struct/interface/record/enum), for qualifiedName nesting. */
export function findEnclosingTypeDeclaration(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
        if (NAMED_TYPE_DECLARATIONS.has(current.type)) {
            return current;
        }
        current = current.parent;
    }
    return null;
}

/**
 * XML doc comment text (stripped of `///` prefixes and common XML tags),
 * if `node` has one or more consecutive `///`-prefixed line comments
 * immediately preceding it -- C# gives each `///` line its own sibling
 * `comment` node (unlike Java's single `/** *\/` block comment), so this
 * walks backward gathering them before stopping at the first non-`///` or
 * non-comment sibling.
 */
export function xmlDocFor(node: Parser.SyntaxNode): string | undefined {
    const lines: string[] = [];
    let current = node.previousNamedSibling;
    while (current && current.type === 'comment' && current.text.startsWith('///')) {
        lines.unshift(current.text.replace(/^\/\/\/\s?/, ''));
        current = current.previousNamedSibling;
    }
    if (lines.length === 0) {
        return undefined;
    }
    const text = lines
        .join('\n')
        .replace(/<\/?[a-zA-Z][^>]*>/g, '')
        .split('\n')
        .map(line => line.trim())
        .join('\n')
        .trim();
    return text.length > 0 ? text : undefined;
}
