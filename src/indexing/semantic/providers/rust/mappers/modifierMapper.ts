import Parser = require('node-tree-sitter');

/**
 * Rust has real visibility syntax (`pub`, `pub(crate)`, `pub(super)`,
 * `pub(in path)`), unlike Go's pure capitalization convention. No
 * modifier at all is Rust's true default: module-private. `pub` maps to
 * 'public'; any restricted `pub(...)` form maps to 'internal' as the
 * closest fit (visible beyond the immediate module, but not fully public).
 */
export class ModifierMapper {
    public map(node: Parser.SyntaxNode): { modifiers: string[]; visibility: 'public' | 'private' | 'protected' | 'internal' } {
        const visNode = node.namedChildren.find(c => c.type === 'visibility_modifier');
        if (!visNode) {
            return { modifiers: [], visibility: 'private' };
        }
        const text = visNode.text;
        const visibility: 'public' | 'private' | 'protected' | 'internal' = text === 'pub' ? 'public' : 'internal';
        return { modifiers: [text], visibility };
    }
}
