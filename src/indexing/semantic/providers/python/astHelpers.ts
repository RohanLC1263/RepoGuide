import Parser = require('node-tree-sitter');

/**
 * A decorated function/class's true structural parent is the `decorated_definition`
 * wrapper node, not the containing block -- this unwraps it so callers see the
 * same "effective parent" whether or not the definition is decorated, and don't
 * double-count the wrapper as a nesting level (which would corrupt qualifiedName
 * construction and class-body-membership checks).
 */
export function effectiveParent(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    const parent = node.parent;
    if (parent?.type === 'decorated_definition') {
        return parent.parent;
    }
    return parent;
}

/** The `decorated_definition` wrapper, if `node` is decorated, else null. */
export function decoratedWrapper(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    return node.parent?.type === 'decorated_definition' ? node.parent : null;
}

/**
 * Decorator names as written (e.g. "staticmethod", "app.get"), stripped of the
 * call-argument portion (e.g. "app.get" from "@app.get(\"/items\")") -- decorator
 * identity matters for signature hashing (see resolution/identityDescriptorBuilder.ts)
 * because @overload/@property/@staticmethod/@classmethod change effective
 * signature semantics in ways invisible any other way without a type checker.
 */
export function decoratorNames(node: Parser.SyntaxNode): string[] {
    const wrapper = decoratedWrapper(node);
    if (!wrapper) {
        return [];
    }
    const names: string[] = [];
    for (const child of wrapper.namedChildren) {
        if (child.type !== 'decorator') {
            continue;
        }
        // decorator := '@' (identifier | attribute | call)
        let target = child.namedChildren[0];
        if (target?.type === 'call') {
            target = target.childForFieldName('function') ?? target.namedChildren[0];
        }
        if (target) {
            names.push(target.text);
        }
    }
    return names;
}

/** Finds the nearest ancestor `class_definition`/`function_definition`/`async_function_definition`, unwrapping decorated_definition wrappers. */
export function findEnclosingDefinition(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    let current = effectiveParent(node);
    while (current) {
        if (current.type === 'class_definition' || current.type === 'function_definition' || current.type === 'async_function_definition') {
            return current;
        }
        current = effectiveParent(current);
    }
    return null;
}
