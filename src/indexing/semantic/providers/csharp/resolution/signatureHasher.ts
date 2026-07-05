import * as crypto from 'crypto';
import Parser = require('node-tree-sitter');

export interface CSharpParamInfo {
    name: string;
    typeText: string;
}

/**
 * Syntactic-only signature hash (no type checker to resolve/normalize
 * types) -- matches Java's and Python's signatureHasher tier. Disclosed
 * limitation: `System.String` vs a `using`-imported bare `string` hash
 * differently since there's no type resolution to normalize them. Two
 * overloads of the same method/constructor name get distinct hashes
 * because each has its own real parameter list, keeping their
 * CanonicalSymbolIdentity distinct -- verified directly in
 * csharpSemanticProvider.test.ts, the same way Java's was.
 */
export class CSharpSignatureHasher {
    public static hash(params: CSharpParamInfo[], returnTypeText: string, isStatic: boolean): string {
        const paramPart = params.map(p => `${p.name}:${p.typeText}`).join(',');
        const canonical = `static:${isStatic}|return:${returnTypeText}|params:${paramPart}`;
        const digest = crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
        return `v1|${digest}`;
    }

    public static extractParams(parametersNode: Parser.SyntaxNode): CSharpParamInfo[] {
        const params: CSharpParamInfo[] = [];
        for (const child of parametersNode.namedChildren) {
            if (child.type !== 'parameter') {
                continue;
            }
            const name = child.childForFieldName('name')?.text;
            const type = child.childForFieldName('type')?.text;
            if (name && type) {
                params.push({ name, typeText: type });
            }
        }
        return params;
    }
}
