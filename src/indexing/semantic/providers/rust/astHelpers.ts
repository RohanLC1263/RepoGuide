import Parser = require('node-tree-sitter');

/**
 * Unwraps a generic_type (`Container<T>` -> `Container`, `From<String>` -> `From`)
 * down to its bare type_identifier -- confirmed via direct testing: a
 * generic impl's `type`/`trait` fields give a node whose `.text` includes
 * the type arguments, which never matches how the struct/trait itself is
 * indexed (by its bare name). The same bug class that broke Go's generic
 * receivers, built in here from the start rather than discovered via a
 * failing test.
 */
export function unwrapGenericType(typeNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (typeNode.type === 'generic_type') {
        return typeNode.namedChildren[0] ?? null;
    }
    return typeNode;
}

/** An impl_item's target type name (e.g. "Animal" for both `impl Animal` and `impl Speak for Animal`). */
export function implTypeName(implNode: Parser.SyntaxNode): string | null {
    const typeNode = implNode.childForFieldName('type');
    if (!typeNode) {
        return null;
    }
    return unwrapGenericType(typeNode)?.text ?? null;
}

/** An impl_item's trait name (e.g. "Speak" for `impl Speak for Animal`), or null for an inherent `impl Animal` block. */
export function implTraitName(implNode: Parser.SyntaxNode): string | null {
    const traitNode = implNode.childForFieldName('trait');
    if (!traitNode) {
        return null;
    }
    return unwrapGenericType(traitNode)?.text ?? null;
}

/** True if `funcNode` (a function_item) takes a `self`/`&self`/`&mut self` parameter -- Rust's only syntactic signal distinguishing a "method" from an "associated function", both of which are function_items inside an impl block. */
export function isSelfMethod(funcNode: Parser.SyntaxNode): boolean {
    const params = funcNode.childForFieldName('parameters');
    return params?.namedChildren[0]?.type === 'self_parameter';
}

/** Nearest enclosing impl_item or trait_item, for linking a function_item to its owning type/trait and for qualifiedName nesting. */
export function findEnclosingImplOrTrait(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
        if (current.type === 'impl_item' || current.type === 'trait_item') {
            return current;
        }
        current = current.parent;
    }
    return null;
}

/** Nearest enclosing function_item, for pruning locals and as the CALLS/INSTANTIATES source. */
export function findEnclosingFunction(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
        if (current.type === 'function_item') {
            return current;
        }
        current = current.parent;
    }
    return null;
}

/**
 * True if `node` is nested inside a function body -- Rust has no
 * anonymous-class-body or local-type-declaration construct of its own to
 * separately detect (closures carry no named declarations worth
 * extracting), so this single check covers all of Rust's "not a stable
 * module-level member" pruning, the same as Go's.
 */
export function isInsideFunctionBody(node: Parser.SyntaxNode): boolean {
    return findEnclosingFunction(node) !== null;
}

/**
 * Rust doc comments (`///`) are separate sibling `line_comment` nodes per
 * line (like C#'s `///` and Go's `//`), gathered by walking backward
 * through consecutive comment siblings, stopping at the first blank-line
 * gap or non-`///`-prefixed sibling.
 */
export function rustDocFor(node: Parser.SyntaxNode): string | undefined {
    const lines: string[] = [];
    let current = node.previousNamedSibling;
    let nextRow = node.startPosition.row;
    // Adjacency is checked via startPosition, not endPosition -- confirmed
    // via direct testing that a line_comment's endPosition.row includes its
    // trailing newline (spilling onto the *next* row), unlike the
    // assumption carried over from Go/C#'s comment handling. Using
    // endPosition here would silently reject every real doc comment.
    while (current && current.type === 'line_comment' && current.text.startsWith('///') && current.startPosition.row === nextRow - 1) {
        lines.unshift(current.text.replace(/^\/\/\/\s?/, ''));
        nextRow = current.startPosition.row;
        current = current.previousNamedSibling;
    }
    const text = lines.join('\n').trim();
    return text.length > 0 ? text : undefined;
}
