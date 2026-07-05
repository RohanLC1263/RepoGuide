import Parser = require('node-tree-sitter');
import { annotationNames, keywordModifiers } from '../astHelpers';

export class ModifierMapper {
    /**
     * Java has real, enforced visibility keywords -- unlike Python's
     * underscore convention, this isn't a heuristic. Package-private (no
     * keyword at all) has no direct equivalent in the shared visibility
     * union, so it maps to 'internal' as the closest semantic fit (scoped
     * below public, but not a real private/protected).
     */
    public map(node: Parser.SyntaxNode): { modifiers: string[]; visibility: 'public' | 'private' | 'protected' | 'internal' } {
        const keywords = keywordModifiers(node);
        const annotations = annotationNames(node);
        const modifiers = [...keywords, ...annotations];

        let visibility: 'public' | 'private' | 'protected' | 'internal' = 'internal';
        if (keywords.includes('public')) visibility = 'public';
        else if (keywords.includes('private')) visibility = 'private';
        else if (keywords.includes('protected')) visibility = 'protected';

        return { modifiers, visibility };
    }
}
