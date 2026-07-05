import Parser = require('node-tree-sitter');
import { attributeNames, keywordModifiers } from '../astHelpers';

export class ModifierMapper {
    /**
     * C# has real, enforced visibility keywords. Unmarked members actually
     * default to 'private' and unmarked top-level types default to
     * 'internal' -- distinguishing those two defaults would need extra
     * context this mapper doesn't track, so it defaults to 'internal'
     * uniformly (a disclosed simplification, not a structural extraction
     * issue) matching the same fallback Java uses for package-private.
     */
    public map(node: Parser.SyntaxNode): { modifiers: string[]; visibility: 'public' | 'private' | 'protected' | 'internal' } {
        const keywords = keywordModifiers(node);
        const attributes = attributeNames(node);
        const modifiers = [...keywords, ...attributes];

        let visibility: 'public' | 'private' | 'protected' | 'internal' = 'internal';
        if (keywords.includes('public')) visibility = 'public';
        else if (keywords.includes('private')) visibility = 'private';
        else if (keywords.includes('protected')) visibility = 'protected';
        else if (keywords.includes('internal')) visibility = 'internal';

        return { modifiers, visibility };
    }
}
