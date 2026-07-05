import Parser = require('node-tree-sitter');

/**
 * Recursively unwraps a `qualified_identifier` (`ns::Foo` -> `Foo`) and a
 * `template_type` (`Wrapper<int>` -> `Wrapper`) down to the bare name node --
 * confirmed via direct testing to be the same bug class that broke Go's and
 * Rust's generics, but with an extra wrinkle neither of those hit: a
 * namespace-qualified template reference nests as
 * `qualified_identifier(scope, name: template_type(name, arguments))`,
 * requiring recursion, not a single unwrap.
 */
export function unwrapTypeReference(node: Parser.SyntaxNode): Parser.SyntaxNode {
    if (node.type === 'qualified_identifier') {
        const name = node.childForFieldName('name');
        return name ? unwrapTypeReference(name) : node;
    }
    if (node.type === 'template_type') {
        const name = node.childForFieldName('name');
        return name ? unwrapTypeReference(name) : node;
    }
    return node;
}

/**
 * Recursively unwraps `pointer_declarator`/`reference_declarator` wrappers
 * (from a method returning `Type*`/`Type&`) down to the real
 * `function_declarator` -- confirmed via direct testing that a
 * `reference_declarator`'s inner declarator has NO working field name
 * (`childForFieldName('declarator')` returns undefined for it, unlike
 * `pointer_declarator` where it works), so this falls back to
 * `namedChildren[0]` positionally for that one case.
 */
export function unwrapDeclarator(node: Parser.SyntaxNode | null | undefined): Parser.SyntaxNode | null {
    let current: Parser.SyntaxNode | null | undefined = node;
    while (current && (current.type === 'pointer_declarator' || current.type === 'reference_declarator')) {
        current = current.childForFieldName('declarator') ?? current.namedChildren[0] ?? null;
    }
    return current ?? null;
}

/** The nearest enclosing class_specifier/struct_specifier, for linking an in-class member to its owning type and for qualifiedName nesting. */
export function findEnclosingClass(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
        if (current.type === 'class_specifier' || current.type === 'struct_specifier') {
            return current;
        }
        current = current.parent;
    }
    return null;
}

/** Nearest enclosing function_definition, for pruning locals and as the CALLS/INSTANTIATES source. */
export function findEnclosingFunction(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
        if (current.type === 'function_definition') {
            return current;
        }
        current = current.parent;
    }
    return null;
}

/** True if `node` is nested inside a function body -- prunes local classes/functions/variables, real (if uncommon) legal C++. */
export function isInsideFunctionBody(node: Parser.SyntaxNode): boolean {
    return findEnclosingFunction(node) !== null;
}

/**
 * The dotted (`::`-joined) enclosing namespace path for `node`, e.g. "cpr"
 * or "cpr::detail" -- C++ namespaces nest and can differ per top-level item
 * within the same file (unlike Go's/Rust's whole-file package/crate path),
 * so this is computed per-declaration by walking namespace_definition
 * ancestors, not cached once per file.
 */
export function namespacePathOf(node: Parser.SyntaxNode): string {
    const segments: string[] = [];
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
        if (current.type === 'namespace_definition') {
            const nameNode = current.childForFieldName('name');
            if (nameNode) {
                segments.unshift(nameNode.text);
            }
        }
        current = current.parent;
    }
    return segments.join('::');
}

/**
 * A function_declarator's own name node -- `identifier` (free function,
 * constructor), `field_identifier` (regular in-class method),
 * `qualified_identifier` (out-of-class `Class::method` definition), or
 * `destructor_name` (wraps an `identifier`, e.g. `~Cookie`). Confirmed via
 * direct testing that constructor/destructor PROTOTYPES (no body) use a
 * plain `declaration` node, not `field_declaration` like every other
 * in-class member -- a real, non-obvious distinction, not assumed to be
 * uniform.
 */
export function functionDeclaratorName(functionDeclarator: Parser.SyntaxNode): string | null {
    let nameNode: Parser.SyntaxNode | null | undefined = functionDeclarator.childForFieldName('declarator');
    // A qualified_identifier's OWN .text is the full "Class::method" path --
    // only its `name` field is the bare method name. Confirmed as a real
    // bug via direct testing: using .text directly here produced
    // "Cookie.Cookie::GetDomain" double-qualified qualifiedNames instead of
    // "Cookie.GetDomain".
    while (nameNode && nameNode.type === 'qualified_identifier') {
        nameNode = nameNode.childForFieldName('name');
    }
    return nameNode?.text ?? null;
}

/** True if a function_declarator's name is a qualified_identifier (an out-of-class `Class::method` definition). */
export function isOutOfClassDefinition(functionDeclarator: Parser.SyntaxNode): boolean {
    return functionDeclarator.childForFieldName('declarator')?.type === 'qualified_identifier';
}

/**
 * C++ has one `comment` node type for both `//` line comments and slash-star
 * block comments (unlike Rust's/Go's split types), confirmed via direct
 * testing. The initial adjacency check must use `endPosition` (where the
 * comment actually finishes), not `startPosition` -- a real, distinct bug
 * from the Rust pass's endPosition-includes-trailing-newline issue: here a
 * multi-line slash-star block comment's *start* row can be many lines
 * before the declaration it documents, confirmed via a real false-negative
 * against cpr's own multi-line constructor doc comments. Once a doc comment
 * is confirmed present, consecutive `//` comments are still chained
 * backward via startPosition (each spans exactly one row, so start and end
 * coincide there).
 */
export function cppDocFor(node: Parser.SyntaxNode): string | undefined {
    const prev = node.previousNamedSibling;
    if (!prev || prev.type !== 'comment' || prev.endPosition.row !== node.startPosition.row - 1) {
        return undefined;
    }
    if (prev.text.startsWith('//')) {
        const lines: string[] = [];
        let current: Parser.SyntaxNode | null = prev;
        let nextRow = node.startPosition.row;
        while (current && current.type === 'comment' && current.text.startsWith('//') && current.startPosition.row === nextRow - 1) {
            lines.unshift(current.text.replace(/^\/\/\/?\s?/, ''));
            nextRow = current.startPosition.row;
            current = current.previousNamedSibling;
        }
        const text = lines.join('\n').trim();
        return text.length > 0 ? text : undefined;
    }
    const stripped = prev.text
        .replace(/^\/\*+/, '')
        .replace(/\*+\/$/, '')
        .split('\n')
        .map(line => line.replace(/^\s*\*\s?/, ''))
        .join('\n')
        .trim();
    return stripped.length > 0 ? stripped : undefined;
}
