import Parser = require('node-tree-sitter');

/**
 * True if `fieldDecl` (a field_declaration inside a struct_type's
 * field_declaration_list) is an embedded/anonymous field (`type Dog struct
 * { Animal }`) rather than a named field (`Breed string`) -- confirmed via
 * direct AST dump: an embedded field has only a type reference child and
 * no `field_identifier`, while a named field has both.
 */
export function isEmbeddedField(fieldDecl: Parser.SyntaxNode): boolean {
    return !fieldDecl.namedChildren.some(c => c.type === 'field_identifier');
}

/** The embedded field's type name, unwrapping pointer_type (`*Animal`) the same way a receiver type is unwrapped. */
export function embeddedFieldTypeName(fieldDecl: Parser.SyntaxNode): string | null {
    const typeNode = fieldDecl.namedChildren.find(c => c.type !== 'field_identifier');
    if (!typeNode) {
        return null;
    }
    return unwrapPointerType(typeNode)?.text ?? null;
}

/**
 * Unwraps a pointer_type (`*Animal` -> `Animal`) and, if what remains is a
 * generic_type (`slidingWindow[G]` -> `slidingWindow`), unwraps that too --
 * confirmed via direct testing: a generic receiver like
 * `func (s *slidingWindow[G]) Add(...)` gives a receiver type node whose
 * `.text` is "slidingWindow[G]", which would never match how the struct
 * itself is indexed (by its bare name "slidingWindow"), causing every
 * method on a generic receiver to silently fail to link to its struct.
 */
export function unwrapPointerType(typeNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
    let current: Parser.SyntaxNode | null = typeNode;
    if (current.type === 'pointer_type') {
        current = current.namedChildren[0] ?? null;
    }
    if (current?.type === 'generic_type') {
        current = current.namedChildren[0] ?? null;
    }
    return current;
}

/** A method_declaration's receiver type name (e.g. "Animal" for both `(a Animal)` and `(a *Animal)`), or null if malformed. */
export function receiverTypeName(methodNode: Parser.SyntaxNode): string | null {
    const receiver = methodNode.childForFieldName('receiver');
    const paramDecl = receiver?.namedChildren[0];
    const typeNode = paramDecl?.childForFieldName('type');
    if (!typeNode) {
        return null;
    }
    return unwrapPointerType(typeNode)?.text ?? null;
}

/** A method_declaration's receiver variable name (e.g. "a" in `func (a *Animal) Bark()`), used to detect same-struct calls like `a.Speak()` -- Go has no `this`/`self` keyword, the receiver name is arbitrary per-method. */
export function receiverVarName(methodNode: Parser.SyntaxNode): string | null {
    const receiver = methodNode.childForFieldName('receiver');
    const paramDecl = receiver?.namedChildren[0];
    return paramDecl?.childForFieldName('name')?.text ?? null;
}

/** Nearest enclosing function_declaration or method_declaration, for pruning locals and for CALLS/INSTANTIATES source resolution. */
export function findEnclosingFunctionOrMethod(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
        if (current.type === 'function_declaration' || current.type === 'method_declaration') {
            return current;
        }
        current = current.parent;
    }
    return null;
}

/**
 * True if `node` is nested inside a function/method body -- Go has no
 * anonymous-class-body or local-type-declaration construct of its own to
 * separately detect (local closures/func literals carry no named
 * declarations worth extracting), so this single check covers all of Go's
 * "not a stable package-level member" pruning.
 */
export function isInsideFunctionBody(node: Parser.SyntaxNode): boolean {
    return findEnclosingFunctionOrMethod(node) !== null;
}

/**
 * Go doc comments are `//` line comments immediately preceding a
 * declaration, one sibling node per line (like C#'s `///`, unlike Java's
 * single block comment) -- gathered by walking backward through
 * consecutive comment siblings, stopping at the first blank-line gap
 * (Go's convention: a comment separated from its declaration by a blank
 * line is NOT that declaration's doc comment) or non-comment sibling.
 */
export function goDocFor(node: Parser.SyntaxNode): string | undefined {
    const lines: string[] = [];
    let current = node.previousNamedSibling;
    let nextRow = node.startPosition.row;
    while (current && current.type === 'comment' && current.endPosition.row === nextRow - 1) {
        lines.unshift(current.text.replace(/^\/\/\s?/, ''));
        nextRow = current.startPosition.row;
        current = current.previousNamedSibling;
    }
    const text = lines.join('\n').trim();
    return text.length > 0 ? text : undefined;
}
