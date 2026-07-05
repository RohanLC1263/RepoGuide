import Parser = require('node-tree-sitter');
import { findEnclosingClass } from '../astHelpers';

/**
 * C++ visibility is fundamentally different from every prior provider's
 * per-node modifier: it's a per-SECTION label (`public:`/`private:`/
 * `protected:`) that applies to every member until the next label, not an
 * attribute on the member itself. Resolved by walking backward through
 * sibling nodes for the nearest preceding access_specifier, falling back to
 * C++'s real default-access rule (private for `class`, public for `struct`)
 * when a member appears before any label. Top-level (non-member)
 * declarations have no access_specifier concept at all; `static` at
 * namespace scope is C++'s real (if different-shaped) analog to
 * file-internal linkage, mapped to 'internal' as the closest fit.
 */
export class ModifierMapper {
    public map(node: Parser.SyntaxNode): { modifiers: string[]; visibility: 'public' | 'private' | 'protected' | 'internal' } {
        const enclosingClass = findEnclosingClass(node);
        if (enclosingClass) {
            let current = node.previousNamedSibling;
            while (current) {
                if (current.type === 'access_specifier') {
                    const text = current.text as 'public' | 'private' | 'protected';
                    return { modifiers: [text], visibility: text };
                }
                current = current.previousNamedSibling;
            }
            const defaultVisibility = enclosingClass.type === 'struct_specifier' ? 'public' : 'private';
            return { modifiers: [], visibility: defaultVisibility };
        }
        const isStatic = node.namedChildren.some(c => c.type === 'storage_class_specifier' && c.text === 'static');
        return { modifiers: isStatic ? ['static'] : [], visibility: isStatic ? 'internal' : 'public' };
    }
}
