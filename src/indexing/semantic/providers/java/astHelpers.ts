import Parser = require('node-tree-sitter');

const NAMED_TYPE_DECLARATIONS = new Set(['class_declaration', 'interface_declaration', 'enum_declaration']);
const MEMBER_CONTAINER_TYPES = new Set(['class_body', 'interface_body', 'enum_body', 'enum_body_declarations']);

/**
 * True if `node` is a class/interface/enum declared directly as a member of
 * an enclosing type (class_body/interface_body/enum_body) -- a stable,
 * addressable nested type, static or instance, distinguished later only by
 * a 'static' modifier flag, not by inclusion.
 */
export function isMemberTypeDeclaration(node: Parser.SyntaxNode): boolean {
    return NAMED_TYPE_DECLARATIONS.has(node.type) && !!node.parent && MEMBER_CONTAINER_TYPES.has(node.parent.type);
}

/**
 * True if `node` is (or is nested inside) an anonymous class body --
 * `new X() { ... }` parses its body as a plain class_body whose parent is
 * object_creation_expression, structurally identical to a real named
 * class's body but with no stable name/identity worth assigning.
 */
export function isInsideAnonymousClassBody(node: Parser.SyntaxNode): boolean {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
        if (current.type === 'class_body' && current.parent?.type === 'object_creation_expression') {
            return true;
        }
        current = current.parent;
    }
    return false;
}

/** True if `node` is nested inside a method_declaration/constructor_declaration body (a local variable/class/etc, not a member). */
export function isInsideMethodBody(node: Parser.SyntaxNode): boolean {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
        if (current.type === 'method_declaration' || current.type === 'constructor_declaration') {
            return true;
        }
        current = current.parent;
    }
    return false;
}

/**
 * The `modifiers` node (annotations + visibility/static/final/abstract
 * keywords), if present -- always the first named child of a declaration
 * when present, but childForFieldName('modifiers') is not reliable across
 * all declaration node types, so this checks positionally instead.
 */
export function modifiersNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    const first = node.namedChildren[0];
    return first?.type === 'modifiers' ? first : null;
}

/** Annotation names (e.g. "Override", "Deprecated") attached to `node`, without the '@'. */
export function annotationNames(node: Parser.SyntaxNode): string[] {
    const mods = modifiersNode(node);
    if (!mods) {
        return [];
    }
    const names: string[] = [];
    for (const child of mods.namedChildren) {
        if (child.type === 'marker_annotation' || child.type === 'annotation') {
            const name = child.childForFieldName('name');
            if (name) {
                names.push(name.text);
            }
        }
    }
    return names;
}

/** Keyword modifiers (public/private/protected/static/final/abstract/...) attached to `node`, as raw text. */
export function keywordModifiers(node: Parser.SyntaxNode): string[] {
    const mods = modifiersNode(node);
    if (!mods) {
        return [];
    }
    return mods.children
        .filter(c => !c.isNamed)
        .map(c => c.text)
        .filter(t => t.length > 0);
}

/** Nearest enclosing named type declaration (class/interface/enum), for qualifiedName nesting -- skips anonymous/local wrappers. */
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

/** JavaDoc text (without the /** *\/ delimiters), if `node`'s immediately preceding sibling is a JavaDoc block comment. */
export function javadocFor(node: Parser.SyntaxNode): string | undefined {
    const prev = node.previousNamedSibling;
    if (!prev || prev.type !== 'block_comment' || !prev.text.startsWith('/**')) {
        return undefined;
    }
    const inner = prev.text.slice(3, -2);
    const lines = inner.split('\n').map(line => line.replace(/^\s*\*\s?/, '').trim());
    const text = lines.join('\n').trim();
    return text.length > 0 ? text : undefined;
}
