import * as crypto from 'crypto';
import Parser = require('node-tree-sitter');

export interface PythonParamInfo {
    name: string;
    rawTypeHint: string;
    hasDefault: boolean;
    kind: 'positional' | 'vararg' | 'kwarg';
}

/**
 * Hashes the *syntactic* signature of a Python function/method -- parameter
 * names, raw type-hint text as written, defaults, binding kind, and decorators
 * -- since there is no type checker available to resolve/normalize types the
 * way TypeScript's SignatureHasher does. Kept in the same `v1|<16 hex chars>`
 * shape as the TypeScript provider's own SignatureHasher for consistency
 * across providers, rather than reusing canonicalSymbolIdentityUtils.ts's
 * computeSignatureHash() (8 chars, no version prefix) directly.
 *
 * Disclosed limitation: `List[int]` vs `list[int]` vs a type alias that means
 * the same thing hash differently, since nothing here resolves type meaning --
 * only syntax. This is an accepted trade-off of having no embeddable Python
 * type-checker, not an oversight.
 */
export class PythonSignatureHasher {
    public static hash(params: PythonParamInfo[], returnTypeHint: string, binding: 'instance' | 'static' | 'classmethod', decorators: string[]): string {
        const paramStr = params.map(p => `${p.name}:${p.rawTypeHint}:${p.hasDefault ? '1' : '0'}:${p.kind}`).join(',');
        const decoratorStr = [...decorators].sort().join(',');
        const normalized = `binding:${binding}|decorators:${decoratorStr}|params:${paramStr}|return:${returnTypeHint}`;
        const digest = crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
        return `v1|${digest}`;
    }

    /** Extracts PythonParamInfo[] from a `parameters` node, excluding self/cls. */
    public static extractParams(parametersNode: Parser.SyntaxNode): PythonParamInfo[] {
        const params: PythonParamInfo[] = [];
        for (const child of parametersNode.namedChildren) {
            const info = this.extractOneParam(child);
            if (info && info.name !== 'self' && info.name !== 'cls') {
                params.push(info);
            }
        }
        return params;
    }

    private static extractOneParam(node: Parser.SyntaxNode): PythonParamInfo | null {
        switch (node.type) {
            case 'identifier':
                return { name: node.text, rawTypeHint: '', hasDefault: false, kind: 'positional' };
            case 'typed_parameter': {
                const name = node.namedChildren.find(c => c.type === 'identifier')?.text ?? '';
                const type = node.childForFieldName('type')?.text ?? '';
                return { name, rawTypeHint: type, hasDefault: false, kind: 'positional' };
            }
            case 'default_parameter': {
                const name = node.childForFieldName('name')?.text
                    ?? node.namedChildren.find(c => c.type === 'identifier')?.text ?? '';
                return { name, rawTypeHint: '', hasDefault: true, kind: 'positional' };
            }
            case 'typed_default_parameter': {
                const name = node.childForFieldName('name')?.text
                    ?? node.namedChildren.find(c => c.type === 'identifier')?.text ?? '';
                const type = node.childForFieldName('type')?.text ?? '';
                return { name, rawTypeHint: type, hasDefault: true, kind: 'positional' };
            }
            case 'list_splat_pattern': {
                const name = node.namedChildren.find(c => c.type === 'identifier')?.text ?? '';
                return { name, rawTypeHint: '', hasDefault: false, kind: 'vararg' };
            }
            case 'dictionary_splat_pattern': {
                const name = node.namedChildren.find(c => c.type === 'identifier')?.text ?? '';
                return { name, rawTypeHint: '', hasDefault: false, kind: 'kwarg' };
            }
            default:
                return null; // e.g. bare '*' or '/' separators -- not a real parameter
        }
    }
}
