import Parser = require('node-tree-sitter');
import { decoratorNames } from '../astHelpers';

export class ModifierMapper {
    /**
     * Python has no `public`/`private`/`protected` keywords -- visibility is
     * convention-inferred (leading underscore = private-by-convention, double
     * leading underscore = name-mangled), not enforced by the language. This is
     * disclosed here rather than silently presented as equivalent to TypeScript's
     * real access-modifier keywords.
     */
    public map(node: Parser.SyntaxNode, name: string): { modifiers: string[]; visibility: 'public' | 'private' | 'protected' | 'internal' } {
        const decorators = decoratorNames(node);
        const modifiers = [...decorators];

        // tree-sitter-python parses `async def` as a plain function_definition
        // with a leading anonymous `async` child, not a distinct node type.
        if (node.child(0)?.type === 'async') {
            modifiers.push('async');
        }
        if (decorators.includes('staticmethod')) {
            modifiers.push('static');
        }
        if (decorators.includes('classmethod')) {
            modifiers.push('classmethod');
        }

        let visibility: 'public' | 'private' | 'protected' | 'internal' = 'public';
        if (name.startsWith('__') && !name.endsWith('__')) {
            visibility = 'private'; // name-mangled
        } else if (name.startsWith('_')) {
            visibility = 'protected'; // conventional "internal use" marker
        }

        return { modifiers, visibility };
    }
}
