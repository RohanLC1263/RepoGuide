import * as crypto from 'crypto';
import Parser = require('node-tree-sitter');

export interface RustParamInfo {
    name: string;
    typeText: string;
}

/**
 * Syntactic-only signature hash (no type checker to resolve/normalize
 * types) -- matches every previous provider's tier. `self`/`&self`/
 * `&mut self` is excluded from the hashed parameter list, the same
 * self/cls exclusion Python and Java apply.
 */
export class RustSignatureHasher {
    public static hash(params: RustParamInfo[], returnTypeText: string): string {
        const paramPart = params.map(p => `${p.name}:${p.typeText}`).join(',');
        const canonical = `return:${returnTypeText}|params:${paramPart}`;
        const digest = crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
        return `v1|${digest}`;
    }

    public static extractParams(parametersNode: Parser.SyntaxNode): RustParamInfo[] {
        const params: RustParamInfo[] = [];
        for (const child of parametersNode.namedChildren) {
            if (child.type !== 'parameter') {
                continue; // self_parameter excluded, same as self/cls in Python/Java
            }
            const name = child.childForFieldName('pattern')?.text;
            const type = child.childForFieldName('type')?.text;
            if (name && type) {
                params.push({ name, typeText: type });
            }
        }
        return params;
    }
}
