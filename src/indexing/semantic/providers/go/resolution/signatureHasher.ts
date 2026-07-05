import * as crypto from 'crypto';
import Parser = require('node-tree-sitter');

export interface GoParamInfo {
    name: string;
    typeText: string;
}

/**
 * Syntactic-only signature hash (no type checker to resolve/normalize
 * types) -- matches every previous provider's tier. Disclosed limitation:
 * a named import alias vs. the real package name in a type reference would
 * hash differently since there's no type resolution to normalize them.
 */
export class GoSignatureHasher {
    public static hash(params: GoParamInfo[], resultText: string): string {
        const paramPart = params.map(p => `${p.name}:${p.typeText}`).join(',');
        const canonical = `result:${resultText}|params:${paramPart}`;
        const digest = crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
        return `v1|${digest}`;
    }

    public static extractParams(parametersNode: Parser.SyntaxNode): GoParamInfo[] {
        const params: GoParamInfo[] = [];
        for (const child of parametersNode.namedChildren) {
            if (child.type === 'parameter_declaration') {
                // `func F(a, b int)` is ONE parameter_declaration with multiple
                // leading `identifier` names sharing the trailing type node --
                // childForFieldName('name') only returns the first one, silently
                // dropping the rest, so this takes every identifier except the
                // last namedChild (the type) instead.
                const names = child.namedChildren.slice(0, -1).filter(c => c.type === 'identifier');
                const typeNode = child.namedChildren[child.namedChildren.length - 1];
                if (typeNode) {
                    for (const nameNode of names) {
                        params.push({ name: nameNode.text, typeText: typeNode.text });
                    }
                }
            } else if (child.type === 'variadic_parameter_declaration') {
                const name = child.childForFieldName('name')?.text;
                const type = child.childForFieldName('type')?.text;
                if (name && type) {
                    params.push({ name, typeText: `...${type}` });
                }
            }
        }
        return params;
    }
}
